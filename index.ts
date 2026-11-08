/**
 * pi-status-plus — full custom Pi status bar (footer) with selectable layouts
 * and token-speed statistics.
 *
 * Why: pi's stock footer is fixed and pi-token-speed can only append a
 * setStatus line. This extension replaces the footer component itself
 * (ctx.ui.setFooter), so every line is under our control.
 *
 * Layouts (/status-plus layout <name>):
 *   one-line    — "↑…, ↓…, R…, CH…%, 106.4k/260.0k, 40.9%, auto • ⚡ TG xx t/s • PP yy t/s • TTFT zz s • model.gguf • xhigh • folder"
 *                 (single line, right-aligned tail, no MCP info)
 *   two-line-a  — line 1: one-line content minus folder (folder+MCP on line 2)
 *                 line 2: "folder • 🔌 MCP: N servers enabled (M disabled)"
 *   two-line-b  — line 1: stock-style stats + model • thinking right-aligned
 *                 line 2: "⚡ speeds • 🔌 MCP: … • folder"
 *   status-line — stock footer untouched + one plain setStatus line
 *   stock       — the stock pi footer, untouched (extension idles; any other
 *                 layout re-installs the custom footer live, no /reload needed)
 *
 * Speeds use one time base: generation (first token to end), which is what
 * llama-server's own "eval rate" means. TG "window" is the average over the last
 * tgWindowMs while the engine writes; TG "final" is output tokens over the whole
 * generation, and it matches the "N tok in S s" pair exactly. See engine.ts.
 *
 * The MCP segment is read from the extension status line that pi-mcp-adapter
 * publishes under the key "mcp" — the same text the stock footer shows, so
 * nothing is duplicated and no MCP servers are queried.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ModelSelectEvent,
	type ReadonlyFooterDataProvider,
	type SessionStartEvent,
	type ToolExecutionStartEvent,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import { SpeedEngine } from "./engine.js";
import { EngineProbe, preferFrozen, type EngineRequestNumbers } from "./engines.js";
import {
	assembleLine,
	BOLT,
	buildRightPart,
	buildSpeedSegment,
	buildStatsParts,
	buildStockLine1,
	formatTokens,
	joinBullet,
	modelFileName,
	statsPartsPlain,
} from "./footer.js";
import {
	DEFAULTS,
	ENUM_CHOICES,
	ENUM_FIELDS,
	loadSettings,
	saveSettings,
	type BoolKey,
	type EnumField,
	type StatusPlusSettings,
} from "./settings.js";
import type { FooterFrameData, SpeedSnapshot, StatsParts, UsageStats } from "./types.js";

const STATUS_KEY = "status-plus";
const MIN_WIDTH = 20;
const LINE_FALLBACK_WIDTH = 200;
const TOKEN_GEN_TOOLS = new Set(["edit", "write"]);

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const engine = new SpeedEngine();
/** Reads speeds from the local engine (basalt / strata / llama.cpp …) when reachable. */
const probe = new EngineProbe();
let settings: StatusPlusSettings = { ...DEFAULTS };
let footerDataRef: ReadonlyFooterDataProvider | undefined;
let activeCtx: ExtensionContext | undefined;
let footerInstalled = false;
let autoCompactEnabled = true;
;/** Last non-zero window TG, kept only for the tgMode "window" decay case. */
let lastSpeeds = { tg: 0, pp: 0 };

// ---------------------------------------------------------------------------
// Usage stats (recomputed per render, mirrors the stock footer's math)
// ---------------------------------------------------------------------------

function emptyStats(contextWindow: number): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		cacheHitRate: undefined,
		contextTokens: null,
		contextWindow,
		autoCompact: autoCompactEnabled,
	};
}

interface EntryUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

function addUsage(stats: UsageStats, usage: EntryUsage | undefined): void {
	if (!usage) return;
	stats.input += usage.input ?? 0;
	stats.output += usage.output ?? 0;
	stats.cacheRead += usage.cacheRead ?? 0;
	stats.cacheWrite += usage.cacheWrite ?? 0;
	stats.cost += usage.cost?.total ?? 0;
}

