/**
 * pi-status-plus — shared types.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/** Cumulative usage over the whole session (what the stock footer shows). */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitRate: number | undefined;
	/** Estimated current context tokens, null when unknown (e.g. right after compaction). This is
	 *  pi's estimate over the RAW transcript: with pi-compact-plus eliding old tool results it is the
	 *  size of the transcript on disk, NOT the size of the request that goes to the server. */
	contextTokens: number | null;
	/** What the server actually holds: the last real usage report of the current branch (prompt
	 *  tokens including the cached prefix, plus what the model generated). With elision this is far
	 *  below contextTokens; null when no usable usage report exists yet. */
	realContextTokens?: number | null;
	/** Context window of the active model. */
	contextWindow: number;
	/** Auto-compact currently enabled for the session. */
	autoCompact: boolean;
}

/** Current speed measurement snapshot for the footer to render. */
export interface SpeedSnapshot {
	/** The TG speed to display (already honours tgMode/alignModes). */
	tg: number;
	/** Prefill speed (input tokens / prefill time). */
	pp: number;
	/** Time to first token in seconds. */
	ttft: number;
	/** Tokens for the "N tok in S s" pair. */
	statsTokens: number;
	/** Seconds for the "N tok in S s" pair. */
	statsSeconds: number;
	/** True while a stream is active. */
	streaming: boolean;
	/** True while the decode rate is happening right now (shown in white; a kept
	 *  average from a rate that has stopped is shown dim). */
	tgLive: boolean;
	/** True while the prefill rate is happening right now. */
	ppLive: boolean;
	/** The engine's progress through the current prompt: tokens read of the total
	 *  prompt (0 = the engine does not report it, so nothing is shown). */
	prefillDone: number;
	prefillTotal: number;
	/**
	 * Tokens generated so far in an answer the engine is writing that is not pi's
	 * own message - a compaction summary, another client. Shown beside the TG rate,
	 * as a count: a generation can stop at any moment, so its total would only be
	 * the max_tokens the request was given. 0 shows nothing.
	 */
	genDone: number;
	/** Where tg/pp/ttft came from: the engine itself, or our own measurement. */
	source: "engine" | "measured";
	/** Engine the numbers came from ("" when unknown or measured). */
	engineName: string;
}

/** Stats segment split into plain/colored pieces for exact dim+color composing. */
export interface StatsParts {
	/** Plain text before the context piece ("" when none). */
	before: string;
	/** Plain context piece, e.g. "70.3k/90k, 78.1%" ("" when no data). */
	context: string;
	/** ANSI-colored context piece ("" when no data). */
	contextColored: string;
	/** The auto-compact indicator as its own item ("auto"), when shown. */
	autoItem: string | undefined;
}

/** Everything the footer needs to draw one frame. */
export interface FooterFrameData {
	ctx: ExtensionContext;
	theme: Theme;
	settings: StatusPlusSettingsView;
	stats: UsageStats;
	speed: SpeedSnapshot;
	/** Current git branch (may be null). */
	branch: string | null;
	/** MCP segment taken from the extension status line (empty = none). */
	mcpSegment: string;
	/** Terminal width for this render. */
	width: number;
}

/** View of the settings the renderer needs (keeps footer.ts decoupled). */
export interface StatusPlusSettingsView {
	layout: "one-line" | "two-line-a" | "two-line-b" | "status-line" | "stock";
	showStats: boolean;
	showTtft: boolean;
	showPp: boolean;
	/** The CH cache-hit percentage in the stats part. */
	showCacheHit: boolean;
	/** How far the prefill has got, as tokens and a percentage, beside PP. */
	showPpTokens: boolean;
	/** Tokens written so far beside TG, during an answer that is not pi's. */
	showTgTokens: boolean;
	showAuto: boolean;
	showCwd: boolean;
	showMcp: boolean;
	showIcon: boolean;
	showSpeedLabels: boolean;
	modelDisplay: "filename" | "full";
	tgMode: "window" | "final";
	alignModes: "off" | "match";
	tokenSource: "provider" | "estimate";
	/** Name the speed source (engine name, or "measured") in the speed segment. */
	showSpeedSource: boolean;
}
