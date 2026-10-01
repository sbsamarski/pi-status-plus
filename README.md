# pi-status-plus

A complete replacement for the status bar of the [pi coding agent](https://github.com/earendil-works/pi-coding-agent), with a focus on honest, readable token and speed statistics for local llama.cpp servers and online models alike.

Pi's built-in status bar is fixed. It shows you a percent, it shows you a model name stretched across the whole screen because your local model is identified by its full file path, and if you want to see how fast the model is actually generating, you have to install a separate extension that squeezes one more number into a crowded line. This extension replaces the entire bar with something you fully control: five different layouts, generation and prefill speeds, time to first token, real token counts instead of bare percentages, a working-folder line you can actually turn off, and a one-command switch back to the stock bar whenever you want it.

Everything is driven by a single command, `/status-plus`, and every choice is saved and remembered. There is nothing to edit by hand unless you enjoy that sort of thing.

---

## What it looks like

The default layout is called **two-line-a** and it turns the bar into two calm, information-dense lines:

```
↑1.2M, ↓192k, R43.0M, CH98.5%, 213.0k/1.0M (20.3%), auto • ⚡ TG 32.4 t/s • PP 85.7 t/s • 120 tok in 4 s • TTFT 3.50 s • Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf • xhigh
D:\Sergey\Development • 🔌 MCP: 4 servers enabled (5 disabled)
```

Let me walk you through what you are looking at, because every piece of it is there for a reason.

The first line starts with the **token accounting** for the whole session. `↑1.2M` means about 1.2 million prompt tokens have been sent to the model so far, `↓192k` means about 192 thousand tokens have come back, and `R43.0M` is the amount of those prompt tokens that were served from the provider's prompt cache rather than re-processed — which, on a local llama.cpp server with a warm KV-cache, is the reason your second and third question fly. `CH98.5%` is the cache hit rate of the most recent call. Then comes the part most people care about: `213.0k/1.0M (20.3%)` tells you that the conversation currently occupies 213 thousand tokens of a one million token context window, which is 20.3 percent — the actual token count right there, not just a percentage you have to reverse-engineer. The trailing `auto` is pi's own indicator that automatic context compaction is enabled; it appears as its own little item and can be turned off.

After that comes the **speed segment**, introduced by a small lightning bolt so your eye can find it instantly. `TG 32.4 t/s` is the token generation speed, `PP 85.7 t/s` is the prefill (prompt processing) speed, `120 tok in 4 s` tells you the most recent response produced 120 tokens in roughly four seconds of actual generation, and `TTFT 3.50 s` is the time to first token — how long you waited, after sending the request, before the first character appeared. The order of these items, by the way, is deliberate: the two speeds come first because you watch them live, the token count comes second because it summarises the finished response, and TTFT comes last because it explains the wait you already experienced.

The line ends with the model. Local llama.cpp models are identified by pi with their entire file path, which on a real machine looks like `llama-server=http://127.0.0.1:9931/E:\LLMs\unsloth\Qwen3.8-Flash-Next-GGUF\Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf` and eats half the screen. By default this extension shows only the file name itself, `Qwen3.8-...gguf`, followed by the thinking level (`xhigh` in the example). Online models like `glm-flash-latest` are shown exactly as they are. If you ever want the full path back, one command restores it.

The second line holds the two things that would otherwise clutter the first: the **working folder** pi was started from, and the **MCP server summary** (`4 servers enabled, 5 disabled`) borrowed from the MCP adapter's own status line so the information is never lost even though this extension owns the whole footer.

And because tastes differ, none of this is set in stone. Every element can be kept, moved, or removed.

---

## The five layouts

You switch layouts with `/status-plus layout <name>`. The change takes effect immediately — no restart, no reload — and is saved for future sessions. The same is true for switching *to* and *from* the stock bar.

**`two-line-a` (the default)** — the one shown above. The first line carries the statistics, the speeds, and the model; the second line carries the working folder and the MCP summary. This is the layout to choose if you want everything visible all the time without giving up the MCP information.

**`one-line`** — the whole bar collapses into a single line: statistics, speeds, model, thinking level, and working folder, with the tail of the line right-aligned when it fits. The MCP summary is deliberately absent here; this is the layout for when you want the absolute minimum footprint and don't care about MCP on the bar.

**`two-line-b`** — the layout that stays closest to pi's own design. The first line looks like the stock bar: statistics on the left, model and thinking level right-aligned on the right, but with the improved token format (`213.0k/1.0M (20.3%)` instead of `20.3%/1.0M`). The second line carries the speeds, the MCP summary, and the working folder.

**`status-line`** — the stock footer stays exactly as pi made it, and this extension behaves like a classic status-line extension: it appends one plain line with the speeds and statistics after the MCP information, in the same place the older token-speed extensions used to live. Choose this if you want the new statistics but pi's own bar otherwise untouched. (If you still have a separate token-speed extension installed, disable it first, or you will see two overlapping lines of the same information.)

**`stock`** — the extension steps aside completely and pi's original bar returns, byte for byte. The extension stays enabled in the background and even keeps its measurements running quietly, so when you type `/status-plus layout two-line-a` a moment later, your custom bar comes back instantly with current values. People use this to compare, to take screenshots for bug reports, or simply because some days you want the original.

---

## Installation

This is a source extension: pi loads it from a folder, and there is nothing to compile.

1. Find your pi extensions folder. On Windows that is `C:\Users\<you>\.pi\agent\extensions\`; on Linux and macOS it is `~/.pi/agent/extensions/`. If the folder does not exist yet, create it.
2. Copy this repository's files there, either into a folder named `pi-status-plus` (keeping `index.ts` at its root) or by cloning:
   ```
   cd ~/.pi/agent/extensions
   git clone https://github.com/sbsamarski/pi-status-plus.git
   ```
3. Restart pi (or run `/reload` if you are already inside a session). You should see the new bar immediately, in the default `two-line-a` layout.

That is genuinely all. There is no `npm install`, no build step, and no local `node_modules` folder to maintain — and that is not laziness, it is design. Pi loads extensions through its own module loader, which hands every `@earendil-works` import to pi's own bundled modules. The extension simply never needed its own copy. (The only place those imports matter is the optional offline type check described near the end of this page, and even there the configuration points at your installed pi rather than vendoring anything.)

The extension is developed and tested against pi 0.87.x on Windows, and it contains nothing Windows-specific — the paths in the examples just happen to be Windows paths. Local models through llama.cpp and ik_llama.cpp servers, and online models through OpenRouter-style providers, are the setups it was built and exercised against, but it reads only standard pi events and standard provider usage numbers, so any provider pi supports will work.

---

## Understanding the speeds

This is the part worth reading slowly, because token speeds are surprisingly easy to measure *wrong*, and most of the confusion people have with status bars comes from three honest but different questions being mixed into one number: how fast is the model writing right now, how fast did it write on average once it started, and why did I wait so long before anything appeared?

Every model response has three moments. The request is sent (`t0`). After a wait, the first token arrives — that wait is the **time to first token**, or TTFT, and it contains everything that happens before generation can begin: the network trip, any provider queue, and the prefill, which is the server reading your prompt. Then tokens flow until the end. The speed during that flowing part is the generation speed; the speed of reading the prompt before it is the prefill speed.

**TG — the generation speed.** Two calculation styles are available, and the extension lets you choose (`/status-plus tgMode window` or `final`). The `window` style answers "how fast is it going *right now*": it sums the tokens that arrived in the last little while (one second by default, tunable from 100 milliseconds up to a full minute) and divides by the real time they took. This is the number that behaves like the rate llama.cpp prints on its own console while it streams, and it is the one you want while watching a long response being written. The `final` style answers "how fast did it write, overall": the total output tokens of the finished response divided by the time from first token to the end. For a well-behaved server these two agree closely; when they disagree, `final` is the honest average and `window` is the honest *now*.

**PP — the prefill speed.** This one is measured once per response: the number of *new* prompt tokens (the ones that were not already sitting in the cache) divided by the prefill wait. With a warm cache this number can look absurdly high, and that is not a bug — if 99 percent of your prompt was already cached, the server really did read those tokens at memory speed.

**The "N tok in S s" pair.** After each response finishes, the bar freezes a summary of it: how many tokens it produced and how long the meaningful part took. Two time bases are available. The default, `statsMode gen`, measures from the first token to the end — generation only — which makes its implied speed identical to `final`-style TG and to llama.cpp's own "eval rate" printout, and identical to the per-response stamps that companion tools like pi-stamp-lite show. The alternative, `statsMode wall`, measures from request to end and therefore *includes* the TTFT wait; it is the style the older token-speed extensions displayed, and it will always read lower than `gen` by exactly the amount of time you spent waiting for the first token. Neither is lying — they answer different questions — but if you want the number that matches the server console, use `gen`.

**Alignment.** Because the TG number and the pair each have their own style, there is one more switch, `alignModes match` (the default), which forces the displayed TG to use the same formula as the displayed pair. With it on, the t/s you see is *always* exactly the token count divided by the seconds shown — no exceptions, no surprises. Turn it off if you would rather have the raw `window` or `final` number regardless of what the pair says.

**One honest caveat about live counting.** While a response streams, pi delivers the text as a series of events, and not every provider sends exactly one token per event — some pack several tokens into one chunk, others trickle single tokens in bursts. The frozen numbers after a response are always exact, because they come from the provider's own usage report. The *live* number during streaming starts from a simple estimate and gets smarter: the extension measures, at the end of every response, how many real tokens each event turned out to carry, and uses that learned ratio to weight the next response's live counting. For strict per-token streamers like llama.cpp the ratio is 1.0 and changes nothing; for chunk-packing providers the live speed converges on the truth after the first response of a session.

One more small honesty note: while a tool call runs (a file read, a shell command), no tokens are being generated by the model, so the timers pause rather than letting the speed decay toward zero; tool-call arguments themselves, which *are* model output, are counted by default and can be excluded.

---

## Configuration

Everything is controlled through one command and remembered in a small settings file.

Type `/status-plus` with no arguments inside pi and you get a menu listing every setting with its current value; pick one and, if it has several choices, pick the value you want. Changes are saved the moment you make them. Or skip the menu entirely and use direct commands, which are case-insensitive:

```
/status-plus layout two-line-b        switch the layout
/status-plus showTtft off             hide the time-to-first-token
/status-plus tgwindow 5000            set the live TG window to 5 seconds
/status-plus statsMode gen            choose the pair's time base
/status-plus status                   print every current setting
```

Every setting can also be edited by hand in `~/.pi/agent/pi-status-plus.json` (a documented example ships with this repository as `config-example.json`). Here is what each one does:

| Setting | Values (default first) | What it controls |
|---|---|---|
| `layout` | `two-line-a`, `one-line`, `two-line-b`, `status-line`, `stock` | The overall shape of the bar, as described above. |
| `modelDisplay` | `filename`, `full` | Whether local models are shown by file name only or by their full provider-and-path identifier. |
| `tokenSource` | `provider`, `estimate` | Where the token counts come from: the provider's own usage report (exact) or the extension's own counting (a fallback for providers that under-report). |
| `tgMode` | `window`, `final` | How the live TG number is computed: a moving average over the last few seconds, or output over generation time. Only matters when `alignModes` is `off`. |
| `statsMode` | `gen`, `wall` | The time base of the "N tok in S s" pair: generation only, or the whole request including the wait. |
| `alignModes` | `match`, `off` | Whether the displayed TG is forced to agree with the displayed pair. |
| `tgWindowMs` | `1000` (100–60000) | The length of the moving average for `window`-style TG. Longer is smoother but slower to react. |
| `showStats` | `on` / `off` | Whether the "N tok in S s" pair appears at all. |
| `showTtft` | `on` / `off` | Whether TTFT appears. |
| `showPp` | `on` / `off` | Whether the prefill speed appears. |
| `showAuto` | `on` / `off` | Whether the auto-compact indicator appears in the context display. |
| `showCwd` | `on` / `off` | Whether the working folder appears (in whichever position the layout gives it). |
| `showMcp` | `on` / `off` | Whether the MCP summary appears. |
| `showIcon` | `on` / `off` | Whether the lightning bolt precedes the speeds. |
| `showSpeedLabels` | `on` / `off` | Whether the speeds are labelled `TG`/`PP` or shown as bare numbers. |
| `hideStatusLine` | `on` / `off` | In layouts where the footer already shows everything, keep the extension's own status line out of pi's status area. |
| `countToolCalls` | `on` / `off` | Whether tool-call arguments (which are model output too) count toward TG. |
| `pauseDuringTools` | `on` / `off` | Whether timers pause while a non-generation tool runs, so the speed does not decay during file reads and shell commands. |

A few design choices deserve a sentence of explanation. The working folder can be hidden entirely because pi shows it on its own full-width line by default, which many people (the author included) find wasteful; here it tucks into the corner of the bar instead. The MCP summary is *read* from the MCP adapter's status line rather than recomputed, which means this extension never talks to your MCP servers at all — it simply relays what the adapter already published, and if the adapter is absent the segment politely disappears. And the model name is shortened only for local models whose identifier is a file path; online model identifiers are left untouched because they carry no path to remove.

---

## What the numbers come from (and what they cannot know)

Everything this extension displays is derived from events that pi itself sees: when a request begins, when each piece of text arrives, and when the response ends with the provider's official usage report attached. Pi never receives llama.cpp's internal timing blocks, so no extension can quote the server's exact internal counters — instead this extension measures the same moments you would time with a stopwatch and reconciles its running tally against the provider's token report at the end of every response. The frozen numbers after a response are exact by construction. The live numbers during streaming are estimates that converge, as described above.

The practical consequence for llama.cpp and ik_llama.cpp users: the frozen TG after a response matches what the server prints as its eval rate (when `statsMode` is `gen`), and the PP figure reflects the genuinely new prompt tokens rather than cached ones, which is why it can legitimately exceed the server's cold-prefill numbers after your context warms up.

---

## Checking your installation (optional)

The repository ships with two small self-tests that run outside pi. They type-check nothing at runtime (pi does the loading), but they verify the speed mathematics and render every layout with simulated data:

```
node --experimental-strip-types --no-warnings dev/smoke.mjs
node --experimental-strip-types --no-warnings dev/unit.mjs
```

If you want a full strict type check as well, the `tsconfig.json` in this repository is already set up for it — but it points at an npm-installed pi on the author's machine, so open it once and adjust the three `paths`/`typeRoots` locations to wherever your pi is installed, then run:

```
node C:/path/to/typescript/bin/tsc -p tsconfig.json
```

Both self-tests need Node 22.6 or newer (for native TypeScript stripping) and will also stage temporary copies of the sources with resolved imports, cleaning up after themselves.

---

## Frequently asked questions

**The speed segment is empty — is it broken?** No. There is nothing to measure until the first response of the session has been generated. TG appears the moment text starts flowing; PP and the token pair appear once that response completes and the provider's usage report arrives. After that the last measured values stay on the bar permanently instead of dropping to zero.

**Why is my live TG different from the frozen TG of the same response?** The live number is a moving average of recent events (an estimate while streaming); the frozen number is computed from the provider's exact usage report. With `alignModes match` and `statsMode gen` the frozen TG equals the frozen pair's implied speed to the digit, and both match the server console's eval rate.

**Why is the pair's implied speed lower than the stamps or console?** You are almost certainly in `statsMode wall`, which includes the prefill wait in the seconds. Switch to `gen` if you want generation-only. Wall is not wrong — it just answers "how fast did the whole round trip go" instead of "how fast did the model write".

**Does it work with ik_llama.cpp? OpenRouter? Anthropic?** It reads only what pi sees, so any provider works. The speed semantics were designed and verified against llama.cpp, ik_llama.cpp, and OpenRouter-style endpoints.

**Can I run it alongside the older token-speed extension?** In the footer layouts, yes but pointlessly — they would duplicate the same line. In `status-line` layout, no: disable the other one first.

**Pi updated and the bar still works — why?** Because pi injects its own modules into extensions at load time. The extension has no dependencies to break on a pi update. Only the optional offline type check cares about where pi is installed.

---

## Development

The whole extension is a handful of small TypeScript files with one job each: `index.ts` wires pi's events and commands to everything else, `engine.ts` measures and computes all speeds from those events, `footer.ts` turns numbers into the lines you see, `settings.ts` owns the configuration file, and `types.ts` holds the shared shapes. If you want to change what appears on the bar, `footer.ts` is where you look; if you want to change how a speed is computed, `engine.ts`.

The `dev/` folder contains the two self-tests described above. They are deliberately boring: fake pi, simulated streams with known token counts, and printed assertions — so that a change to the math can be verified in seconds without a model running.

Ideas, bug reports, and pull requests are welcome at the issue tracker.

---

## License

[MIT](LICENSE) — do whatever you like with it, no warranty, credit appreciated but not required.