function computeStats(ctx: ExtensionContext): UsageStats {
	const stats = emptyStats(ctx.model?.contextWindow ?? 0);
	stats.autoCompact = autoCompactEnabled;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "usage") {
			addUsage(stats, (entry as { usage?: EntryUsage }).usage);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = (entry.message as { usage?: EntryUsage }).usage;
			addUsage(stats, usage);
			if (usage) {
				const input = usage.input ?? 0;
				const cacheRead = usage.cacheRead ?? 0;
				const promptTokens = input + cacheRead + (usage.cacheWrite ?? 0);
				if (promptTokens > 0) {
					stats.cacheHitRate = (cacheRead / promptTokens) * 100;
				}
			}
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			addUsage(stats, (entry.message as { usage?: EntryUsage }).usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && "usage" in entry) {
			addUsage(stats, (entry as { usage?: EntryUsage }).usage);
		}
	}
	// What the SERVER holds: the last real usage report after the newest compaction. This is the
	// context that actually occupies the window; with pi-compact-plus eliding old tool results it is
	// well below pi's raw-transcript estimate below, and it is the number the window limit applies to.
	try {
		const branch: any[] = ctx.sessionManager?.getBranch?.() ?? [];
		let latestCompaction = -1;
		for (let i = 0; i < branch.length; i++) if (branch[i]?.type === "compaction") latestCompaction = i;
		for (let i = branch.length - 1; i > latestCompaction; i--) {
			const m: any = branch[i]?.role === undefined ? branch[i]?.message : branch[i];
			const u: any = m?.usage;
			if (!u) continue;
			const total = Number(u.totalTokens) > 0 ? Number(u.totalTokens) : [u.input, u.output, u.cacheRead, u.cacheWrite].reduce((acc: number, v: any) => acc + (Number(v) || 0), 0);
			if (total > 0) { stats.realContextTokens = total; break; }
		}
	} catch {
		/* no usage yet - the estimate below stands in */
	}
	// Pi's own context estimate (handles compaction + trailing messages).
	const used = ctx.getContextUsage?.();
	stats.contextTokens = used?.tokens ?? null;
	if (used?.contextWindow) stats.contextWindow = used.contextWindow;
	// A local server TRUNCATES over-window prompts, so the provider-reported usage is the
	// truncated size, masking the session's real content (2026-10-04: 140k shown, ~375k real).
	// Take the max of pi's number and the chars/4 estimate of the projected messages.
	let projected = 0;
	try {
		const projection = ctx.sessionManager?.buildSessionProjection?.();
		for (const entry of projection?.entries ?? []) {
			for (const message of entry.messages ?? []) {
				// Not every agent message carries text the same way (a bash execution
				// message has no plain content), so read it defensively: this is only a
				// character count feeding a token estimate.
				const content = (message as { content?: unknown }).content;
				const chars = typeof content === "string"
					? content.length
					: Array.isArray(content)
						? content.reduce((acc: number, b: any) => acc + (typeof b?.text === "string" ? b.text.length : typeof b?.thinking === "string" ? b.thinking.length : typeof b?.arguments === "object" ? JSON.stringify(b.arguments ?? {}).length : 0), 0)
						: 0;
				projected += chars;
			}
		}
	} catch {
		/* the estimate is best-effort */
	}
	const projectedTokens = Math.ceil(projected / 4);
	if (projectedTokens > (stats.contextTokens ?? 0)) stats.contextTokens = projectedTokens;
	return stats;
}

// ---------------------------------------------------------------------------
// Speed snapshot for the renderer
// ---------------------------------------------------------------------------

function measuredSnapshot(): SpeedSnapshot {
	// After the stream ends the engine's values are stable and authoritative
	// (usage reconciled, end time fixed), so always recompute — never reuse a
	// stale mid-stream snapshot. Only the pure window TG (tgMode "window" with
	// alignModes off) decays as events age out; keep its last measured value
	// in that one case so the segment does not drop to zero on the bar.
	const tg = engine.tgDisplayed(settings.tgWindowMs, settings.tgMode, settings.alignModes);
	const pair = engine.statsPair(settings.tokenSource);
	const snap: SpeedSnapshot = {
		tg,
		pp: engine.ppSpeed(),
		ttft: engine.ttftMs() / 1000,
		statsTokens: pair.tokens,
		statsSeconds: pair.seconds,
		streaming: engine.isStreaming,
		// White while the decode loop is running here; before the first token there
		// is no decode and the engine is reading the prompt, so PP is the live one.
		tgLive: engine.isStreaming,
		ppLive: engine.isStreaming && engine.ttftMs() === 0,
		// pi is told nothing about how far a prompt has been read; only the engine
		// can say, so the measured path shows no progress.
		prefillDone: 0,
		prefillTotal: 0,
		source: "measured",
		engineName: "",
	};
	if (!snap.streaming && tg <= 0 && lastSpeeds.tg > 0 && settings.tgMode === "window" && settings.alignModes === "off") {
		snap.tg = lastSpeeds.tg;
	} else if (snap.streaming && tg > 0) {
		lastSpeeds.tg = tg;
	}
	return snap;
}

/**
 * Keep both rates on the bar.
 *
 * A rate that has stopped keeps the average it left behind, and the live flag on
 * it tells the renderer to show it dim; a rate that is happening is shown in
 * white. Only a rate that has never been measured at all is missing - the bar
 * never prints a zero placeholder.
 */
function keepRates(s: SpeedSnapshot): SpeedSnapshot {
	if (s.tg > 0) lastSpeeds.tg = s.tg;
	else if (lastSpeeds.tg > 0) s.tg = lastSpeeds.tg;
	if (s.pp > 0) lastSpeeds.pp = s.pp;
	else if (lastSpeeds.pp > 0) s.pp = lastSpeeds.pp;
	return s;
}

/**
 * The numbers for the speed segment.
 *
 * speedSource "engine" prefers what the engine itself measured, because that is
 * the figure the engine's own console prints. Chunk arrival at pi's side is a
 * lagging, batched copy of it, and with speculative decoding the engine counts
 * accepted draft tokens that never arrive as separate chunks - which is why the
 * old always-measured number kept disagreeing with the server.
 *
 * Order of preference:
 *   1. the engine's live rates, whenever it reports itself busy - with ours or
 *      with anything else's request (compaction, summary, another client)
 *   2. the finished request, in the engine's own seconds
 *   3. our own measurement of pi's stream, when the engine cannot be read
 * /status-plus engine says which one is in use; showSpeedSource puts the word on
 * the bar for those who want it there.
 */
