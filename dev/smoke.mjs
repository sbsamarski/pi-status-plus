/**
 * pi-status-plus smoke test — loads the extension with a fake ExtensionAPI,
 * replays Pi events (simulated local llama stream) and prints the lines the
 * footer would render for each layout, including a too-narrow terminal.
 *
 *   node --experimental-strip-types --no-warnings dev/smoke.mjs
 *
 * It imports the real index.ts (type-stripping needs same-folder relative
 * imports without .js extensions, so the extension files are copied to dev/
 * with rewritten import paths, tested, then the copies are deleted).
 */

import { pathToFileURL } from "node:url";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "pi-status-plus-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// Minimal ANSI-stripping theme stub (fg wraps in a marker we strip on print).
const theme = {
	fg(role, text) {
		return `\u0001${role}:${text}\u0002`;
	},
};

// Strip the role markers so printed lines show raw text.
function clean(line) {
	return line.replace(/\u0001[^:]*:/g, "").replace(/\u0002/g, "");
}

const handlers = new Map();
const commands = new Map();
let footerActive = undefined; // (width) => string[] when our footer is installed

const fakePi = {
	on(event, handler) {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(handler);
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
};

// Stage the extension sources next to this script (strip-types resolves
// './x.ts' only within the same folder layout as the sources).
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
for (const f of ["engine.ts", "footer.ts", "index.ts", "settings.ts", "types.ts"]) {
	let src = readFileSync(join(root, f), "utf8");
	for (const m of ["engine", "footer", "settings", "types"]) {
		src = src.replaceAll(`from "./${m}.js"`, `from "./${m}.ts"`);
	}

// @earendil-works packages resolve only inside pi (pi aliases them at runtime);
// standalone we rewrite the bare specifiers to absolute file URLs.
const PI_PKG = "C:/Users/serge/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
src = src.replaceAll('from "@earendil-works/pi-coding-agent"', `from "file:///${PI_PKG}/dist/index.js"`);
src = src.replaceAll('from "@earendil-works/pi-tui"', `from "file:///${PI_PKG}/node_modules/@earendil-works/pi-tui/dist/index.js"`);
	const { writeFileSync } = await import("node:fs");
	writeFileSync(join(here, f), src, "utf8");
}
const mod = await import(pathToFileURL(join(here, "index.ts")).href);
await mod.default(fakePi);

// ---------------------------------------------------------------------------
// Fake pi context: one assistant message with usage in the session
// ---------------------------------------------------------------------------

const sessionEntries = [
	{
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 101, output: 584, cacheRead: 57424, cacheWrite: 0, cost: { total: 0 }, totalTokens: 58109 },
			timestamp: 0,
		},
	},
];

const ctx = {
	mode: "tui",
	ui: {
		theme,
		notify(message) {
			console.log(`  [notify] ${message}`);
		},
		setStatus(key, text) {
			console.log(`  [setStatus ${key}] ${clean(text ?? "(cleared)")}`);
		},
		setFooter(factory) {
			if (factory === undefined) {
				if (footerActive) console.log("  [setFooter uninstalled → stock footer restored]");
				else console.log("  [setFooter(undefined) — stock footer already active]");
				footerActive = undefined;
				return;
			}
			console.log("  [setFooter installed]");
			globalThis.__footerFactory = factory;
			const component = factory({ requestRender: () => {} }, theme, footerData);
			footerActive = (width) => component.render(width);
		},
	},
	sessionManager: {
		getCwd: () => "D:\\Sergey\\Development",
		autoCompactionEnabled: true,
		getEntries: () => sessionEntries,
	},
	model: {
		id: "llama-server=http://127.0.0.1:9931/E:\\LLMs\\unsloth\\Qwen3.8-Flash-Next-GGUF\\Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf",
		provider: "llama-server=http://127.0.0.1:9931",
		contextWindow: 92160,
		reasoning: true,
	},
	thinkingLevel: "xhigh",
	getContextUsage: () => ({ tokens: 70300, contextWindow: 92160, percent: 76.3 }),
};

const footerData = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map([["mcp", "\u001b[36m🔌 MCP: 5 servers enabled (2 disabled)\u001b[0m"]]),
	onBranchChange: () => () => {},
};

async function fire(event, ...args) {
	for (const handler of handlers.get(event) ?? []) await handler(...args);
}

