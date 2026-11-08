/**
 * pi-status-plus — footer renderer.
 *
 * Pure functions that build the status-bar lines from live data:
 *   - stats segment: usage totals + context "used/total, pct%, auto"
 *   - speed segment: "⚡ <engine|measured> • TG xx t/s • PP yy t/s • N tok in S s • TTFT zz s"
 *   - right side: model • thinking level • working folder
 *   - stock line-1 approximation for the "keep-line-1" layout
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterFrameData, SpeedSnapshot, StatsParts, UsageStats } from "./types.js";

/** Minimum spaces between the left part and the right-aligned part. */
const MIN_GAP = 3;

/** Compact token formatting, matching the stock footer. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Token formatting for the context piece: always 1 decimal for k and M
 * (e.g. "70.3k", "213.0k", "1.0M"), so current and total read consistently.
 */
export function formatTokensCtx(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/** One decimal, trailing ".0" kept (aligned speeds read better). */
function speedText(value: number): string {
	return value > 0 ? value.toFixed(1) : "—";
}

/**
 * Does the engine's prefill counter actually describe progress right now?
 *
 * A slot counts tokens it took from the cache as already read. On a warm session
 * that means the counter starts at the whole prompt: "227.3k/227.3k, 100.0%" from
 * the first moment, which is not a measurement of anything. Two tests catch it:
 *
 *   - The read reports itself complete before it started (100% at t=0). The one
 *     case where this is true is a cold load of the whole session, and in that
 *     case the read is over the moment it reads its last token anyway.
 *   - The counter lands on what the conversation already holds. The prompt of a
 *     live session is that session plus a little, so a progress figure sitting on
 *     the context size within a rounding distance is the cached total, not a
 *     position inside the read. A genuine early read is far below it.
 *
 * When either is true the bar shows the prefill speed alone.
 */
function progressIsHonest(speed: SpeedSnapshot, done: number, stats: UsageStats | undefined): boolean {
	if (speed.prefillTotal <= 0 || done <= 0) return false;
	if (done >= speed.prefillTotal * 0.995) return false;
	// No stats on the frame (a caller drawing the speed alone): nothing to compare
	// the counter against, so only the completeness test applies.
	const held = Math.max(stats?.realContextTokens ?? 0, stats?.contextTokens ?? 0);
	if (held <= 0) return true;
	return Math.abs(done - held) > Math.max(500, speed.prefillTotal * 0.02);
}

/** The prefill rate, whole numbers only. */
function speedTextInt(value: number): string {
	return value > 0 ? Math.round(value).toString() : "—";
}

/** The marker in front of each speed. Exported so the line builder can tell a
 *  segment that already starts with an icon from one that does not. */
export const BOLT = "⚡";

/** Local model ids look like "llama-server=http://…/E:\...\file.gguf". Pick the file name. */
export function modelFileName(modelId: string): string {
	const withoutQuery = modelId.split("?")[0] ?? modelId;
	const base = withoutQuery.split(/[\\/]/).pop();
	return base ?? modelId;
}

/** Join defined, non-empty items with " • ". */
export function joinBullet(items: (string | undefined | null)[]): string {
	return items.filter((item): item is string => item !== undefined && item !== null && item !== "").join(" • ");
}

/** Tint the context percent by usage (red > 90, yellow > 70). */
function contextPercentColored(theme: FooterFrameData["theme"], percent: number): string {
	const text = `${percent.toFixed(1)}%`;
	if (percent > 90) return theme.fg("error", text);
	if (percent > 70) return theme.fg("warning", text);
	return text;
}

/**
 * Build the stats segment pieces in the user's requested format:
 *   "↑395k, ↓115k, R9.8M, CH99.9%, 106.4k/260.0k, 40.9%, auto"
 * Returned split into plain/colored pieces for exact dim+color composing.
 */
export function buildStatsParts(data: FooterFrameData): StatsParts {
	const stats = data.stats;
	const s = data.settings;

	const beforeParts: string[] = [];
	if (stats.input > 0) beforeParts.push(`↑${formatTokens(stats.input)}`);
	if (stats.output > 0) beforeParts.push(`↓${formatTokens(stats.output)}`);
	if (stats.cacheRead > 0) beforeParts.push(`R${formatTokensCtx(stats.cacheRead)}`);
	if (stats.cacheWrite > 0) beforeParts.push(`W${formatTokens(stats.cacheWrite)}`);
	if (s.showCacheHit && (stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.cacheHitRate !== undefined) {
		beforeParts.push(`CH${stats.cacheHitRate.toFixed(1)}%`);
	}

	// Context piece: "used/total, pct%". The auto indicator stays its own
	// ", auto" item after the percentage.
	let context = "";
	let contextColored = "";
	let autoItem: string | undefined;
	// The number shown is the one the SERVER holds (elided transcript), not pi's
	// raw-transcript estimate - with elision the two differ by 100k tokens and
	// more, and the window limit applies to the server's figure.
	// This item is always the conversation: what the server holds, of the whole
	// window. An engine's own progress belongs to the rates, where it can say what
	// it is a progress of.
	if (stats.contextTokens !== null || (stats.realContextTokens ?? 0) > 0) {
		const real = (stats.realContextTokens ?? 0) > 0 ? stats.realContextTokens! : stats.contextTokens!;
		const pct = stats.contextWindow > 0 ? (real / stats.contextWindow) * 100 : 0;
		context = `${formatTokensCtx(real)}/${formatTokensCtx(stats.contextWindow)}, ${contextPercentColored(data.theme, pct)}`;
		contextColored = context;
	} else {
		context = `?/${formatTokensCtx(stats.contextWindow)}, ?%`;
		contextColored = context;
	}
	if (s.showAuto && stats.autoCompact) autoItem = "auto";

	return {
		before: beforeParts.join(", "),
		context,
		contextColored,
		autoItem,
	};
}

/** Plain-text stats segment (before + context + auto), for setStatus lines. */
export function statsPartsPlain(parts: StatsParts): string {
	// The token totals and the context figure are separated by a bullet, so the
	// comma inside the context figure ("207.1k/458.8k, 45.1%") stays the only
	// comma in that stretch and reads as part of the figure.
	const items = [parts.before, parts.context].filter(
		(item): item is string => item !== undefined && item !== "",
	);
	let line = items.join(" • ");
	if (parts.autoItem !== undefined && parts.autoItem !== "") {
		line = line.length > 0 ? `${line}, ${parts.autoItem}` : parts.autoItem;
	}
	return line;
}

/**
 * Build the speed segment: "⚡ TG xx t/s • PP yy t/s • N tok in S s • TTFT zz s".
 * TG only appears when there is a decode rate (a prompt still being read has a PP
 * and no TG yet, and "TG 0.0" there would bury the PP). With showSpeedSource on,
 * the segment starts with the source - the engine that produced the numbers, or
 * "measured" when the extension timed pi's stream itself.
 */
export function buildSpeedSegment(data: FooterFrameData): string {
	const speed = data.speed;
	const s = data.settings;
	const parts: string[] = [];

	if (s.showSpeedSource && (speed.tg > 0 || speed.streaming)) {
		parts.push(speed.source === "engine" ? speed.engineName || "engine" : "measured");
	}
	// Both rates stay on the bar once measured: white while that activity is
	// happening, dim (the same colour as the token totals at the start of the
	// line) when it has stopped and the number is the average it left behind.
	// A rate that has never been measured shows nothing - no "TG 0.0" placeholders.
	const paint = (text: string, live: boolean): string =>
		live || data.theme === undefined ? text : data.theme.fg("dim", text);
	const label = (name: string): string => (s.showSpeedLabels ? name : "");
	// Each rate carries its own marker instead of a shared bullet in front of the
	// pair, so the two speeds read as two separate instruments.
	const mark = s.showIcon ? `${BOLT} ` : "";
	const rates: string[] = [];
	if (speed.tg > 0) {
		let text = `${label("TG ")}${speedText(speed.tg)} t/s`;
		// Tokens written so far, and only while the engine is answering something pi
		// did not ask for - a compaction summary, another client. During pi's own
		// message the "112 tok in 2 s" pair already says this. It is a count with no
		// total on purpose: a prefill always knows how much it has to read, but a
		// generation can stop at any moment, so the only total the engine can offer is
		// the max_tokens the request happened to be given.
		if (s.showTgTokens && speed.tgLive === true && speed.genDone > 0) {
			text += `, ${formatTokensCtx(speed.genDone)} tok`;
		}
		rates.push(mark + paint(text, speed.tgLive === true));
	}
	if (s.showPp && speed.pp > 0) {
		// No decimals on a prefill rate: it is a bulk read rate that bounces by a
		// few tokens per second, and the decimal place only pretends to be news.
		let text = `${label("PP ")}${speedTextInt(speed.pp)} t/s`;
		const done = Math.min(speed.prefillDone, speed.prefillTotal);
		if (s.showPpTokens && speed.ppLive === true && progressIsHonest(speed, done, data.stats)) {
			// How far the engine has got through the prompt, in the shape of the
			// context figure on the same line. Only while the read runs, and only when
			// the counter is really counting - see progressIsHonest.
			const pct = (done / speed.prefillTotal) * 100;
			text += `, ${formatTokensCtx(done)}/${formatTokensCtx(speed.prefillTotal)}, ${pct.toFixed(1)}%`;
		}
		rates.push(mark + paint(text, speed.ppLive === true));
	}
	if (rates.length > 0) parts.push(s.showIcon ? rates.join(" ") : joinBullet(rates));
	if (s.showStats && speed.statsTokens > 0) {
		const seconds = speed.statsSeconds;
		const tokens = Math.round(speed.statsTokens);
		parts.push(seconds > 0 ? `${tokens} tok in ${Math.round(seconds)} s` : `${tokens} tok`);
	}
	if (s.showTtft && speed.ttft > 0) parts.push(`TTFT ${speed.ttft.toFixed(2)} s`);

	return joinBullet(parts);
}

/** Approximate the stock footer's line 1: "cwd (branch)". */
export function buildStockLine1(data: FooterFrameData): string {
	let pwd = data.ctx.sessionManager.getCwd();
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home) {
		const resolvedHome = home.replace(/[\\/]+$/, "");
		if (pwd.toLowerCase().startsWith(resolvedHome.toLowerCase())) {
			const rest = pwd.slice(resolvedHome.length).replace(/^[\\/]/, "");
			pwd = rest.length > 0 ? `~/${rest.replace(/\\/g, "/")}` : "~";
		}
	}
	const branch = data.branch;
	if (branch) pwd = `${pwd} (${branch})`;
	return pwd;
}

/**
 * Build the right part: model • thinking level • working folder.
 * Model id shows as file name only when modelDisplay is "filename".
 */
export function buildRightPart(data: FooterFrameData): string {
	const ctx = data.ctx;
	const s = data.settings;
	const items: string[] = [];

	const modelId = ctx.model?.id ?? "no-model";
	items.push(s.modelDisplay === "filename" ? modelFileName(modelId) : modelId);
	if (ctx.model?.reasoning) items.push(ctx.thinkingLevel ?? "thinking off");

	if (s.showCwd) items.push(buildStockLine1(data));

	return joinBullet(items);
}

/**
 * Assemble left + padding + right, right-aligned, with at least MIN_GAP
 * spaces. Fallbacks when too wide: 1-space gap, then a plain inline join so
 * the tail stays visible (truncated at the end).
 */
export function assembleLine(left: string, right: string, width: number): string {
	if (width <= 0 || right.length === 0) return truncateToWidth(left, width);
	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);
	if (leftW + MIN_GAP + rightW <= width) {
		return left + " ".repeat(width - leftW - rightW) + right;
	}
	if (leftW + 1 + rightW <= width) {
		return left + " " + right;
	}
	return truncateToWidth(`${left} • ${right}`, width);
}

export { truncateToWidth, visibleWidth };