function engineSnapshot(): SpeedSnapshot {
	const measured = measuredSnapshot();
	if (settings.speedSource !== "engine" || settings.engineUrl === "") return keepRates(measured);
	// tgWindowMs applies to the engine's numbers too: an engine's instantaneous
	// rate is not an average, and the setting promises an average.
	const view = probe.view(settings.tgWindowMs);

	// 1. whatever the engine is doing right now - our message, an autocompaction,
	// a session summary, or a completely different client on the same port. Its
	// live rates are the truth of this moment, so they beat anything measured or
	// frozen earlier, and they are shown even when no request of ours is in
	// flight - which is what "nothing shows during compaction" used to mean.
	// A prompt still being read has a PP and no TG yet; the bar shows the PP.
	const hasLiveRates = view.liveTg > 0 || view.livePp > 0;
	// ... unless this activity is the very request we already timed and froze: for
	// a poll or two after a response ends the engine still calls itself busy, and
	// then the finished response's own average is the better number to show.
	const fin = view.final;
	const frozeThisActivity = preferFrozen(fin, measured.streaming, view.busySince, Date.now());
	if (view.busy && hasLiveRates && !frozeThisActivity) {
		const ours = measured.streaming; // pi's own message is the one in flight
		// A rate that is not happening this second shows the engine's own
		// start-to-end average of the last request (dim), never a trailing window
		// average: the seconds after a prefill ended have nothing to do with that
		// prefill, so averaging across them would print a wrong number.
		const finished = fin && fin.tg > 0 ? fin : null;
		return keepRates({
			tg: view.liveTg > 0 ? view.liveTg : (finished ? finished.tg : 0),
			pp: view.livePp > 0 ? view.livePp : (finished && finished.pp > 0 ? finished.pp : ours ? measured.pp : 0),
			// The token/time pair and TTFT describe pi's message. When the engine is
			// busy with something of its own, showing last message's pair next to
			// these rates would be a lie, so only the rates go on the bar.
			ttft: ours ? measured.ttft : 0,
			statsTokens: ours ? measured.statsTokens : 0,
			statsSeconds: ours ? measured.statsSeconds : 0,
			streaming: ours,
			// Which of the two is happening this second decides the colour: an engine
			// keeps reporting its prefill mean during decode, so the value alone
			// cannot say whether the prompt is still being read.
			tgLive: view.liveTg > 0,
			ppLive: view.prefilling && view.livePp > 0,
			prefillDone: view.prefillDone,
			prefillTotal: view.prefillTotal,
			source: "engine",
			engineName: view.name,
		});
	}

	// 2. the request that just finished, in the engine's own seconds
	if (fin && fin.tg > 0 && !measured.streaming) {
		return keepRates({
			tg: fin.tg,
			pp: fin.pp > 0 ? fin.pp : measured.pp,
			ttft: fin.ttftS > 0 ? fin.ttftS : measured.ttft,
			statsTokens: fin.out > 0 ? fin.out : measured.statsTokens,
			statsSeconds: fin.genSeconds > 0 ? fin.genSeconds : measured.statsSeconds,
			streaming: false,
			// Both activities are over: the two averages stay on the bar, dim.
			tgLive: false,
			ppLive: false,
			prefillDone: view.prefillDone,
			prefillTotal: view.prefillTotal,
			source: "engine",
			engineName: view.name,
		});
	}

	// 3. nothing to read (engine down, no --metrics, wrong port): say so, do not hide it
	return keepRates({
		...measured,
		engineName: view.reachable ? view.name : "",
		prefillDone: view.prefillDone,
		prefillTotal: view.prefillTotal,
	});
}

/** One-line answer to "what is the engine reader seeing right now?". */
function engineReadout(): string {
	const v = probe.view(settings.tgWindowMs);
	const parts: string[] = [];
	parts.push(`url=${v.url || "(off)"}`);
	parts.push(v.reachable ? `engine=${v.name} [${v.kind}]` : `engine unreachable (${v.note || "no answer"})`);
	// Diagnostics first: "the bar is not moving" is usually one of these three, and
	// during a compaction this line is what tells us which - run it while the
	// summary is being written and the answer is on screen.
	parts.push(
		v.watching
			? `reading the engine, last busy ${v.lastBusyMs === 0 ? "never" : `${Math.max(0, Math.round((Date.now() - v.lastBusyMs) / 1000))} s ago`}`
			: "NOT polling the engine (turn speedSource on / check engineUrl)",
	);
	if (v.state) parts.push(`engine says: ${v.state}`);
	if (v.prefillTotal > 0) {
		const done = Math.min(v.prefillDone, v.prefillTotal);
		parts.push(`prompt read ${formatTokens(done)}/${formatTokens(v.prefillTotal)}, ${((done / v.prefillTotal) * 100).toFixed(1)}%`);
	}
	if (v.busy) {
		const basis =
			settings.tgWindowMs >= 250
				? `TG ${v.liveTg.toFixed(1)} PP ${v.livePp.toFixed(1)} t/s, averaged over ${(settings.tgWindowMs / 1000).toFixed(1)} s (instant ${v.liveTgRaw.toFixed(1)})`
				: `TG ${v.liveTgRaw.toFixed(1)} PP ${v.livePpRaw.toFixed(1)} t/s, instant (tgWindowMs below 250 ms)`;
		parts.push(`busy: ${basis}`);
	} else {
		parts.push("idle");
	}
	const f = v.final;
	if (f) {
		parts.push(
			`last ${f.id || "request"}: ${f.tg.toFixed(1)} t/s, ${f.out} tok in ${f.genSeconds.toFixed(1)} s` +
				(f.pp > 0 ? `, PP ${f.pp.toFixed(1)}` : "") +
				(f.ttftS > 0 ? `, TTFT ${f.ttftS.toFixed(2)} s` : ""),
		);
	} else {
		parts.push("no finished request attributed yet");
	}
	parts.push(`bar shows ${settings.speedSource === "engine" ? "engine" : "measured"} speeds`);
	return `pi-status-plus engine: ${parts.join(" | ")}`;
}