async function simulateTurn(deltaCount, deltaDelayMs) {
	await fire("session_start", {}, ctx);
	if (!footerActive) throw new Error("footer was not installed for a non-stock layout");
	const component = { render: (width) => footerActive(width) };
	const t0 = 1000;
	await fire("message_start", { message: { role: "assistant", timestamp: Date.now() - 3500 } }, ctx);
	await fire("message_update", { assistantMessageEvent: { type: "thinking_start" } }, ctx);
	for (let i = 0; i < deltaCount; i++) {
		await new Promise((resolve) => setTimeout(resolve, deltaDelayMs));
		await fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "x" } }, ctx);
	}
	const usage = { input: 300, output: deltaCount, cacheRead: 57424, cacheWrite: 0, cost: { total: 0.001 }, totalTokens: 58000 };
	await fire("message_end", { message: { role: "assistant", usage, stopReason: "stop" } }, ctx);
	await fire("turn_end", {}, ctx);
	return component;
}

console.log("\n=== turn 1: 120 deltas at ~20 ms (fast TG) ===");
const component = await simulateTurn(120, 20);
console.log("\n--- layout two-line-a (default) ---");
for (const line of component.render(160)) console.log(`|${clean(line)}|`);
console.log("--- layout two-line-b ---");
commands.get("status-plus").handler("layout two-line-b", ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
for (const line of component.render(160)) console.log(`|${clean(line)}|`);
console.log("--- layout one-line ---");
commands.get("status-plus").handler("layout one-line", ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
for (const line of component.render(200)) console.log(`|${clean(line)}|`);
console.log("--- layout keep-line... removed; stock test ---");
commands.get("status-plus").handler("layout stock", ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("  footerActive after stock:", footerActive === undefined ? "uninstalled (stock footer active)" : "STILL INSTALLED (BUG)");
console.log("  switching back to two-line-a...");
commands.get("status-plus").handler("layout two-line-a", ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("  footerActive after switch back:", footerActive !== undefined ? "re-installed (no /reload needed)" : "NOT INSTALLED (BUG)");
for (const line of footerActive(100)) console.log(`|${clean(line)}|`);
console.log("--- layout status-line ---");
commands.get("status-plus").handler("layout status-line", ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
for (const line of component.render(160)) console.log(`|${clean(line)}|`);
console.log("--- narrow terminal (80 cols), back to two-line-a ---");
commands.get("status-plus").handler("layout two-line-a", ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
for (const line of component.render(80)) console.log(`|${clean(line)}|`);
console.log("--- very narrow (46 cols) ---");
for (const line of component.render(46)) console.log(`|${clean(line)}|`);

console.log("\n=== refresh throttle check ===");
await fire("session_start", {}, ctx);
commands.get("status-plus").handler("layout two-line-a", ctx);
await new Promise((resolve) => setTimeout(resolve, 20));
await fire("message_start", { message: { role: "assistant", timestamp: Date.now() } }, ctx);
await fire("message_update", { assistantMessageEvent: { type: "thinking_start" } }, ctx);
await fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "x" } }, ctx);
const r1 = footerActive(120).join("|");
await new Promise((resolve) => setTimeout(resolve, 100));
await fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "x" } }, ctx);
const r2 = footerActive(120).join("|");
console.log("render identical within 500ms:", r1 === r2 ? "PASS" : `FAIL\n  r1=${clean(r1)}\n  r2=${clean(r2)}`);
await new Promise((resolve) => setTimeout(resolve, 600));
await fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "x" } }, ctx);
const r3 = footerActive(120).join("|");
console.log("render changed after 600ms:", r3 !== r1 ? "PASS" : "FAIL");
await fire("message_end", { message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 5 } } }, ctx);
await fire("turn_end", {}, ctx);
const r4 = footerActive(120).join("|");
console.log("frozen values right after end:", clean(r4).includes("5 tok in") ? "PASS" : `FAIL: ${clean(r4)}`);

console.log("\n=== settings summary ===");
commands.get("status-plus").handler("status", ctx);

console.log("\n=== session_shutdown cleanup ===");
await fire("session_shutdown", {}, ctx);

rmSync(agentDir, { recursive: true, force: true });
for (const f of ["engine.ts", "footer.ts", "index.ts", "settings.ts", "types.ts"]) {
	rmSync(join(here, f), { force: true });
}
console.log("\nsmoke OK");
