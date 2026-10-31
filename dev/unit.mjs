// Stage the extension sources next to this script (strip-types needs the
// relative imports to resolve), run, then clean up.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
for (const f of ["engine.ts", "footer.ts", "settings.ts", "types.ts"]) {
	let src = readFileSync(join(root, f), "utf8");
	for (const m of ["engine", "footer", "settings", "types"]) {
		src = src.replaceAll(`from "./${m}.js"`, `from "./${m}.ts"`);
	}

// @earendil-works packages resolve only inside pi (pi aliases them at runtime);
// standalone we rewrite the bare specifiers to absolute file URLs into the
// installed pi. The location is derived from %APPDATA% (Windows npm layout);
// set PI_PACKAGE_PATH if your pi lives somewhere else.
const PI_PKG = (process.env.PI_PACKAGE_PATH
	?? (process.env.APPDATA
		? join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent")
		: "")).replace(/\\/g, "/");
src = src.replaceAll('from "@earendil-works/pi-coding-agent"', `from "file:///${PI_PKG}/dist/index.js"`);
src = src.replaceAll('from "@earendil-works/pi-tui"', `from "file:///${PI_PKG}/node_modules/@earendil-works/pi-tui/dist/index.js"`);
	writeFileSync(join(here, f), src, "utf8");
}
const mod = await import('./footer.ts');
const idWithSlashes = 'llama-server=http://127.0.0.1:9931/D:/models/Qwen3.8-Flash-Next-GGUF/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf';
const idWithBackslashes = 'llama-server=http://127.0.0.1:9931/E:' + String.fromCharCode(92) + 'models' + String.fromCharCode(92) + 'Qwen.gguf';
console.log('filename (fwd slashes):', mod.modelFileName(idWithSlashes));
console.log('filename (backslashes):', mod.modelFileName(idWithBackslashes));
console.log('filename (openrouter):', mod.modelFileName('~z-ai/glm-flash-latest'));
console.log('tokens 70300:', mod.formatTokens(70300), '| 92160:', mod.formatTokens(92160), '| 9.8M:', mod.formatTokens(9800000), '| 10.5M:', mod.formatTokens(10500000), '| 999:', mod.formatTokens(999));
const engineMod = await import('./engine.ts');
const e = new engineMod.SpeedEngine();
const t0 = Date.now();
e.start(t0);
e.markFirst(t0 + 500);
for (let i = 1; i <= 10; i++) {
  await new Promise(r => setTimeout(r, 200));
  e.recordTokens(10, undefined, false);
}
e.reconcile(100, 300);
e.stop(Date.now());
const pairGen = e.statsPair('provider', 'gen');
const pairWall = e.statsPair('provider', 'wall');
console.log('TTFT s:', (e.ttftMs()/1000).toFixed(2));
console.log('tgGen:', e.tgGen().toFixed(1), 'tgWall:', e.tgWall().toFixed(1));
console.log('pairGen:', pairGen.tokens, 'tok in', pairGen.seconds.toFixed(1), 's -> implied', (pairGen.tokens/pairGen.seconds).toFixed(1));
console.log('pairWall:', pairWall.tokens, 'tok in', pairWall.seconds.toFixed(1), 's -> implied', (pairWall.tokens/pairWall.seconds).toFixed(1));
console.log('match gen speed == implied gen pair:', Math.abs(e.tgDisplayed(1000,'window','gen','match') - pairGen.tokens/pairGen.seconds) < 0.2);
console.log('match wall speed == implied wall pair:', Math.abs(e.tgDisplayed(1000,'window','wall','match') - pairWall.tokens/pairWall.seconds) < 0.2);
console.log('pp:', e.ppSpeed().toFixed(1), '(expect 300 input / 0.5 s = 600)');

// Learned tokens-per-event ratio: provider packs 2 tokens per chunk.
const e2 = new engineMod.SpeedEngine();
const t0b = Date.now();
e2.start(t0b);
e2.markFirst(t0b + 100);
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 15));
  e2.recordTokens(1, undefined, true); // 20 chunks
}
e2.reconcile(40, 10); // true output = 40 tokens (2 per chunk)
e2.stop(Date.now());
console.log('learned ratio:', e2.learnedTokensPerEvent, '(expect 2)');
// Second stream: 10 chunks -> weighted count should be ~20, not 10.
const t0c = Date.now();
e2.start(t0c);
e2.markFirst(t0c + 50);
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 15));
  e2.recordTokens(1, undefined, true);
}
console.log('weighted counted after 10 chunks:', Math.round(e2.counted), '(expect ~20)');
console.log('ratio test OK:', Math.abs(e2.learnedTokensPerEvent - 2) < 0.01 && Math.abs(e2.counted - 20) < 1);
// --- the context piece and the speed source marker (visible format) ----------
const settingsMod = await import('./settings.ts');
const theme = { fg: (_c, t) => t };
const view = (over) => ({ ...settingsMod.DEFAULTS, ...over });

// Context: "used/total, pct%" - no parentheses, no "raw" figure. realContextTokens
// is what the server holds; contextTokens (pi's raw-transcript estimate) is larger
// here on purpose, the case that used to print ", raw 250.0k" inside the brackets.
const parts = mod.buildStatsParts({
  stats: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitRate: undefined,
           contextTokens: 250000, realContextTokens: 106400, contextWindow: 260000, autoCompact: true },
  settings: view({ showAuto: true }),
  theme,
});
console.log('context piece:', JSON.stringify(parts.context));
console.log('context format OK:', parts.context === '106.4k/260.0k, 40.9%'
  && !parts.context.includes('(') && !parts.context.toLowerCase().includes('raw'));
console.log('stats line:', mod.statsPartsPlain(parts));
console.log('auto kept as its own item:', mod.statsPartsPlain(parts).endsWith(', auto'));

const speedData = (source, engineName) => ({
  speed: { tg: 51.3, pp: 103.4, ttft: 0.91, statsTokens: 112, statsSeconds: 2.09, streaming: false, source, engineName },
  settings: view({}),
});
const fromEngine = mod.buildSpeedSegment(speedData('engine', 'basalt'));
const fromPi = mod.buildSpeedSegment(speedData('measured', ''));
console.log('speed (engine):', JSON.stringify(fromEngine));
console.log('speed (measured):', JSON.stringify(fromPi));
console.log('speed source marker OK:',
  fromEngine === '\u26a1 basalt \u2022 TG 51.3 t/s \u2022 PP 103.4 t/s \u2022 112 tok in 2 s \u2022 TTFT 0.91 s'
  && fromPi.includes('measured \u2022 TG'));

for (const f of ["engine.ts", "footer.ts", "settings.ts", "types.ts"]) {
	rmSync(join(here, f), { force: true });
}
console.log('unit OK');