// ---------------------------------------------------------------------------
// Footer frame
// ---------------------------------------------------------------------------

/**
 * Display refresh throttle. Rendering itself happens on every pi frame, but
 * the numbers feeding the bar are recomputed at most once per refreshMs, so
 * fast-changing values (live TG, TTFT, the tok-in-s pair) settle into a calm
 * half-second cadence instead of flickering with every delta. End-of-stream
 * updates (message_end, turn_end, agent_end) bypass the throttle so the
 * frozen authoritative values appear immediately.
 */
let displayCache: { at: number; stats: UsageStats; speed: SpeedSnapshot } | undefined;

function refreshDisplayCache(ctx: ExtensionContext): void {
	displayCache = { at: Date.now(), stats: computeStats(ctx), speed: engineSnapshot() };
}

function currentDisplayData(ctx: ExtensionContext, force: boolean): { stats: UsageStats; speed: SpeedSnapshot } {
	const now = Date.now();
	if (!force && displayCache && now - displayCache.at < settings.refreshMs) return displayCache;
	refreshDisplayCache(ctx);
	return displayCache!;
}

function buildFrame(ctx: ExtensionContext, width: number, theme: FooterFrameData["theme"], force = false): FooterFrameData {
	const data = currentDisplayData(ctx, force);
	return {
		ctx,
		theme,
		settings: settings as FooterFrameData["settings"],
		stats: data.stats,
		speed: data.speed,
		branch: footerDataRef?.getGitBranch() ?? null,
		mcpSegment: stripAnsi(footerDataRef?.getExtensionStatuses().get("mcp") ?? ""),
		width,
	};
}

/**
 * Put the speed segment after the stats.
 *
 * Each speed leads with its own bolt when showIcon is on, and a bullet in front of
 * that bolt is one separator too many - the icon already separates. Without a bolt
 * in front (icon off, or a segment that carries only the token pair) the bullet
 * stays, because then something has to divide the two groups.
 */
function withSpeed(stats: string, speed: string): string {
	if (speed.length === 0) return stats;
	if (stats.length === 0) return speed;
	return speed.trimStart().startsWith(BOLT) ? `${stats} ${speed}` : joinBullet([stats, speed]);
}

/** Strip ANSI colour escapes (the mcp segment arrives styled by its extension). */
function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\x07]*\x07/g, "");
}

/**
 * Join the stats pieces: before, context (colored), auto.
 * A bullet separates the token totals from the context figure, so the comma
 * inside the figure ("207.1k/458.8k, 45.1%") stays the only comma in that stretch.
 */
function composeStatsLine(theme: FooterFrameData["theme"], parts: StatsParts): string {
	const head = parts.before.length > 0 ? `${parts.before} • ` : "";
	const auto = parts.autoItem !== undefined ? `, ${parts.autoItem}` : "";
	return `${theme.fg("dim", head)}${parts.contextColored}${theme.fg("dim", auto)}`;
}

/** Join the stats pieces fully plain (no colors), for narrow fallbacks. */
function composeStatsLinePlain(parts: StatsParts): string {
	return statsPartsPlain(parts);
}

// ---------------------------------------------------------------------------
// Line builders per layout
// ---------------------------------------------------------------------------

