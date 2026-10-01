/**
 * pi-status-plus — settings stored in ~/.pi/agent/pi-status-plus.json.
 *
 * Same convention as pi-stamp-lite: one small JSON file owned by this
 * extension, read on session start and written by /status-plus. Unknown
 * keys are kept (merged back on save) so hand edits and future fields
 * survive a menu save.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Footer layout:
 *   one-line    — single line: stats ⚡ speeds • model • thinking • folder (no MCP line)
 *   two-line-a  — line 1: stats ⚡ speeds • model • thinking
 *                 line 2: folder • 🔌 MCP: …
 *   two-line-b  — line 1: stats + model • thinking right-aligned (stock-like)
 *                 line 2: ⚡ speeds • 🔌 MCP: … • folder
 *   status-line — stock footer untouched + one plain setStatus line
 *   stock       — stock pi footer completely untouched (extension idles; switch
 *                 back anytime with /status-plus layout <name>, no /reload needed)
 */
export type LayoutMode = "one-line" | "two-line-a" | "two-line-b" | "status-line" | "stock";
/** How the TG speed number is computed. */
export type TgMode = "window" | "final";
/** How the "N tok in S s" pair is computed. */
export type StatsMode = "wall" | "gen";
/** If tgMode and statsMode disagree, display the TG speed that matches the stats pair. */
export type AlignMode = "off" | "match";
/** Model id display: filename only or the full stock id. */
export type ModelDisplay = "filename" | "full";
/** Source of the per-call token counts. */
export type TokenSource = "provider" | "estimate";

export interface StatusPlusSettings {
	layout: LayoutMode;
	/** Show the "N tok in S s" pair. */
	showStats: boolean;
	/** Show TTFT in seconds. */
	showTtft: boolean;
	/** Show the prefill (prompt processing) speed. */
	showPp: boolean;
	/** Show the auto-compact indicator (", auto" inside the context parentheses). */
	showAuto: boolean;
	/** Show the working folder. */
	showCwd: boolean;
	/** Show MCP server info (read from the mcp status line). */
	showMcp: boolean;
	/** Show the lightning icon before the speed segment. */
	showIcon: boolean;
	/** Show "TG"/"PP" labels (off = bare numbers). */
	showSpeedLabels: boolean;
	/** Hide the extension's own status line when the footer shows the same info. */
	hideStatusLine: boolean;
	/** model.id display: file name only (local llama models) or the full stock id. */
	modelDisplay: ModelDisplay;
	/** Token counts: "provider" (usage numbers) or "estimate" (counted deltas). */
	tokenSource: TokenSource;
	/** TG speed: "window" (last N ms, like the server console) or "final" (whole generation). */
	tgMode: TgMode;
	/** Stats pair: "wall" (request to end, includes the prefill wait) or "gen" (first token to end, generation only - matches llama-server's eval rate and pi-stamp-lite). */
	statsMode: StatsMode;
	/** When tgMode and statsMode disagree, show the TG speed that matches the pair. */
	alignModes: AlignMode;
	/** Tool-call tokens count towards TG (edit/write). */
	countToolCalls: boolean;
	/** Pause speed/timers while a prompt-processing tool runs. */
	pauseDuringTools: boolean;
	/** TG window length in ms (tgMode "window"). */
	tgWindowMs: number;
}

export const DEFAULTS: StatusPlusSettings = {
	layout: "two-line-a",
	showStats: true,
	showTtft: true,
	showPp: true,
	showAuto: true,
	showCwd: true,
	showMcp: true,
	showIcon: true,
	showSpeedLabels: true,
	hideStatusLine: true,
	modelDisplay: "filename",
	tokenSource: "provider",
	tgMode: "window",
	statsMode: "gen",
	alignModes: "match",
	countToolCalls: true,
	pauseDuringTools: true,
	tgWindowMs: 1000,
};

const LAYOUTS = ["one-line", "two-line-a", "two-line-b", "status-line", "stock"] as const;
const MODEL_DISPLAYS = ["filename", "full"] as const;
const TOKEN_SOURCES = ["provider", "estimate"] as const;
const TG_MODES = ["window", "final"] as const;
const STATS_MODES = ["wall", "gen"] as const;
const ALIGN_MODES = ["off", "match"] as const;
const BOOL_KEYS = [
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
] as const;

export type BoolKey = (typeof BOOL_KEYS)[number];

export const ENUM_CHOICES: Record<string, readonly string[]> = {
	layout: LAYOUTS,
	modelDisplay: MODEL_DISPLAYS,
	tokenSource: TOKEN_SOURCES,
	tgMode: TG_MODES,
	statsMode: STATS_MODES,
	alignModes: ALIGN_MODES,
};

export const ENUM_FIELDS = ["layout", "modelDisplay", "tokenSource", "tgMode", "statsMode", "alignModes"] as const;

export type EnumField = (typeof ENUM_FIELDS)[number];

function isString<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Validate tgWindowMs into a sane range. */
function clampWindow(value: unknown): number {
	const num = typeof value === "number" && Number.isFinite(value) ? value : DEFAULTS.tgWindowMs;
	return Math.min(60000, Math.max(100, Math.round(num)));
}

export function loadSettings(agentDir: string): StatusPlusSettings {
	const settings: StatusPlusSettings = { ...DEFAULTS };
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "pi-status-plus.json"), "utf8")) as Record<string, unknown>;
		if (isString(raw.layout, LAYOUTS)) settings.layout = raw.layout;
		if (isString(raw.modelDisplay, MODEL_DISPLAYS)) settings.modelDisplay = raw.modelDisplay;
		if (isString(raw.tokenSource, TOKEN_SOURCES)) settings.tokenSource = raw.tokenSource;
		if (isString(raw.tgMode, TG_MODES)) settings.tgMode = raw.tgMode;
		if (isString(raw.statsMode, STATS_MODES)) settings.statsMode = raw.statsMode;
		if (isString(raw.alignModes, ALIGN_MODES)) settings.alignModes = raw.alignModes;
		for (const key of BOOL_KEYS) {
			const value = raw[key];
			if (typeof value === "boolean") settings[key] = value;
		}
		if (raw.tgWindowMs !== undefined) settings.tgWindowMs = clampWindow(raw.tgWindowMs);
	} catch {
		/* first run or unreadable file: defaults */
	}
	return settings;
}

/** Merge settings over the existing file content, keeping unknown keys. */
export function saveSettings(agentDir: string, settings: StatusPlusSettings): void {
	const path = join(agentDir, "pi-status-plus.json");
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		/* new file */
	}
	Object.assign(raw, settings);
	writeFileSync(path, `${JSON.stringify(raw, null, "\t")}\n`, "utf8");
}
