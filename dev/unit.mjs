// Stage the extension sources next to this script (strip-types needs the
// relative imports to resolve), run, then clean up.
import http from "node:http";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
for (const f of ["engine.ts", "engines.ts", "footer.ts", "settings.ts", "types.ts"]) {
	let src = readFileSync(join(root, f), "utf8");
	for (const m of ["engine", "engines", "footer", "settings", "types"]) {
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
const pairGen = e.statsPair('provider');
console.log('TTFT s:', (e.ttftMs()/1000).toFixed(2));
console.log('tgGen:', e.tgGen().toFixed(1));
console.log('pairGen:', pairGen.tokens, 'tok in', pairGen.seconds.toFixed(1), 's -> implied', (pairGen.tokens/pairGen.seconds).toFixed(1));
console.log('one time base: gen speed == implied pair:', Math.abs(e.tgDisplayed(1000,'window','match') - pairGen.tokens/pairGen.seconds) < 0.2);
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
// --- the tgWindowMs average, on both speed sources --------------------------
const enginesMod = await import('./engines.ts');
const { preferFrozen } = enginesMod;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Measured path (pi-side timing): 20 t/s for one second, then 100 t/s for one
// second. A 5 s window must report the average of what happened (~60), not the
// speed of the moment (~100).
const eng = new engineMod.SpeedEngine();
const base = Date.now();
eng.start(base);
eng.markFirst(base + 100);
for (let i = 0; i < 20; i++) { await sleep(50); eng.recordTokens(1, undefined, true); }  // 1 tok / 50 ms = 20 t/s
for (let i = 0; i < 20; i++) { await sleep(50); eng.recordTokens(5, undefined, true); }  // 5 tok / 50 ms = 100 t/s
const measuredWin = eng.tgWindow(5000);
const lastInstant = eng.tgWindow(300);
console.log('measured: 5 s window', measuredWin.toFixed(1), 't/s | last 0.3 s', lastInstant.toFixed(1), 't/s');
console.log('measured window averages:', measuredWin > 45 && measuredWin < 75 && lastInstant > 80);

// Engine path: a fake basalt that generates at a true 50 t/s while its
// instantaneous rate alternates 20/80. The windowed view must land on ~50.
// withCounter: expose a generated-token counter. flicker: blink "idle" in the
// middle of the stream, as engines do between chunk groups - the averaging
// window must survive it, or the average is as jumpy as the raw rate.
function fakeEngine({ withCounter = true, flicker = false, steady = false } = {}) {
  const started = Date.now();
  let polls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', service: 'basalt' })); return; }
    if (req.url === '/metrics') {
      polls++;
      const el = Date.now() - started;
      const live = {
        state: flicker && polls % 4 === 3 ? 'idle' : 'generating',
        tok_s: steady ? 50 : polls % 2 ? 20 : 80,
        prefill_tok_s_mean: 400,
        prompt_tokens: 1000,
        generated: withCounter ? Math.round((el * 50) / 1000) : null,
        elapsed_s: el / 1000,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ engine: 'basalt', live, requests: [] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

for (const cfg of [{ withCounter: true }, { withCounter: false }, { withCounter: true, flicker: true }]) {
  const { server, port } = await fakeEngine(cfg);
  const p = new enginesMod.EngineProbe();
  p.configure(`http://127.0.0.1:${port}`, 100);
  p.start();
  await sleep(1800);
  const view = p.view(1500);
  const ok = Math.abs(view.liveTg - 50) < 10 && Math.abs(view.liveTgRaw - 50) > 20 && view.busy;
  console.log(`window 1.5 s (counter=${cfg.withCounter} flicker=${cfg.flicker === true}): ${view.liveTg.toFixed(1)} t/s | instant ${view.liveTgRaw.toFixed(1)} | busy ${view.busy} | steady ~50:`, ok);
  p.stop();
  server.close();
}

// The first seconds of a request must not look like a number racing upward.
// Each request's token counter starts at zero, so a half-filled window averages
// a short stretch and climbs from the first burst to the true rate. While that is
// happening the bar shows the engine's own recent rate instead.
{
  const { server, port } = await fakeEngine({ withCounter: true, steady: true });
  const p = new enginesMod.EngineProbe();
  p.configure(`http://127.0.0.1:${port}`, 100);
  p.start();
  await sleep(600); // window asked for is 1500 ms: nowhere near full
  const early = p.view(1500).liveTg;
  await sleep(1500);
  const full = p.view(1500).liveTg;
  console.log(`fresh request: ${early.toFixed(1)} t/s | window full: ${full.toFixed(1)} t/s | no ramp-up:`,
    early > 40 && full > 40 && Math.abs(full - early) < 15);
  p.stop();
  server.close();
}

// Finished numbers are the engine's own start-to-end averages, not a window that
// kept running after the activity stopped. The engine here generates with jumpy
// live rates, then goes idle and writes its record for the request.
function finishedEngine() {
  const started = Date.now();
  const requestTime = Date.now() / 1000;
  let polls = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', service: 'basalt' })); return; }
    if (req.url === '/metrics') {
      polls++;
      const done = polls > 12; // ~1.2 s of generating, then the request finishes
      const live = done
        ? { state: 'idle', tok_s: null, prefill_tok_s_mean: null, prompt_tokens: null, generated: null, elapsed_s: null }
        : { state: 'generating', tok_s: polls % 2 ? 20 : 80, prefill_tok_s_mean: 400, prompt_tokens: 1000, generated: polls * 3, elapsed_s: polls / 10 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        engine: 'basalt',
        live,
        requests: done ? [{ id: 'r_7', time: requestTime, duration_s: 20, ttft_s: 1.5, prompt_tokens: 1000, reused: 200, output_tokens: 866, prompt_ms: 2000, decode_tok_s: 48 }] : [],
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
{
  const { server, port } = await finishedEngine();
  const p = new enginesMod.EngineProbe();
  p.configure(`http://127.0.0.1:${port}`, 100);
  p.start();
  // The engine stops generating ~1.2 s in; the reader holds the activity open for
  // a short grace after that, then reads the record the engine wrote.
  await sleep(3200);
  const f = p.view(3000).final;
  console.log('finished numbers:', JSON.stringify(f && { tg: f.tg, pp: f.pp, out: f.out, genSeconds: f.genSeconds, id: f.id }));
  console.log('exact start-to-end averages, adopted without our attribution:',
    !!f && f.tg === 48 && f.pp === 400 && f.out === 866 && Math.abs(f.genSeconds - 18.5) < 0.01);
  p.stop();
  server.close();
}

// --- the frozen-versus-live decision (the compaction freeze) -----------------
const T = 1_000_000; // an arbitrary "now" in ms
const rec = (over) => ({ tg: 40, pp: 300, ttftS: 1, out: 100, promptFresh: 10, genSeconds: 2.5, id: "r_1", startMs: T - 30000, resolvedMs: T, ...over });

// The compaction case: the summary request starts with no idle gap, so the
// activity timestamp still belongs to the previous request. Before the fix the
// frozen numbers won here forever - through the summary's prefill and its decode.
const compactionAt = (msAfter) => preferFrozen(rec({}), false, T - 30000, T + msAfter);
console.log("frozen wins 0.5 s after the response:", compactionAt(500) === true);
console.log("frozen wins 2 s after the response  :", compactionAt(2000) === true);
console.log("live wins 3 s in (compaction runs)  :", compactionAt(3000) === false);
console.log("live wins 15 min in                 :", compactionAt(900000) === false);
// A genuinely newer activity must never be masked by an old finished record.
console.log("newer activity always live          :", preferFrozen(rec({}), false, T + 50, T + 100) === false);
// While pi's own message streams, the live rates are shown regardless.
console.log("streaming pi message shows live     :", preferFrozen(rec({ resolvedMs: T + 999 }), true, T - 30000, T + 100) === false);
// No finished record yet: nothing to prefer.
console.log("no finished record: live            :", preferFrozen(null, false, T - 1000, T) === false);
console.log("frozen/live rule OK:",
  compactionAt(500) && compactionAt(2000) && !compactionAt(3000) && !compactionAt(900000)
  && !preferFrozen(rec({}), false, T + 50, T + 100)
  && !preferFrozen(rec({ resolvedMs: T + 999 }), true, T - 30000, T + 100)
  && !preferFrozen(null, false, T - 1000, T));

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

// CH (cache-hit rate) is optional now.
const chData = (showCacheHit) => ({
  stats: { input: 1000, output: 200, cacheRead: 90000, cacheWrite: 0, cost: 0, cacheHitRate: 98.6,
           contextTokens: 106400, realContextTokens: 106400, contextWindow: 260000, autoCompact: false },
  settings: view({ showAuto: false, showCacheHit }),
  theme,
});
const chOn = mod.statsPartsPlain(mod.buildStatsParts(chData(true)));
const chOff = mod.statsPartsPlain(mod.buildStatsParts(chData(false)));
console.log('CH on :', JSON.stringify(chOn));
console.log('CH off:', JSON.stringify(chOff));
console.log('CH optional OK:', chOn.includes('CH98.6%') && !chOff.includes('CH') && chOff.includes('106.4k/260.0k, 40.9%'));

const speedData = (over, settingsOver) => ({
  speed: { tg: 51.3, pp: 103.4, ttft: 0.91, statsTokens: 112, statsSeconds: 2.09, streaming: false, source: 'engine', engineName: 'basalt', ...over },
  settings: view(settingsOver ?? {}),
  theme,
});
const ink = { fg: (role, text) => `[${role}]${text}` }; // keeps the colour role visible
const rateFrame = (over, settingsOver, statsOver) => ({
  speed: { tg: 51.3, pp: 103.4, ttft: 0, statsTokens: 0, statsSeconds: 0, streaming: false, source: 'engine', engineName: 'basalt', tgLive: false, ppLive: false, prefillDone: 0, prefillTotal: 0, ...over },
  settings: view({ showIcon: true, ...settingsOver }),
  stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitRate: undefined,
           contextTokens: 225000, realContextTokens: 225000, contextWindow: 458800, autoCompact: false, ...statsOver },
  theme: ink,
});
const decodingFrame = mod.buildSpeedSegment(rateFrame({ tgLive: true }));
const bothKeptFrame = mod.buildSpeedSegment(rateFrame({}));
console.log('white while decoding:', JSON.stringify(decodingFrame));
console.log('both dim when idle  :', JSON.stringify(bothKeptFrame));
console.log('colour rule OK:',
  // TG keeps a decimal, PP is whole numbers, and each rate carries its own bolt.
  decodingFrame === '\u26a1 TG 51.3 t/s \u26a1 [dim]PP 103 t/s'
  && bothKeptFrame === '\u26a1 [dim]TG 51.3 t/s \u26a1 [dim]PP 103 t/s');

// The prompt progress appears only while the prompt is being read; afterwards the
// bar shows what that prompt had to actually read, never "x/x, 100%".
// The lie the slot tells on a warm session: cached tokens count as read, so the
// counter starts at the whole prompt and can only say 100%.
const warmLie = mod.buildSpeedSegment(rateFrame({ ppLive: true, prefillDone: 227300, prefillTotal: 227300 }));
// A real read: a third of the prompt done, well below what the session already holds.
const realRead = mod.buildSpeedSegment(rateFrame({ ppLive: true, prefillDone: 90000, prefillTotal: 227300 }));
// A cold load of the whole session: honest while it climbs, and it stops being
// shown the moment it reports itself complete - which is when it would end anyway.
const coldEarly = mod.buildSpeedSegment(rateFrame({ ppLive: true, prefillDone: 60000, prefillTotal: 227300 }, {}, { realContextTokens: 0, contextTokens: 0 }));
const coldFinal = mod.buildSpeedSegment(rateFrame({ ppLive: true, prefillDone: 227300, prefillTotal: 227300 }, {}, { realContextTokens: 0, contextTokens: 0 }));
console.log('warm session, lying counter:', JSON.stringify(warmLie));
console.log('warm session, real read   :', JSON.stringify(realRead));
console.log('cold load, climbing       :', JSON.stringify(coldEarly));
console.log('cold load, at the end     :', JSON.stringify(coldFinal));
console.log('progress is shown only when it is honest OK:',
  warmLie === '\u26a1 [dim]TG 51.3 t/s \u26a1 PP 103 t/s'
  && realRead.includes('PP 103 t/s, 90.0k/227.3k, 39.6%')
  && coldEarly.includes('60.0k/227.3k, 26.4%')
  && coldFinal === '\u26a1 [dim]TG 51.3 t/s \u26a1 PP 103 t/s');
// After the read the speed stands alone. A slot keeps reporting the prompt size
// it finished with, so any figure taken from it afterwards is the prompt against
// itself - and an engine's per-request fresh-token count is not something the bar
// should guess at.
const afterPrefill = mod.buildSpeedSegment(rateFrame({ prefillDone: 227300, prefillTotal: 227300 }));
console.log('after prefill :', JSON.stringify(afterPrefill));
console.log('progress pair is prefill-only OK:',
  afterPrefill === '\u26a1 [dim]TG 51.3 t/s \u26a1 [dim]PP 103 t/s');

const withMarker = mod.buildSpeedSegment(speedData({}, { showSpeedSource: true }));
const plain = mod.buildSpeedSegment(speedData({}));
const measuredPlain = mod.buildSpeedSegment(speedData({ source: 'measured', engineName: '' }));
// Prefill: the engine is reading the prompt, so there is a PP and no TG yet.
// A rate that was never measured stays off the bar: no "TG 0.0" placeholder.
const prefill = mod.buildSpeedSegment(speedData({ tg: 0, pp: 382.4, ttft: 0, statsTokens: 0, statsSeconds: 0, streaming: true, ppLive: true }));
console.log('speed (marker on):', JSON.stringify(withMarker));
console.log('speed (default):', JSON.stringify(plain));
console.log('speed (prefill):', JSON.stringify(prefill));
console.log('marker opt-in OK:',
  withMarker.includes('basalt \u2022 \u26a1 TG 51.3 t/s') && !withMarker.includes('measured'));
console.log('no source words by default OK:',
  plain === '\u26a1 TG 51.3 t/s \u26a1 PP 103 t/s \u2022 112 tok in 2 s \u2022 TTFT 0.91 s'
  && !measuredPlain.includes('measured') && !measuredPlain.includes('basalt'));
// showIcon off: no bolts, and the two rates go back to a bullet between them.
const noBolts = mod.buildSpeedSegment(rateFrame({}, { showIcon: false }));
console.log('showIcon off:', JSON.stringify(noBolts));
console.log('bolts are optional OK:', noBolts === '[dim]TG 51.3 t/s \u2022 [dim]PP 103 t/s');
// A prompt read that the engine never reported a size for shows the speed alone.
console.log('prefill shows PP, never a zero TG OK:',
  prefill.includes('PP 382 t/s') && !prefill.includes('TG'));

for (const f of ["engine.ts", "engines.ts", "footer.ts", "settings.ts", "types.ts"]) {
	rmSync(join(here, f), { force: true });
}
console.log('unit OK');