function buildLines(ctx: ExtensionContext, width: number, theme: FooterFrameData["theme"], force = false): string[] {
	const safeWidth = Math.max(width, MIN_WIDTH);
	const data = buildFrame(ctx, safeWidth, theme, force);
	const s = settings;
	const lines: string[] = [];

	const parts = buildStatsParts(data);
	const speed = buildSpeedSegment(data);
	const modelId = ctx.model?.id ?? "no-model";
	const modelPart = s.modelDisplay === "filename" ? modelFileName(modelId) : modelId;
	const thinkingPart = ctx.model?.reasoning ? (ctx.thinkingLevel ?? "thinking off") : undefined;
	const folder = s.showCwd ? buildStockLine1(data) : undefined;
	const mcp = s.showMcp && data.mcpSegment.length > 0 ? data.mcpSegment : undefined;

	// --- status-line layout: single plain line, stock footer untouched -----
	if (s.layout === "status-line") {
		const stats = composeStatsLinePlain(parts);
		const items = joinBullet([
			withSpeed(stats, speed),
			modelPart,
			thinkingPart,
			folder,
			mcp,
		]);
		return [truncate(items, safeWidth)];
	}

	// --- one-line: everything on one line (no MCP) --------------------------
	if (s.layout === "one-line") {
		const left = withSpeed(composeStatsLine(theme, parts), speed);
		const right = joinBullet([modelPart, thinkingPart, folder]);
		lines.push(assembleLine(left, right, safeWidth));
		return lines;
	}

	// --- two-line-a: line 1 = stats • speed • model • thinking; line 2 = folder • MCP
	if (s.layout === "two-line-a") {
		const left = joinBullet([withSpeed(composeStatsLine(theme, parts), speed), modelPart, thinkingPart]);
		lines.push(assembleLine(left, "", safeWidth));
		const tail = joinBullet([folder, mcp]);
		if (tail.length > 0) lines.push(theme.fg("dim", truncate(tail, safeWidth)));
		return lines;
	}

	// --- two-line-b: line 1 = stats + right-aligned model • thinking; line 2 = ⚡ speeds • MCP • folder
	if (s.layout === "two-line-b") {
		const coloredLeft = composeStatsLine(theme, parts);
		const right = joinBullet([modelPart, thinkingPart]);
		lines.push(assembleLine(coloredLeft, right, safeWidth));
		const tail = joinBullet([speed || undefined, mcp, folder]);
		if (tail.length > 0) lines.push(theme.fg("dim", truncate(tail, safeWidth)));
		return lines;
	}

	// --- stock: the stock footer is installed instead; nothing to draw ------
	return lines;
}

function truncate(text: string, width: number): string {
	return truncateToWidth(text, width);
}

// ---------------------------------------------------------------------------
// Footer install
// ---------------------------------------------------------------------------

function installFooter(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || settings.layout === "stock") {
		return;
	}
	try {
		ctx.ui.setFooter((tui: TUI, theme: FooterFrameData["theme"], footerData: ReadonlyFooterDataProvider) => {
			footerDataRef = footerData;
			tuiRef = tui; // so the engine-activity ticker can ask for a frame
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const component: Component & { dispose?(): void } = {
				render(width: number): string[] {
					const current = activeCtx;
					if (!current) return [];
					return buildLines(current, width, theme);
				},
				invalidate(): void {
					/* stateless: everything is recomputed per render */
				},
			};
			component.dispose = () => {
				unsub();
				footerDataRef = undefined;
				tuiRef = undefined;
			};
			return component;
		});
		footerInstalled = true;
	} catch {
		footerInstalled = false;
	}
}

/**
 * Apply the current layout immediately: uninstall our footer (stock pi footer
 * returns) for "stock", install it for everything else. Called on session
 * start and after every layout change, so switching never needs /reload.
 */
function applyLayout(ctx: ExtensionContext): void {
	if (settings.layout === "stock") {
		try {
			if (footerInstalled || ctx.mode === "tui") ctx.ui.setFooter(undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* stale ctx — ignore */
		}
		footerInstalled = false;
		return;
	}
	if (!footerInstalled) installFooter(ctx);
	if (footerInstalled) {
		// The footer shows everything; drop our own status line to avoid duplication.
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* stale ctx — ignore */
		}
	}
}

// ---------------------------------------------------------------------------
// setStatus line (status-line layout, or fallback when no footer is possible)
// ---------------------------------------------------------------------------

function buildStatusLineText(ctx: ExtensionContext, force = false): string {
	const lines = buildLines(ctx, LINE_FALLBACK_WIDTH, ctx.ui.theme, force);
	return lines.join(" • ");
}

let lastStatusText: string | undefined;

function updateStatusLine(ctx: ExtensionContext, force = false): void {
	if (footerInstalled && settings.layout !== "status-line" && settings.hideStatusLine) return;
	try {
		const text = buildStatusLineText(ctx, force);
		if (text === lastStatusText && !force) return;
		lastStatusText = text.length > 0 ? text : undefined;
		ctx.ui.setStatus(STATUS_KEY, lastStatusText);
	} catch {
		/* stale ctx — ignore */
	}
}

// ---------------------------------------------------------------------------
// Repaint while the engine works
// ---------------------------------------------------------------------------

/** The TUI our footer is installed in, so we can ask it for a frame. */
let tuiRef: TUI | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;

/**
 * Ask for a frame whenever the engine is busy, even when pi itself is idle.
 *
 * pi redraws the footer on its own loop while a response streams here. But the
 * engine is also busy at moments when nothing streams here: a model still
 * loading, a session being read at startup, an autocompaction, a session-title
 * request, another client on the same port. Left to pi's loop, the numbers would
 * only move when something else happened to redraw - which is why PP appeared
 * only in flashes and nothing appeared during a compaction. While the engine
 * reports itself busy we ask for a frame once per refreshMs; while it is idle we
 * ask for none, so an idle pi burns nothing.
 */
function startTicker(): void {
	stopTicker();
	const every = Math.max(200, settings.refreshMs);
	ticker = setInterval(() => {
		// Keep the reader alive: whichever event sequence a session replacement or a
		// reload turns out to use, the watcher has to be running when the engine is
		// busy, and this is the one timer guaranteed to tick throughout.
		if (!probe.watching() && settings.speedSource === "engine" && settings.engineUrl !== "") {
			probe.configure(settings.engineUrl, settings.enginePollMs);
			probe.start();
		}
		if (!probe.view(0).busy) return;
		// The footer needs the TUI, not a session context: a compaction can leave the
		// session ctx temporarily unset while the engine works, and the bar must keep
		// moving through that.
		if (footerInstalled) tuiRef?.requestRender();
		else if (activeCtx) paint(activeCtx);
	}, every);
	// A timer must never be the reason a process stays alive.
	(ticker as unknown as { unref?: () => void }).unref?.();
}

