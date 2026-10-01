/**
 * pi-status-plus — footer renderer.
 *
 * Pure functions that build the status-bar lines from live data:
 *   - stats segment: usage totals + context "used/total (pct%), auto"
 *   - speed segment: "⚡ TG xx t/s • PP yy t/s • TTFT zz s • N tok in S s"
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
 *   "↑395k, ↓115k, R9.8M, CH99.9%, 70.3k/90k (78.1%), auto"
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
	if ((stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.cacheHitRate !== undefined) {
		beforeParts.push(`CH${stats.cacheHitRate.toFixed(1)}%`);
	}

	// Context piece: "used/total (pct%)". The auto indicator becomes its own
	// ", auto" item AFTER the parentheses (per the user's example).
	let context = "";
	let contextColored = "";
	let autoItem: string | undefined;
	if (stats.contextTokens !== null) {
		const used = stats.contextTokens;
		const pct = stats.contextWindow > 0 ? (used / stats.contextWindow) * 100 : 0;
		context = `${formatTokensCtx(used)}/${formatTokensCtx(stats.contextWindow)} (${contextPercentColored(data.theme, pct)})`;
		contextColored = context;
	} else {
		context = `?/${formatTokensCtx(stats.contextWindow)} (?%)`;
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
	const items = [parts.before, parts.context, parts.autoItem].filter(
		(item): item is string => item !== undefined && item !== "",
	);
	return items.join(", ");
}

/** Build the speed segment: "⚡ TG xx t/s • PP yy t/s • N tok in S s • TTFT zz s". */
export function buildSpeedSegment(data: FooterFrameData): string {
	const speed = data.speed;
	const s = data.settings;
	const parts: string[] = [];

	if (speed.tg > 0 || (speed.streaming && speed.statsTokens > 0)) {
		parts.push(`${s.showSpeedLabels ? "TG " : ""}${speedText(speed.tg)} t/s`);
	}
	if (s.showPp && speed.pp > 0) {
		parts.push(`${s.showSpeedLabels ? "PP " : ""}${speedText(speed.pp)} t/s`);
	}
	if (s.showStats && speed.statsTokens > 0) {
		const seconds = speed.statsSeconds;
		const tokens = Math.round(speed.statsTokens);
		parts.push(seconds > 0 ? `${tokens} tok in ${Math.round(seconds)} s` : `${tokens} tok`);
	}
	if (s.showTtft && speed.ttft > 0) parts.push(`TTFT ${speed.ttft.toFixed(2)} s`);

	const joined = joinBullet(parts);
	if (joined.length === 0) return "";
	return s.showIcon ? `⚡ ${joined}` : joined;
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
