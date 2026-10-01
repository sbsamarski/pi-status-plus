# pi-status-plus

A complete replacement for the status bar of the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — built for honest, readable token and speed statistics, whether you run local llama.cpp servers or online models.

Pi's built-in bar is fixed, and it has three habits this extension does away with: it shows only a percentage where you might want the actual token count, it stretches your local model's *full file path* across the screen, and if you want generation speeds you have to bolt on a separate extension that squeezes one more number into a crowded line.

This extension replaces the whole bar with something you control:

- **Five layouts** — from a single minimal line to two information-dense rows
- **Generation (TG) and prefill (PP) speeds**, plus **time to first token (TTFT)**
- **Real token counts** — the context line reads `213.0k/1.0M (20.3%)`, not just a percentage
- **A working folder you can hide** (or tuck into the corner instead of its own full-width line)
- **A one-command switch back to the stock bar** — and back again, live, no reload

One command drives everything: `/status-plus`. Every choice is saved and remembered.

---

## Contents

- [What it looks like](#what-it-looks-like)
- [The five layouts](#the-five-layouts)
- [Installation](#installation)
- [Understanding the speeds](#understanding-the-speeds)
- [Configuration](#configuration)
- [Where the numbers come from](#where-the-numbers-come-from)
- [Checking your installation](#checking-your-installation-optional)
- [FAQ](#faq)
- [Development](#development)

---

## What it looks like

The default layout, **two-line-a**:

```
↑1.2M, ↓192k, R43.0M, CH98.5%, 213.0k/1.0M (20.3%), auto • ⚡ TG 32.4 t/s • PP 85.7 t/s • 120 tok in 4 s • TTFT 3.50 s • Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf • xhigh
D:\Projects\demo-agent • 🔌 MCP: 4 servers enabled (5 disabled)
```

Line by line, here is what you are looking at.

**Line 1 — session accounting:**

- `↑1.2M` — prompt tokens sent to the model so far
- `↓192k` — tokens received back
- `R43.0M` — prompt tokens served from the provider's prompt cache instead of re-processed (with a warm llama.cpp KV-cache this is huge — by design)
- `CH98.5%` — cache hit rate of the most recent call
- `213.0k/1.0M (20.3%)` — the conversation's current footprint: actual tokens, context window, percentage
- `auto` — pi's own indicator that automatic context compaction is on (hideable)

**Line 1 — the speed segment** (marked by a lightning bolt so your eye finds it instantly):

- `TG 32.4 t/s` — token generation speed
- `PP 85.7 t/s` — prefill (prompt processing) speed
- `120 tok in 4 s` — the finished response, summarised
- `TTFT 3.50 s` — the wait before the first character appeared

The order is deliberate: you watch the two speeds live, the pair summarises the finished response, and TTFT explains the wait you already felt.

**Line 1 — the model.** Local llama.cpp models are identified by pi with their entire file path (`llama-server=http://…/D:\models\…\Qwen3.8-Flash-Next.gguf`) — enough to eat half a screen. By default this extension shows only the file name, followed by the thinking level (`xhigh` above). Online identifiers like `glm-flash-latest` are shown as-is. One command brings the full path back.

**Line 2 — the leftovers.** The working folder pi was started from, and the MCP summary borrowed from the MCP adapter's own status line — so neither is lost even though this extension owns the whole footer.

And nothing here is set in stone: every element can be kept, moved, or removed.

---

## The five layouts

Switch with `/status-plus layout <name>`. Changes apply immediately (no restart, no reload) and persist.

- **`two-line-a`** *(default)* — everything on two rows: stats + speeds + model on line 1, working folder + MCP on line 2. The layout to pick if you want it all visible.
- **`one-line`** — the minimum footprint: a single line with stats, speeds, model, thinking level, and the working folder. No MCP summary.
- **`two-line-b`** — closest to pi's own design: stats on the left with model/thinking right-aligned like the stock bar (but with the better token format), speeds + MCP + folder on line 2.
- **`status-line`** — pi's stock footer untouched; this extension appends one plain line with speeds and stats after the MCP info, where the older token-speed extensions lived. (Disable any separate token-speed extension first.)
- **`stock`** — the extension steps aside completely and pi's original bar returns, byte for byte. It keeps measuring quietly in the background, so switching back is instant and the values are current. Handy for comparing, screenshots, or just some days.

---

## Installation

A source extension: pi loads it from a folder, nothing to compile.

1. Find pi's extensions folder — inside pi's agent directory, next to your settings and sessions: `~/.pi/agent/extensions/` (on Windows: the `.pi\agent\extensions\` folder inside your user profile). Create it if needed.
2. Copy or clone the repository there:
   ```
   cd ~/.pi/agent/extensions
   git clone https://github.com/sbsamarski/pi-status-plus.git
   ```
3. Restart pi (or `/reload`). The new bar appears immediately in the default layout.

That is genuinely all — no `npm install`, no build step, no local `node_modules`. Pi's module loader hands every `@earendil-works` import to pi's own bundled modules, so the extension has nothing to install and nothing to break on a pi update.

Tested against pi 0.87.x on Windows; nothing Windows-specific inside. Built and exercised with llama.cpp, ik_llama.cpp, and OpenRouter-style providers — it reads only standard pi events and provider usage reports, so any provider pi supports works.

---

## Understanding the speeds

Token speeds are easy to measure *wrong*, and most confusion comes from three honest but different questions getting mixed into one number: how fast is the model writing *right now*, how fast did it write *on average*, and *why did I wait so long* before anything appeared?

Every response has three moments:

```
request sent (t0) ──► first token ──► end
        └── TTFT wait ──┘└─ generation ─┘
```

The wait before the first token (network, queue, and the prefill — the server reading your prompt) is **TTFT**. The speed of reading the prompt is **PP**. The speed of writing the response is **TG**.

- **TG** — two styles, your choice with `tgMode`:
  - `window` — "how fast right now": tokens from the last little while (1 s default, tunable 100 ms–60 s) over the time they actually took. Behaves like llama.cpp's live console rate.
  - `final` — "how fast overall": the finished response's output tokens over generation time. The honest average.
- **PP** — measured once per response: *new* (non-cached) prompt tokens over the prefill wait. With a warm cache it can look absurdly high — correctly so, because those tokens were never re-read.
- **The "N tok in S s" pair** — the finished response, frozen on the bar. Two time bases via `statsMode`:
  - `gen` *(default)* — first token to end. Implied speed matches llama.cpp's "eval rate" and per-response stamps from tools like pi-stamp-lite.
  - `wall` — request to end, *including* the TTFT wait. This is what the older token-speed extensions showed; it always reads lower than `gen` by exactly your TTFT. Neither lies — they answer different questions.
- **Alignment** — `alignModes match` (default) forces the displayed TG to use the same formula as the displayed pair. With it on, the t/s you see is *always* exactly `N ÷ S` — no exceptions.

**One honest caveat about live counting.** While a response streams, pi delivers text as a series of events, and not every provider sends exactly one token per event — some pack several tokens into one chunk. The frozen numbers are always exact (they come from the provider's usage report). The live number starts as an estimate and gets smarter: at each response's end the extension measures how many real tokens each event carried, and weights the next response's live counting with that learned ratio. For strict per-token streamers like llama.cpp the ratio is 1.0 and changes nothing.

Small honesty note: while a tool runs (file read, shell command) no tokens are being generated, so the timers pause instead of decaying toward zero. Tool-call arguments *are* model output and are counted by default.

---

## Configuration

One command, one settings file. Type `/status-plus` for an interactive menu of every setting with its current value, or use direct commands (case-insensitive):

```
/status-plus layout two-line-b        switch the layout
/status-plus showTtft off             hide the time-to-first-token
/status-plus tgwindow 5000            set the live TG window to 5 seconds
/status-plus statsMode gen            choose the pair's time base
/status-plus status                   print every current setting
```

Settings persist in `~/.pi/agent/pi-status-plus.json`; a documented example ships as `config-example.json`.

| Setting | Values (default first) | What it controls |
| --- | --- | --- |
| `layout` | `two-line-a`, `one-line`, `two-line-b`, `status-line`, `stock` | The overall shape of the bar |
| `modelDisplay` | `filename`, `full` | Local models by file name only, or full provider-and-path identifier |
| `tokenSource` | `provider`, `estimate` | Token counts from the provider's usage report (exact) or the extension's own counting |
| `tgMode` | `window`, `final` | Live TG formula (only matters when `alignModes` is `off`) |
| `statsMode` | `gen`, `wall` | The "N tok in S s" time base |
| `alignModes` | `match`, `off` | Force the displayed TG to agree with the displayed pair |
| `tgWindowMs` | `1000` (100–60000) | Moving-average length for `window` TG — longer is smoother, slower to react |
| `refreshMs` | `500` (100–10000) | How often the numbers refresh; end-of-response values always appear immediately |
| `showStats` / `showTtft` / `showPp` | `on` / `off` | Show the pair / TTFT / prefill speed |
| `showAuto` | `on` / `off` | The auto-compact indicator in the context display |
| `showCwd` | `on` / `off` | The working folder (in the position the layout gives it) |
| `showMcp` | `on` / `off` | The MCP summary |
| `showIcon` / `showSpeedLabels` | `on` / `off` | The lightning bolt / the `TG`-`PP` labels |
| `hideStatusLine` | `on` / `off` | Keep the extension's own status line out of pi's status area when the footer shows everything |
| `countToolCalls` | `on` / `off` | Tool-call arguments (model output too) count toward TG |
| `pauseDuringTools` | `on` / `off` | Pause timers during non-generation tools |

Three design choices, explained:

- The **working folder** hides entirely because pi gives it a full-width line by default, which many people find wasteful — here it tucks into a corner instead.
- The **MCP summary** is *read* from the MCP adapter's status line, not recomputed — the extension never talks to your MCP servers, and if the adapter is absent the segment politely disappears.
- The **model name** is shortened only for local models whose identifier is a file path; online identifiers carry no path, so they are left alone.

---

## Where the numbers come from

Everything is derived from events pi itself sees: request start, each arriving piece of text, and the response end with the provider's official usage report.

- Pi never receives llama.cpp's internal timing blocks — no extension can quote the server's exact internal counters. Instead, the same moments are measured you would time with a stopwatch, and the running tally is reconciled against the provider's token report at every response end.
- **The frozen numbers after a response are exact by construction.** The live numbers are estimates that converge, as described above.
- For llama.cpp / ik_llama.cpp users: the frozen TG matches the server's eval rate (with `statsMode gen`), and PP reflects genuinely *new* prompt tokens — which is why it can legitimately exceed the server's cold-prefill numbers once your context warms up.

---

## Checking your installation (optional)

Two small self-tests run outside pi — no model, no running pi needed:

```
node --experimental-strip-types --no-warnings dev/smoke.mjs
node --experimental-strip-types --no-warnings dev/unit.mjs
```

They locate your installed pi on their own (from `%APPDATA%` on Windows; elsewhere set `PI_PACKAGE_PATH` to the pi package folder).

For a full strict type check, uncomment the `paths` block at the bottom of `tsconfig.json` and point it at your pi install, then:

```
node "%APPDATA%\npm\node_modules\typescript\bin\tsc" -p tsconfig.json
```

Until then the type check reports the pi imports as unresolved — expected, and harmless: pi injects its own modules at load time. Both tests need Node 22.6+ (native TypeScript stripping) and clean up after themselves.

---

## FAQ

- **The speed segment is empty — is it broken?**
  No. Nothing has been measured yet. TG appears the moment text starts flowing; PP and the pair appear when the response completes. Afterwards the last values stay on the bar permanently.

- **Why is my live TG different from the frozen TG of the same response?**
  Live = a moving average of recent events (an estimate). Frozen = the provider's exact usage report. With `alignModes match` + `statsMode gen` the frozen TG equals the frozen pair's implied speed to the digit, and matches the server console's eval rate.

- **Why is the pair's implied speed lower than the stamps or the console?**
  You are in `statsMode wall`, which includes the prefill wait in the seconds. Switch to `gen` for generation-only. Wall is not wrong — it answers "how fast did the whole round trip go" instead of "how fast did the model write".

- **Does it work with ik_llama.cpp? OpenRouter? Anthropic?**
  It reads only what pi sees, so any provider works. The speed semantics were designed and verified against llama.cpp, ik_llama.cpp, and OpenRouter-style endpoints.

- **Can I run it alongside the older token-speed extension?**
  With the footer layouts: yes, but pointlessly — the same line twice. With `status-line`: no, disable the other one first.

- **Pi updated and the bar still works — why?**
  Pi injects its own modules into extensions at load time; there are no dependencies to break. Only the optional type check cares where pi is installed.

---

## Development

A handful of small files, one job each:

- `index.ts` — wires pi's events and commands to everything else
- `engine.ts` — measures and computes all speeds from those events
- `footer.ts` — turns numbers into the lines you see
- `settings.ts` — owns the configuration file
- `types.ts` — shared shapes

The `dev/` folder holds the two self-tests: fake pi, simulated streams with known token counts, printed assertions — so a change to the math verifies in seconds without a model running.

Ideas, bug reports, and pull requests are welcome at the issue tracker.

---

## License

[MIT](LICENSE) — do whatever you like, no warranty, credit appreciated but not required.