function stopTicker(): void {
	if (ticker !== undefined) clearInterval(ticker);
	ticker = undefined;
}

/** Make sure both the reader and the repaint timer are alive (idempotent). */
function ensureWatching(): void {
	if (settings.speedSource !== "engine" || settings.engineUrl === "") return;
	if (!probe.watching()) {
		probe.configure(settings.engineUrl, settings.enginePollMs);
		probe.start();
	}
	if (ticker === undefined) startTicker();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		settings = loadSettings(getAgentDir());
		autoCompactEnabled = readAutoCompact(ctx);
		activeCtx = ctx;
		footerInstalled = false;
		// Start reading the engine's own speeds (harmless when nothing answers: the
		// probe backs off and the bar quietly falls back to measured numbers).
		probe.configure(settings.engineUrl, settings.enginePollMs);
		probe.start();
		startTicker();
		applyLayout(ctx);
		updateStatusLine(ctx, true);
	});

	pi.on("session_shutdown", () => {
		stopTicker();
		probe.stop();
		try {
			if (footerInstalled) activeCtx?.ui.setFooter(undefined);
			activeCtx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* stale ctx — ignore */
		}
		activeCtx = undefined;
		footerDataRef = undefined;
		footerInstalled = false;
		displayCache = undefined;
		lastStatusText = undefined;
	});

	// --- streaming ----------------------------------------------------------
	pi.on("message_start", (event: MessageStartEvent) => {
		if (event.message.role === "assistant") {
			const ts = (event.message as { timestamp?: number }).timestamp;
			const start = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
			engine.start(start);
			// Tell the engine reader a request went out: it needs the start time (and
			// the engine's counters at that moment) to attribute the right request.
			ensureWatching();
			probe.beginRequest(start);
		}
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		const ev = event.assistantMessageEvent;
		const type = ev.type;
		if (type === "text_start" || type === "thinking_start" || type === "toolcall_start") {
			engine.markFirst(Date.now());
			return;
		}
		if (type === "text_delta" || type === "thinking_delta") {
			engine.recordTokens(1, getUsageOutput(ev), settings.tokenSource === "provider");
			paint(ctx);
		} else if (type === "toolcall_delta" && settings.countToolCalls) {
			engine.recordTokens(1, getUsageOutput(ev), settings.tokenSource === "provider");
			paint(ctx);
		}
	});

	pi.on("message_end", (event: MessageEndEvent) => {
		if (event.message.role !== "assistant") return;
		const usage = (event.message as { usage?: EntryUsage }).usage;
		if (usage) engine.reconcile(usage.output ?? 0, usage.input ?? 0);
		engine.stop(Date.now());
		// The output count is the key the engine's request list is matched with.
		probe.endRequest(usage?.output ?? 0);
		// The authoritative end-of-stream values bypass the refresh throttle, so
		// the very next footer render already shows the frozen numbers.
		if (activeCtx) refreshDisplayCache(activeCtx);
	});

	// Pause while a non-generation tool executes (its tokens are prompt
	// processing on the server, irrelevant to TG) — same idea as the old
	// pi-token-speed pause.
	pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
		if (settings.pauseDuringTools && !TOKEN_GEN_TOOLS.has(event.toolName)) {
			engine.pause();
		}
	});

	// --- status line refresh points ----------------------------------------
	pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
		engine.stop(Date.now());
		refreshDisplayCache(ctx);
		updateStatusLine(ctx, true);
	});

	pi.on("agent_start", () => {
		// A turn beginning is a cheap, reliable moment to notice that the reader or
		// the repaint timer died somewhere in the session churn before this.
		ensureWatching();
	});

	pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
		refreshDisplayCache(ctx);
		updateStatusLine(ctx, true);
	});

	// --- command ------------------------------------------------------------
	pi.registerCommand("status-plus", {
		description: "Configure pi-status-plus (menu, or: status | <field> [value])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleCommand(args, ctx);
		},
	});
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

/** Find a setting field by case-insensitive name (accepts e.g. SHOWTTFT, showttft, showTtft). */
function findField(name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const key of BOOL_KEYS_LIST) if (key.toLowerCase() === lower) return key;
	for (const key of ENUM_FIELDS) if (key.toLowerCase() === lower) return key;
	if ("tgwindow" === lower) return "tgWindowMs";
	if ("refresh" === lower) return "refreshMs";
	if (lower === "engineurl" || lower === "engine_url") return "engineUrl";
	if (lower === "enginepoll" || lower === "enginepollms" || lower === "poll") return "enginePollMs";
	return undefined;
}

