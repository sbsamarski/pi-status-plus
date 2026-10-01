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
	/** Estimated current context tokens, null when unknown (e.g. right after compaction). */
	contextTokens: number | null;
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
}

/** Stats segment split into plain/colored pieces for exact dim+color composing. */
export interface StatsParts {
	/** Plain text before the context piece ("" when none). */
	before: string;
	/** Plain context piece, e.g. "70.3k/90k (78.1%)" ("" when no data). */
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
	showAuto: boolean;
	showCwd: boolean;
	showMcp: boolean;
	showIcon: boolean;
	showSpeedLabels: boolean;
	modelDisplay: "filename" | "full";
	tgMode: "window" | "final";
	statsMode: "wall" | "gen";
	alignModes: "off" | "match";
	tokenSource: "provider" | "estimate";
}
