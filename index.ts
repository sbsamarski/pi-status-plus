/**
 * pi-status-plus — full custom Pi status bar (footer) with selectable layouts
 * and token-speed statistics.
 *
 * Why: pi's stock footer is fixed and pi-token-speed can only append a
 * setStatus line. This extension replaces the footer component itself
 * (ctx.ui.setFooter), so every line is under our control.
 *
 * Layouts (/status-plus layout <name>):
 *   one-line    — "↑…, ↓…, R…, CH…%, 70.3k/90k (78.1%, auto), 402 tok in 8.4 s ⚡ TG xx t/s • PP yy t/s • TTFT zz s • model.gguf • xhigh • folder"
 *                 (single line, right-aligned tail, no MCP info)
 *   two-line-a  — line 1: one-line content minus folder (folder+MCP on line 2)
 *                 line 2: "folder • 🔌 MCP: N servers enabled (M disabled)"
 *   two-line-b  — line 1: stock-style stats + model • thinking right-aligned
 *                 line 2: "⚡ speeds • 🔌 MCP: … • folder"
 *   status-line — stock footer untouched + one plain setStatus line
 *   stock       — the stock pi footer, untouched (extension idles; any other
 *                 layout re-installs the custom footer live, no /reload needed)
 *
 * Speeds are computed from pi-visible events only (llama-server's own timings
 * never reach pi). TG "window" ≈ llama-server's live eval rate; TG "final" =
 * output tokens / generation time matches the "N tok in S s" pair when
 * statsMode is "gen"; statsMode "wall" matches the old TPS average. See engine.ts.
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
import {
	assembleLine,
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
let settings: StatusPlusSettings = { ...DEFAULTS };
let footerDataRef: ReadonlyFooterDataProvider | undefined;
let activeCtx: ExtensionContext | undefined;
let footerInstalled = false;
let autoCompactEnabled = true;
;/** Last non-zero window TG, kept only for the tgMode "window" decay case. */
let lastSpeeds = { tg: 0 };

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
	// Pi's own context estimate (handles compaction + trailing messages).
	const used = ctx.getContextUsage?.();
	stats.contextTokens = used?.tokens ?? null;
	if (used?.contextWindow) stats.contextWindow = used.contextWindow;
	return stats;
}

// ---------------------------------------------------------------------------
// Speed snapshot for the renderer
// ---------------------------------------------------------------------------

function engineSnapshot(): SpeedSnapshot {
	// After the stream ends the engine's values are stable and authoritative
	// (usage reconciled, end time fixed), so always recompute — never reuse a
	// stale mid-stream snapshot. Only the pure window TG (tgMode "window" with
	// alignModes off) decays as events age out; keep its last measured value
	// in that one case so the segment does not drop to zero on the bar.
	const tg = engine.tgDisplayed(settings.tgWindowMs, settings.tgMode, settings.statsMode, settings.alignModes);
	const pair = engine.statsPair(settings.tokenSource, settings.statsMode);
	const snap: SpeedSnapshot = {
		tg,
		pp: engine.ppSpeed(),
		ttft: engine.ttftMs() / 1000,
		statsTokens: pair.tokens,
		statsSeconds: pair.seconds,
		streaming: engine.isStreaming,
	};
	if (!snap.streaming && tg <= 0 && lastSpeeds.tg > 0 && settings.tgMode === "window" && settings.alignModes === "off") {
		snap.tg = lastSpeeds.tg;
	} else if (snap.streaming && tg > 0) {
		lastSpeeds.tg = tg;
	}
	return snap;
}

// ---------------------------------------------------------------------------
// Footer frame
// ---------------------------------------------------------------------------

function buildFrame(ctx: ExtensionContext, width: number, theme: FooterFrameData["theme"]): FooterFrameData {
	return {
		ctx,
		theme,
		settings: settings as FooterFrameData["settings"],
		stats: computeStats(ctx),
		speed: engineSnapshot(),
		branch: footerDataRef?.getGitBranch() ?? null,
		mcpSegment: stripAnsi(footerDataRef?.getExtensionStatuses().get("mcp") ?? ""),
		width,
	};
}

/** Strip ANSI colour escapes (the mcp segment arrives styled by its extension). */
function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\x07]*\x07/g, "");
}