async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const words = args.trim().split(/\s+/).filter(Boolean);

	// No args → interactive menu (TUI only).
	if (words.length === 0) {
		if (ctx.mode === "tui") await runMenu(ctx);
		else ctx.ui.notify(settingsSummary(), "info");
		return;
	}

	const headRaw = words[0]!.toLowerCase();
	if (headRaw === "status") {
		ctx.ui.notify(settingsSummary(), "info");
		return;
	}
	if (headRaw === "menu") {
		if (ctx.mode === "tui") await runMenu(ctx);
		else ctx.ui.notify("the settings menu needs the interactive terminal (pi in TUI mode)", "info");
		return;
	}
	if (headRaw === "engine") {
		ctx.ui.notify(engineReadout(), "info");
		return;
	}

	const head = findField(words[0] ?? "");
	if (head === undefined) {
		ctx.ui.notify(`unknown field "${words[0]}" — try /status-plus (menu) or /status-plus status`, "warning");
		return;
	}

	// Boolean toggles.
	if ((BOOL_KEYS_LIST as readonly string[]).includes(head)) {
		const key = head as BoolKey;
		const wanted = words[1];
		settings[key] = wanted === undefined ? !settings[key] : !(wanted === "off" || wanted === "false" || wanted === "0");
		commit(ctx, `${key} → ${settings[key] ? "on" : "off"}`);
		return;
	}

	// Enum settings.
	if ((ENUM_FIELDS as readonly string[]).includes(head)) {
		const key = head as EnumField;
		if (words[1] === undefined) {
			ctx.ui.notify(`${key} = ${String(settings[key])} — values: ${ENUM_CHOICES[key]!.join(", ")}`, "info");
			return;
		}
		const wanted = words[1]!.toLowerCase();
		if (!ENUM_CHOICES[key]!.includes(wanted)) {
			ctx.ui.notify(`${key} must be one of ${ENUM_CHOICES[key]!.join(", ")}`, "warning");
			return;
		}
		setEnum(key, wanted);
		commit(ctx, `${key} → ${wanted}`);
		if (key === "layout") applyLayout(ctx);
		return;
	}

	// tgWindowMs.
	if (head === "tgWindowMs") {
		const value = Number(words[1]);
		if (words[1] === undefined || !Number.isFinite(value) || value < 100 || value > 60000) {
			ctx.ui.notify(`tgwindow needs a number from 100 to 60000 ms (now ${settings.tgWindowMs})`, "warning");
			return;
		}
		settings.tgWindowMs = Math.round(value);
		commit(ctx, `tgWindowMs → ${settings.tgWindowMs}`);
		return;
	}

	// refreshMs.
	if (head === "refreshMs") {
		const value = Number(words[1]);
		if (words[1] === undefined || !Number.isFinite(value) || value < 100 || value > 10000) {
			ctx.ui.notify(`refresh needs a number from 100 to 10000 ms (now ${settings.refreshMs})`, "warning");
			return;
		}
		settings.refreshMs = Math.round(value);
		commit(ctx, `refreshMs → ${settings.refreshMs}`);
		return;
	}

	// engineUrl: where to read the engine's own speeds from ("off" stops reading one).
	if (head === "engineUrl") {
		const wanted = (words[1] ?? "").trim();
		if (wanted === "") {
			ctx.ui.notify(`engineUrl = ${settings.engineUrl || "(off)"} — e.g. /status-plus engineUrl http://127.0.0.1:9931 (or "off")`, "info");
			return;
		}
		settings.engineUrl = wanted === "off" ? "" : wanted.replace(/\/+$/, "");
		commit(ctx, `engineUrl → ${settings.engineUrl || "off"}`);
		return;
	}

	// enginePollMs.
	if (head === "enginePollMs") {
		const value = Number(words[1]);
		if (words[1] === undefined || !Number.isFinite(value) || value < 100 || value > 5000) {
			ctx.ui.notify(`enginepoll needs a number from 100 to 5000 ms (now ${settings.enginePollMs})`, "warning");
			return;
		}
		settings.enginePollMs = Math.round(value);
		commit(ctx, `enginePollMs → ${settings.enginePollMs}`);
		return;
	}

	ctx.ui.notify(`unknown field "${words[0]}" — try /status-plus (menu) or /status-plus status`, "warning");
}

const BOOL_KEYS_LIST: readonly BoolKey[] = [
	"showStats",
	"showTtft",
	"showPp",
	"showCacheHit",
	"showPpTokens",
	"showAuto",
	"showCwd",
	"showMcp",
	"showIcon",
	"showSpeedLabels",
	"hideStatusLine",
	"countToolCalls",
	"pauseDuringTools",
	"showSpeedSource",
];

function setEnum(key: EnumField, value: string): void {
	(settings as unknown as Record<string, string>)[key] = value;
}

function commit(ctx: ExtensionCommandContext, message: string): void {
	// Settings may have moved the engine endpoint or the refresh cadence.
	probe.configure(settings.engineUrl, settings.enginePollMs);
	startTicker();
	try {
		saveSettings(getAgentDir(), settings);
		ctx.ui.notify(`${message} · saved`, "info");
	} catch (error) {
		ctx.ui.notify(`could not write pi-status-plus.json: ${(error as Error).message}`, "error");
	}
}

function settingsSummary(): string {
	const s = settings;
	const parts: string[] = [];
	for (const key of ENUM_FIELDS) parts.push(`${key}=${String(s[key])}`);
	for (const key of BOOL_KEYS_LIST) parts.push(`${key}=${s[key] ? "on" : "off"}`);
	parts.push(`tgWindowMs=${s.tgWindowMs}`);
	parts.push(`refreshMs=${s.refreshMs}`);
	parts.push(`engineUrl=${s.engineUrl || "(off)"}`);
	parts.push(`enginePollMs=${s.enginePollMs}`);
	return `pi-status-plus: ${parts.join(", ")}`;
}

