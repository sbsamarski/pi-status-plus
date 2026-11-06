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
import type { FooterFrameData, StatsParts } from "./types.js";

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

/** The prefill rate, whole numbers only. */
function speedTextInt(value: number): string {
	return value > 0 ? Math.round(value).toString() : "—";
}

/** The marker in front of each speed. */
const BOLT = "⚡";

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
		rates.push(mark + paint(`${label("TG ")}${speedText(speed.tg)} t/s`, speed.tgLive === true));
	}
	if (s.showPp && speed.pp > 0) {
		// No decimals on a prefill rate: it is a bulk read rate that bounces by a
		// few tokens per second, and the decimal place only pretends to be news.
		let text = `${label("PP ")}${speedTextInt(speed.pp)} t/s`;
		if (s.showPpTokens && speed.ppLive === true && speed.prefillTotal > 0) {
			// How far the engine has got through the prompt, in the shape of the
			// context figure on the same line. Only while the read is running: after
			// it finishes the pair would be the prompt against itself, always 100%.
			const done = Math.min(speed.prefillDone, speed.prefillTotal);
			const pct = (done / speed.prefillTotal) * 100;
			text += `, ${formatTokensCtx(done)}/${formatTokensCtx(speed.prefillTotal)}, ${pct.toFixed(1)}%`;
		} else if (s.showPpTokens && speed.prefillTokens > 0) {
			// Finished: what that prompt actually had to read, cached prefix excluded.
			text += `, ${formatTokensCtx(speed.prefillTokens)} tok`;
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