/** Join the stats pieces: before, context (colored), auto. */
function composeStatsLine(theme: FooterFrameData["theme"], parts: StatsParts): string {
	const head = parts.before.length > 0 ? `${parts.before}, ` : "";
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

function buildLines(ctx: ExtensionContext, width: number, theme: FooterFrameData["theme"]): string[] {
	const safeWidth = Math.max(width, MIN_WIDTH);
	const data = buildFrame(ctx, safeWidth, theme);
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
		const items = joinBullet([
			composeStatsLinePlain(parts) || undefined,
			speed || undefined,
			modelPart,
			thinkingPart,
			folder,
			mcp,
		]);
		return [truncate(items, safeWidth)];
	}

	// --- one-line: everything on one line (no MCP) --------------------------
	if (s.layout === "one-line") {
		const left = joinBullet([composeStatsLine(theme, parts), speed || undefined]);
		const right = joinBullet([modelPart, thinkingPart, folder]);
		lines.push(assembleLine(left, right, safeWidth));
		return lines;
	}

	// --- two-line-a: line 1 = stats • speed • model • thinking; line 2 = folder • MCP
	if (s.layout === "two-line-a") {
		const left = joinBullet([composeStatsLine(theme, parts), speed || undefined, modelPart, thinkingPart]);
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

function buildStatusLineText(ctx: ExtensionContext): string {
	const lines = buildLines(ctx, LINE_FALLBACK_WIDTH, ctx.ui.theme);
	return lines.join(" • ");
}

function updateStatusLine(ctx: ExtensionContext): void {
	if (footerInstalled && settings.layout !== "status-line" && settings.hideStatusLine) return;
	try {
		const text = buildStatusLineText(ctx);
		ctx.ui.setStatus(STATUS_KEY, text.length > 0 ? text : undefined);
	} catch {
		/* stale ctx — ignore */
	}
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
		applyLayout(ctx);
		updateStatusLine(ctx);
	});

	pi.on("session_shutdown", () => {
		try {
			if (footerInstalled) activeCtx?.ui.setFooter(undefined);
			activeCtx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* stale ctx — ignore */
		}
		activeCtx = undefined;
		footerDataRef = undefined;
		footerInstalled = false;
	});

	// --- streaming ----------------------------------------------------------
	pi.on("message_start", (event: MessageStartEvent) => {
		if (event.message.role === "assistant") {
			const ts = (event.message as { timestamp?: number }).timestamp;
			engine.start(typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now());
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
		updateStatusLine(ctx);
	});

	pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
		updateStatusLine(ctx);
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

	ctx.ui.notify(`unknown field "${words[0]}" — try /status-plus (menu) or /status-plus status`, "warning");
}

const BOOL_KEYS_LIST: readonly BoolKey[] = [
	"showStats",
	"showTtft",
	"showPp",
	"showAuto",
	"showCwd",
	"showMcp",
	"showIcon",
	"showSpeedLabels",
	"hideStatusLine",
	"countToolCalls",
	"pauseDuringTools",
];

function setEnum(key: EnumField, value: string): void {
	(settings as unknown as Record<string, string>)[key] = value;
}

function commit(ctx: ExtensionCommandContext, message: string): void {
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
	return `pi-status-plus: ${parts.join(", ")}`;
}

/** Interactive picker: one entry per setting, current value in the label. */
async function runMenu(ctx: ExtensionCommandContext): Promise<void> {
	const fields: { key: string; label: string }[] = [
		...ENUM_FIELDS.map((key: EnumField) => ({ key, label: key })),
		{ key: "tgWindowMs", label: "tgWindowMs" },
		...BOOL_KEYS_LIST.map((key: BoolKey) => ({ key, label: key })),
	];

	for (;;) {
		const current = settings as unknown as Record<string, unknown>;
		const labels = fields.map(({ key, label }) => {
			const value = current[key];
			return `${label}: ${typeof value === "boolean" ? (value ? "on" : "off") : String(value)}`;
		});
		const choice = await ctx.ui.select("pi-status-plus — change a setting", [...labels, "done"]);
		if (choice === undefined || choice === "done") return;
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
	// setStatus line needs explicit updates.
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
