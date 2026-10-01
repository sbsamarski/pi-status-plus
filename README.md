# pi-status-plus

A full replacement for Pi's status bar (footer), with a restructured token/context
display, TG/PP speeds with selectable calculation methods, optional TTFT, filename-only
model display, and an optional working folder. Created for local llama.cpp /
ik_llama.cpp servers, but works with any provider.

## Status

⚠ **Not yet tested live in Pi.** The logic is type-checked (`tsc --strict`) and covered
by a smoke test (`dev/smoke.mjs`) plus a math unit test (`dev/unit.mjs`), both passing.
The extension has **not yet been loaded inside a running Pi session** — if anything
looks wrong on screen, `/status-plus status` shows the current settings and
`ctx.ui.setFooter(undefined)` semantics mean removing/disabling the extension always
restores the stock footer.

## Install / run

The folder `pi-status-plus` lives in `C:\Users\serge\.pi\agent\extensions\`, so Pi
discovers it automatically (the `pi:` block in package.json points at `index.ts`).
It expects `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and
`@earendil-works/pi-ai` to resolve at runtime — pi injects these when loading the
extension (for type-checking, the folder has a `node_modules` junction to
pi-stamp-lite's node_modules).

Run the checks from the extension folder:

```
node C:/Users/serge/AppData/Roaming/npm/node_modules/typescript/bin/tsc -p tsconfig.json
node --experimental-strip-types --no-warnings dev/smoke.mjs
node --experimental-strip-types --no-warnings dev/unit.mjs
```

There is no local node_modules: tsconfig `paths` maps `@earendil-works/*` into the
npm-installed pi, and the smoke/unit tests stage rewritten copies of the sources
(pi aliases those packages to its own modules at runtime, so pi itself never needs
them here either).

## Layouts

Pick with `/status-plus layout <name>` (saved to `~/.pi/agent/pi-status-plus.json`,
applied immediately — no /reload needed, in either direction):

| layout | line 1 | line 2 |
|---|---|---|
| `one-line` | `stats • ⚡ TG • PP • TTFT • tok-in-s • model • thinking • folder` (right-aligned tail) | — |
| `two-line-a` (default) | `stats • ⚡ TG • PP • TTFT • tok-in-s • model • thinking` | `folder • 🔌 MCP: …` |
| `two-line-b` | `stats` (left) + `model • thinking` (right-aligned, stock-like) | `⚡ TG • PP • TTFT • tok-in-s • 🔌 MCP: … • folder` |
| `status-line` | stock footer untouched | one plain `setStatus` line (the old tps style) |
| `stock` | stock pi footer completely untouched | — (extension idles until you pick another layout) |

Switching between any layouts — including to and from `stock` — takes effect
immediately; `/reload` is never needed.

Extra formats: `modelDisplay` = `filename` (default; strips the long local
`llama-server=http://…/E:\…\model.gguf` id to the bare file name) or `full`.
Command field names are case-insensitive (`/status-plus SHOWTTFT off` works).

## The token/context line

Stock pi:  `↑395k ↓115k R9.8M CH99.9% 78.1%/90k (auto)`
Here:      `↑395k, ↓115k, R9.8M, CH99.9%, 70.3k/213.0k (78.1%), auto`
(the ctx used/total always carries 1 decimal, e.g. "213.0k/1.0M")

- comma-separated; the used/total token count is shown, the percentage moved inside
  the parentheses; `auto` (auto-compact indicator) became its own trailing item and
  can be hidden with `showAuto off`.
- `R` = cache read, `W` = cache write, `CH` = cache hit rate of the latest call.

## The speed segment

`⚡ TG xx t/s • PP yy t/s • N tok in S s • TTFT zz s`

The segment is empty on a freshly started session — there is nothing measured yet.
As soon as the first assistant response starts, **TG** goes live; **PP** and **TTFT**
appear once that response finishes (the provider reports the prompt-token count only
at the end). Afterwards the last measured values stay on the bar instead of dropping
to zero.

- **TG** — generation speed. `tgMode window` (default) shows the last `tgWindowMs`
  (1000 ms) — close to what llama-server prints live; `tgMode final` shows
  output tokens / generation time.
- **Delta weighting**: a generation event is not always one token — some providers
  pack several tokens into one chunk. The engine learns the true tokens-per-event
  ratio at every message end (usage.output ÷ events received) and weights live
  counting with it, so the live speed converges on the real token rate after the
  first response of a session.
- **PP** — prefill speed: new (non-cached) prompt tokens / (request → first token).
- **TTFT** — time to first token in seconds, 2 decimals (`showTtft off` hides it).
- **N tok in S s** — the token/time pair (whole seconds), controlled by `statsMode`:
  - `gen` (default): output tokens over generation time only (first token → end).
    Its implied speed = llama-server's own final "eval rate" = pi-stamp-lite's TG.
  - `wall`: output tokens over the whole stream (request → end, including the
    prefill wait). This is what the old tps extension showed; always lower than
    `gen` by the TTFT share.
- **Math alignment**: the old extension could show TPS higher than `N tok in S s`
  implied because TPS slid on a 1-s window while the pair used total elapsed time.
  `alignModes match` (default) displays the TG speed whose formula equals the chosen
  statsMode pair, so `TG xx t/s` always equals `N ÷ S` on screen. `alignModes off`
  shows the raw `tgMode` number instead.
- After the stream ends all values are recomputed from the authoritative usage and
  freeze (they do not drop to zero; the pure window TG with `alignModes off` keeps
  its last measured value since it would otherwise age out).
- The whole bar refreshes on a calm cadence (`refreshMs`, 500 ms by default) instead
  of flickering with every arriving fragment, and displayed token counts are whole
  numbers.

## Why speeds can differ from the llama-server console

Pi never receives llama-server `timings.probs` / eval counters — the OpenAI-compatible
streaming API only reports cumulative `usage` in the final chunk. So every number here
is derived from pi-visible events:

- TG window counts one token per received delta over the last second — matches the
  server console's live eval rate while deltas flow evenly.
- TG gen / the `gen` pair use the authoritative `usage.output` over the measured
  generation wall time — matches the server's final eval rate when client-side
  overhead (network, pi rendering) is small.
- PP uses `usage.input` (non-cached prompt tokens) over the observed prefill wait —
  same as pi-stamp-lite. A warm prefix cache makes PP look extremely fast because
  cached tokens are never re-read.
- With `tokenSource estimate` the pair uses counted deltas instead of `usage.output`
  (they agree on llama-family servers; useful for providers that under-report).

ik_llama.cpp and main llama.cpp report identical fields over this API, so both show
the same numbers; the server consoles differ only in what they print locally.

## All settings

| field | values (default first) | meaning |
|---|---|---|
| `layout` | `two-line-a`, `one-line`, `two-line-b`, `status-line`, `stock` | bar structure |
| `modelDisplay` | `filename`, `full` | model id display |
| `tokenSource` | `provider`, `estimate` | token count source for the pair |
| `tgMode` | `window`, `final` | TG formula (when `alignModes off`) |
| `statsMode` | `gen`, `wall` | "N tok in S s" formula (default `gen` = generation-only, matches pi-stamp-lite and llama-server's eval rate; `wall` includes the prefill wait like the old tps average) |
| `alignModes` | `match`, `off` | force TG math to equal the pair math |
| `tgWindowMs` | `1000` (100–60000) | window length for `tgMode window` (live TG only; PP and the final math never use it) |
| `refreshMs` | `500` (100–10000) | how often the bar's numbers refresh; end-of-response values always appear immediately |
| `showStats` | `on`/`off` | show the "N tok in S s" pair |
| `showTtft` | `on`/`off` | show TTFT |
| `showPp` | `on`/`off` | show PP speed |
| `showAuto` | `on`/`off` | show the `auto` item |
| `showCwd` | `on`/`off` | show the working folder |
| `showMcp` | `on`/`off` | show the MCP segment |
| `showIcon` | `on`/`off` | show `⚡` |
| `showSpeedLabels` | `on`/`off` | show `TG`/`PP` labels |
| `hideStatusLine` | `on`/`off` | hide our own setStatus line when the footer shows it || `countToolCalls` | `on`/`off` | count edit/write tool-call tokens towards TG |
| `pauseDuringTools` | `on`/`off` | pause timers during non-generation tools |

Menu: `/status-plus` (interactive). Direct: `/status-plus <field> [value]`,
e.g. `/status-plus showTtft off`. Current state: `/status-plus status`.

## MCP information

The MCP segment is read from the extension status line that **pi-mcp-adapter**
publishes under the key `mcp` (the exact text the stock footer displays: "🔌 MCP: N
servers enabled (M disabled)"). No MCP servers are queried, and disabling servers or
the adapter just makes the segment show `🔌 MCP: status n/a` (or disappear when
`showMcp off`).
