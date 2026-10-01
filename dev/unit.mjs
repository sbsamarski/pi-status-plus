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
// standalone we rewrite the bare specifiers to absolute file URLs.
const PI_PKG = "C:/Users/serge/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
src = src.replaceAll('from "@earendil-works/pi-coding-agent"', `from "file:///${PI_PKG}/dist/index.js"`);
src = src.replaceAll('from "@earendil-works/pi-tui"', `from "file:///${PI_PKG}/node_modules/@earendil-works/pi-tui/dist/index.js"`);
	writeFileSync(join(here, f), src, "utf8");
}
const mod = await import('./footer.ts');
const idWithSlashes = 'llama-server=http://127.0.0.1:9931/E:/LLMs/unsloth/Qwen3.8-Flash-Next-GGUF/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf';
const idWithBackslashes = 'llama-server=http://127.0.0.1:9931/E:' + String.fromCharCode(92) + 'LLMs' + String.fromCharCode(92) + 'Qwen.gguf';
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
for (const f of ["engine.ts", "footer.ts", "settings.ts", "types.ts"]) {
	rmSync(join(here, f), { force: true });
}
console.log('unit OK');