/** Interactive picker: one entry per setting, current value in the label. */
async function runMenu(ctx: ExtensionCommandContext): Promise<void> {
	const fields: { key: string; label: string }[] = [
		...ENUM_FIELDS.map((key: EnumField) => ({ key, label: key })),
		{ key: "tgWindowMs", label: "tgWindowMs" },
		{ key: "refreshMs", label: "refreshMs" },
		{ key: "engineUrl", label: "engineUrl" },
		{ key: "enginePollMs", label: "enginePollMs" },
		...BOOL_KEYS_LIST.map((key: BoolKey) => ({ key, label: key })),
	];

	for (;;) {
		const current = settings as unknown as Record<string, unknown>;
		const labels = fields.map(({ key, label }) => {
			const value = current[key];
			return `${label}: ${typeof value === "boolean" ? (value ? "on" : "off") : String(value)}`;
		});
		// No "done" entry: every change is written to disk the moment it is made, so
		// there is nothing to confirm. Escape (or Ctrl+C) closes the menu.
		const choice = await ctx.ui.select("pi-status-plus — change a setting", labels);
		if (choice === undefined) return;
		const index = labels.indexOf(choice);
		if (index < 0) return;
		const field = fields[index]!;
		const key = field.key;

		if ((BOOL_KEYS_LIST as readonly string[]).includes(key)) {
			const boolKey = key as BoolKey;
			settings[boolKey] = !settings[boolKey];
			commit(ctx, `${boolKey} → ${settings[boolKey] ? "on" : "off"}`);
			continue;
		}
		if (key === "tgWindowMs") {
			const text = await ctx.ui.input("tgWindowMs (100-60000 ms)", String(settings.tgWindowMs));
			if (text === undefined) continue;
			const value = Number(text.trim());
			if (!Number.isFinite(value) || value < 100 || value > 60000) {
				ctx.ui.notify("needs a number from 100 to 60000", "warning");
				continue;
			}
			settings.tgWindowMs = Math.round(value);
			commit(ctx, `tgWindowMs → ${settings.tgWindowMs}`);
			continue;
		}
		if (key === "refreshMs") {
			const text = await ctx.ui.input("refreshMs (100-10000 ms)", String(settings.refreshMs));
			if (text === undefined) continue;
			const value = Number(text.trim());
			if (!Number.isFinite(value) || value < 100 || value > 10000) {
				ctx.ui.notify("needs a number from 100 to 10000", "warning");
				continue;
			}
			settings.refreshMs = Math.round(value);
			commit(ctx, `refreshMs → ${settings.refreshMs}`);
			continue;
		}
		if (key === "engineUrl") {
			const text = await ctx.ui.input("engineUrl to read engine speeds from (http://127.0.0.1:9931, or empty for none)", settings.engineUrl);
			if (text === undefined) continue;
			const wanted = text.trim();
			if (wanted !== "" && !/^https?:\/\//i.test(wanted)) {
				ctx.ui.notify("engineUrl must start with http:// or https:// (empty turns it off)", "warning");
				continue;
			}
			settings.engineUrl = wanted.replace(/\/+$/, "");
			commit(ctx, `engineUrl → ${settings.engineUrl || "off"}`);
			continue;
		}
		if (key === "enginePollMs") {
			const text = await ctx.ui.input("enginePollMs (100-5000 ms)", String(settings.enginePollMs));
			if (text === undefined) continue;
			const value = Number(text.trim());
			if (!Number.isFinite(value) || value < 100 || value > 5000) {
				ctx.ui.notify("needs a number from 100 to 5000", "warning");
				continue;
			}
			settings.enginePollMs = Math.round(value);
			commit(ctx, `enginePollMs → ${settings.enginePollMs}`);
			continue;
		}
		if ((ENUM_FIELDS as readonly string[]).includes(key)) {
			const enumKey = key as EnumField;
			const picked = await ctx.ui.select(field.label, [...ENUM_CHOICES[enumKey]!]);
			if (picked !== undefined) {
				setEnum(enumKey, picked);
				commit(ctx, `${enumKey} → ${picked}`);
				if (enumKey === "layout") applyLayout(ctx);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function paint(ctx: ExtensionContext): void {
	// With the custom footer installed, pi re-renders it on its own loop; the
	// setStatus line needs explicit updates. Both are throttled by the shared
	// display cache, so the bar never updates faster than refreshMs.
	if (!footerInstalled || settings.layout === "status-line") {
		updateStatusLine(ctx);
	}
}

function getUsageOutput(ev: { partial?: { usage?: { output?: number } } }): number | undefined {
	return ev.partial?.usage?.output;
}

function readAutoCompact(ctx: ExtensionContext): boolean {
	// The extension sessionManager is a ReadonlySessionManager (no compaction
	// getter), so read the same settings value AgentSession.autoCompactionEnabled
	// uses: settings.compaction.enabled (default true).
	try {
		const raw = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as {
			compaction?: { enabled?: boolean };
		};
		return raw.compaction?.enabled ?? true;
	} catch {
		return true;
	}
}

// Re-export for the smoke test.
export { formatTokens, modelFileName };
