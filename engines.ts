/**
 * pi-status-plus — engine speed reader.
 *
 * The bar can show the speed the inference engine itself measured instead of pi
 * re-timing the arrival of stream chunks. The two disagree for honest reasons:
 * chunks arrive in batches, pi's own work sits between them, and an engine with
 * speculative decoding counts accepted draft tokens that never cross the socket
 * one by one. Anything the server says about its own decode loop is the number
 * the user sees in the engine's console, so that is the number we prefer.
 *
 * What it reads, per engine family (all of them on one http://127.0.0.1:<port>):
 *
 *   basalt / strata  GET /metrics (JSON)
 *       live.tok_s, live.prefill_tok_s_mean, live.state   - live speeds
 *       requests[] newest first: decode_tok_s (or tok_s), ttft_s, prompt_ms,
 *                                prompt_tokens, reused, output_tokens, duration_s
 *       GET /slots -> [{ tok_s, generated, ttft_s, ... }]  - live fallback
 *       GET /health -> { service: "basalt" }               - name
 *   llama.cpp / ik_llama.cpp  GET /metrics (Prometheus text, needs --metrics)
 *       counters are cumulative, so a speed is a delta of two samples:
 *       decode  = d(llamacpp:tokens_predicted_total) / d(llamacpp:tokens_predicted_seconds_total)
 *       prefill = d(llamacpp:prompt_tokens_total)    / d(llamacpp:prompt_seconds_total)
 *       taken across the request's own lifetime, which is exactly what the
 *       engine would have printed as its eval rate for that request.
 *   anything else  names are probed, and if no speed can be read the caller
 *       falls back to its own measurement and says so on the bar.
 *
 * Attribution: pi's own session-title and compaction calls are extra requests in
 * the engine's list, so a finished engine request is matched to pi's assistant
 * message by start time AND by the output-token count pi was reported - the
 * engine and pi agree on that number, because pi's usage comes from the same
 * response.
 */

/** Finite number or undefined (JSON fields are often null). */
function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** First defined value in the list (field names differ slightly between engines). */
function firstNum(...values: (number | undefined)[]): number | undefined {
	for (const value of values) if (value !== undefined) return value;
	return undefined;
}

/** Cumulative Prometheus counters, used for delta-based speeds. */
interface Counters {
	predTokens: number;
	predSeconds: number;
	promptTokens: number;
	promptSeconds: number;
	at: number;
}

/** One finished request, in the numbers the bar needs. */
export interface EngineRequestNumbers {
	/** Decode (TG) speed the engine measured for that request. */
	tg: number;
	/** Prefill (PP) speed: fresh prompt tokens over prompt time (0 = unknown). */
	pp: number;
	/** Time to first token in seconds (0 = unknown). */
	ttftS: number;
	/** Output tokens the engine counted for that request. */
	out: number;
	/** Generation time in seconds (duration minus the prefill wait). */
	genSeconds: number;
	/** Engine request id, for the /status-plus engine readout. */
	id: string;
	/** Wall-clock ms when the request started, as the engine reported it. */
	startMs: number;
	/** Wall-clock ms when we finished reading these numbers. */
	resolvedMs: number;
}

/** Everything the renderer may want from the engine right now. */
export interface EngineView {
	name: string;
	url: string;
	reachable: boolean;
	/** Engine is reading a prompt or generating right now. */
	busy: boolean;
	/** Live decode speed from the engine (0 = nothing yet). */
	liveTg: number;
	/** Live prefill speed from the engine (0 = nothing yet). */
	livePp: number;
	/** The finished request attributed to pi's last assistant message. */
	final: EngineRequestNumbers | null;
	/** Which reader is in use: "basalt/strata" or "prometheus" or "none". */
	kind: string;
	/** Short human note for /status-plus engine (why we fell back, etc.). */
	note: string;
}

const REQUEST_TIMEOUT_MS = 700;
/** How long we keep looking for a finished request to attribute. */
const ATTRIBUTION_POLL_LIMIT = 8;

export class EngineProbe {
	private base = "";
	private name = "";
	private kind: "none" | "json" | "prometheus" = "none";
	private note = "";
	private reachable = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pollMs = 250;
	private busyMs = 0; // 0 = idle, else when the current activity began
	private liveTg = 0;
	private livePp = 0;
	private liveState = "";
	private lastFinal: EngineRequestNumbers | null = null;

	// attribution of a finished engine request to pi's assistant message
	private reqStartMs = 0;
	private reqOut = 0;
	private reqEndMs = 0;
	private reqTries = 0;

	// Prometheus counter bookkeeping
	private prevCounters: Counters | null = null;
	private reqCounters: Counters | null = null;
	private promSamplesAfterEnd = 0;

	private nameCheckedAt = 0;
	private stopped = true;

	/** Point the probe at an engine (empty url = switched off) and restart polling. */
	configure(url: string, pollMs: number): void {
		const clean = url.trim().replace(/\/+$/, "");
		const changed = clean !== this.base;
		this.base = clean;
		this.pollMs = Math.min(5000, Math.max(100, Math.round(pollMs)));
		if (changed) {
			this.kind = "none";
			this.name = "";
			this.nameCheckedAt = 0;
			this.note = "";
			this.reset();
		}
		if (!this.stopped) this.schedule();
	}

	start(): void {
		this.stopped = false;
		this.schedule();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private reset(): void {
		this.liveTg = 0;
		this.livePp = 0;
		this.liveState = "";
		this.busyMs = 0;
		this.lastFinal = null;
		this.prevCounters = null;
		this.reqCounters = null;
	}

	/** pi sent a request: remember when, and the counters as they stood then. */
	beginRequest(startMs: number): void {
		this.reqStartMs = startMs;
		this.reqOut = 0;
		this.reqEndMs = 0;
		this.reqTries = 0;
		this.reqCounters = this.prevCounters;
		this.promSamplesAfterEnd = 0;
		this.lastFinal = null; // keep showing the previous answer only until now
		if (!this.stopped) this.schedule(0); // poll soon: the start counters matter
	}

	/** pi's message ended with this many output tokens: go find that request. */
	endRequest(usageOutput: number): void {
		this.reqEndMs = Date.now();
		this.reqOut = usageOutput > 0 ? usageOutput : 0;
		this.reqTries = 0;
		this.promSamplesAfterEnd = 0;
		if (!this.stopped) this.schedule(0); // the engine writes its entry just after the stream
	}

	/** Current picture for the bar. Cheap: returns the last polled state. */
	view(): EngineView {
		return {
			name: this.name || "engine",
			url: this.base,
			reachable: this.reachable,
			busy: this.busyMs > 0,
			liveTg: this.liveTg,
			livePp: this.livePp,
			final: this.lastFinal,
			kind: this.kind,
			note: this.note,
		};
	}

	// --- polling loop ------------------------------------------------------

	private schedule(delayMs?: number): void {
		if (this.stopped || !this.base) return;
		if (this.timer) clearTimeout(this.timer);
		// Back off politely while nothing answers (no engine running / wrong port).
		const backoff = this.reachable ? 0 : Math.min(5000, this.pollMs * 4);
		const wait = delayMs !== undefined ? delayMs : Math.max(this.pollMs, backoff);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.poll();
		}, wait);
		// A timer must never be the reason a process stays alive.
		(this.timer as unknown as { unref?: () => void }).unref?.();
	}

	/** Freshness of the live numbers decides how hard we poll. */
	private nextDelay(): number {
		if (!this.reachable) return Math.min(5000, this.pollMs * 4);
		if (this.busyMs > 0 || this.reqTries > 0) return this.pollMs;
		return Math.max(this.pollMs * 6, 1500); // idle: stay cheap, still notice restarts
	}

	private async poll(): Promise<void> {
		if (this.stopped) return;
		try {
			if (!this.name || Date.now() - this.nameCheckedAt > 300000) await this.identify();
			const body = await this.fetchText("/metrics");
			if (body === undefined) {
				// No /metrics (llama.cpp without --metrics): say why we cannot help.
				this.reachable = false;
				this.kind = "none";
				this.note = "no /metrics from the engine";
			} else {
				this.reachable = true;
				const trimmed = body.replace(/^\s+/, "");
				if (trimmed.startsWith("{") || trimmed.startsWith("[")) this.readJson(trimmed);
				else this.readPrometheus(body);
			}
		} catch (error: unknown) {
			this.reachable = false;
			this.kind = "none";
			this.note = (error as Error).message.slice(0, 60);
		}
		this.schedule(this.nextDelay());
	}

	private async fetchText(path: string): Promise<string | undefined> {
		if (!this.base) return undefined;
		const controller = new AbortController();
		const kill = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const res = await fetch(this.base + path, {
				headers: { Accept: "application/json, text/plain;q=0.5" },
				signal: controller.signal,
			});
			if (!res.ok) return undefined;
			return await res.text();
		} finally {
			clearTimeout(kill);
		}
	}

	private async getJson(path: string): Promise<Record<string, unknown> | undefined> {
		const text = await this.fetchText(path);
		if (text === undefined) return undefined;
		try {
			const parsed = JSON.parse(text) as unknown;
			return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}

	/** Which engine are we talking to? Cached; only refreshed every 5 minutes. */
	private async identify(): Promise<void> {
		this.nameCheckedAt = Date.now();
		const health = await this.getJson("/health");
		for (const key of ["service", "engine", "software", "implementation"]) {
			const value = health?.[key];
			if (typeof value === "string" && value.length > 0) {
				this.name = this.classifyName(value, "");
				return;
			}
		}
		const props = await this.getJson("/props");
		if (props) {
			const build = typeof props.build_info === "string" ? props.build_info : "";
			const software = typeof props.software === "string" ? props.software : "";
			const alias = typeof props.model_alias === "string" ? props.model_alias : "";
			const guessed = this.classifyName(build || software, alias);
			if (guessed) {
				this.name = guessed;
				return;
			}
		}
		if (!this.name) this.name = "";
	}

	/** Turn whatever the server called itself into a short family name. */
	private classifyName(raw: string, alias: string): string {
		const text = `${raw} ${alias}`.toLowerCase();
		if (text.includes("basalt")) return "basalt";
		if (text.includes("strata")) return "strata";
		if (text.includes("ik_llama") || text.includes("ik-llama")) return "ik_llama.cpp";
		if (text.includes("llama.cpp") || text.includes("llama-server")) return "llama.cpp";
		if (/^b\d{3}/.test(raw.trim())) return "llama.cpp"; // llama.cpp build_info is "b5100 <sha>"
		const word = raw.trim().split(/[\s(/]/)[0] ?? "";
		return word.length > 0 && word.length <= 16 ? word : "";
	}

	// --- basalt / strata JSON ---------------------------------------------

	private readJson(body: string): void {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(body) as Record<string, unknown>;
		} catch {
			this.kind = "none";
			this.note = "metrics JSON did not parse";
			return;
		}
		this.kind = "json";
		this.note = "";

		// live state: what the engine is doing this second
		const live = (data.live ?? data.status ?? {}) as Record<string, unknown>;
		const state = typeof live.state === "string" ? live.state.toLowerCase() : "";
		this.liveState = state;
		const busy = state !== "" && state !== "idle" && state !== "waiting" && state !== "sleeping";
		if (busy && this.busyMs === 0) this.busyMs = Date.now();
		if (!busy && this.busyMs > 0) this.busyMs = 0;
		this.liveTg = num(live.tok_s) ?? this.slotLiveTg(data) ?? (busy ? this.liveTg : 0);
		this.livePp = num(live.prefill_tok_s_mean) ?? num(live.prefill_tok_s) ?? (busy ? this.livePp : 0);

		// the request that just finished, if the engine has written its entry
		if (this.reqStartMs > 0 && this.reqEndMs > 0 && this.reqTries < ATTRIBUTION_POLL_LIMIT) {
			this.reqTries++;
			const found = this.pickRequest(data);
			if (found) {
				this.lastFinal = found;
				this.reqEndMs = 0; // attributed: stop looking
			}
		}
	}

	/** /slots carries the same live numbers on engines without a live block. */
	private slotLiveTg(data: Record<string, unknown>): number | undefined {
		const slots = data.slots;
		if (!Array.isArray(slots)) return undefined;
		for (const slot of slots) {
			const speed = num((slot as Record<string, unknown>)?.tok_s);
			if (speed !== undefined && speed > 0) return speed;
		}
		return undefined;
	}

	/**
	 * Find the engine entry for pi's last assistant message. Newest first, must
	 * have started at/after pi sent its request; the output-token count decides
	 * when pi's own title/summary calls are also in the list.
	 */
	private pickRequest(data: Record<string, unknown>): EngineRequestNumbers | null {
		const list = data.requests;
		if (!Array.isArray(list)) return null;
		const entries = list
			.map((entry) => entry as Record<string, unknown>)
			.filter((entry) => {
				const at = firstNum(num(entry.time), num(entry.timestamp), num(entry.started));
				if (at === undefined) return false;
				const startMs = at < 1e12 ? at * 1000 : at; // engines log unix seconds
				return startMs >= this.reqStartMs - 3000;
			})
			.sort((a, b) => {
				const at = firstNum(num(b.time), num(b.timestamp)) ?? 0;
				const bt = firstNum(num(a.time), num(a.timestamp)) ?? 0;
				return at - bt;
			});

		let chosen: Record<string, unknown> | undefined;
		for (const entry of entries) {
			const out = firstNum(num(entry.output_tokens), num(entry.completion_tokens), num(entry.generated)) ?? 0;
			const speed = firstNum(num(entry.decode_tok_s), num(entry.tok_s), num(entry.decode_tps), num(entry.eval_tok_s)) ?? 0;
			if (speed <= 0) continue; // still running / not written yet
			if (this.reqOut > 0 && out === this.reqOut) {
				chosen = entry;
				break;
			}
			if (!chosen) chosen = entry; // best effort when pi reported no usage
			continue;
		}
		if (!chosen) return null;

		const out = firstNum(num(chosen.output_tokens), num(chosen.completion_tokens), num(chosen.generated)) ?? 0;
		const tg = firstNum(num(chosen.decode_tok_s), num(chosen.tok_s), num(chosen.decode_tps), num(chosen.eval_tok_s)) ?? 0;
		const ttftS = firstNum(num(chosen.ttft_s), num(chosen.time_to_first_token_s), num(chosen.ttft)) ?? 0;
		const durationS = firstNum(num(chosen.duration_s), num(chosen.elapsed_s)) ?? 0;
		const promptTokens = firstNum(num(chosen.prompt_tokens), num(chosen.prompt)) ?? 0;
		const reused = firstNum(num(chosen.reused), num(chosen.cached_tokens)) ?? 0;
		const promptMs = firstNum(num(chosen.prompt_ms), num(chosen.prefill_ms)) ?? 0;
		const fresh = promptTokens - reused;
		const pp = promptMs > 0 && fresh > 0 ? (fresh / promptMs) * 1000 : 0;
		const genSeconds = durationS > ttftS ? durationS - ttftS : out > 0 && tg > 0 ? out / tg : 0;
		const at = firstNum(num(chosen.time), num(chosen.timestamp)) ?? 0;

		return {
			tg,
			pp,
			ttftS,
			out: out > 0 ? out : this.reqOut,
			genSeconds,
			id: typeof chosen.id === "string" ? chosen.id : "",
			startMs: at < 1e12 ? at * 1000 : at,
			resolvedMs: Date.now(),
		};
	}

	// --- llama.cpp / ik_llama.cpp Prometheus ------------------------------

	/**
	 * Counters only. A speed is always a difference between two samples, so a
	 * finished request's speed comes from the counters sampled at its start and
	 * at (or just after) its end - the engine's own numbers, not our stopwatch.
	 */
	private readPrometheus(body: string): void {
		const counters = this.parseCounters(body);
		if (!counters) {
			this.kind = "prometheus";
			this.note = "no token counters in /metrics";
			return;
		}
		this.kind = "prometheus";
		this.note = "";

		if (this.prevCounters) {
			const dPred = counters.predTokens - this.prevCounters.predTokens;
			const dPredSec = counters.predSeconds - this.prevCounters.predSeconds;
			const dPrompt = counters.promptTokens - this.prevCounters.promptTokens;
			const dPromptSec = counters.promptSeconds - this.prevCounters.promptSeconds;
			// Only report a live rate while tokens are actually moving.
			if (dPred > 0 && dPredSec > 0.05) {
				this.liveTg = dPred / dPredSec;
				this.busyMs = this.busyMs || Date.now();
			} else if (dPrompt > 0 && dPromptSec > 0.05) {
				this.livePp = dPrompt / dPromptSec;
				this.busyMs = this.busyMs || Date.now();
			} else if (this.busyMs > 0 && Date.now() - this.busyMs > 1500) {
				this.busyMs = 0;
				this.liveTg = 0;
			}
		}
		this.prevCounters = counters;

		// attribute the finished request from its own counter window
		if (this.reqCounters && this.reqEndMs > 0 && this.reqTries < ATTRIBUTION_POLL_LIMIT) {
			this.reqTries++;
			const base = this.reqCounters;
			const dPred = counters.predTokens - base.predTokens;
			const dPredSec = counters.predSeconds - base.predSeconds;
			const dPrompt = counters.promptTokens - base.promptTokens;
			const dPromptSec = counters.promptSeconds - base.promptSeconds;
			const enoughTokens = this.reqOut > 0 ? dPred >= this.reqOut * 0.9 : dPred > 0;
			const triedEnough = this.reqTries >= 3;
			if (dPred > 0 && dPredSec > 0 && (enoughTokens || triedEnough)) {
				const fresh = dPrompt - (counters.cacheHits ?? 0); // cached tokens were never re-read
				this.lastFinal = {
					tg: dPred / dPredSec,
					pp: dPromptSec > 0.05 && fresh > 0 ? fresh / dPromptSec : dPromptSec > 0.05 ? dPrompt / dPromptSec : 0,
					ttftS: 0, // not a counter; pi's own TTFT stays on screen
					out: this.reqOut > 0 ? this.reqOut : dPred,
					genSeconds: dPredSec,
					id: "counters",
					startMs: base.at,
					resolvedMs: Date.now(),
				};
				this.reqEndMs = 0;
			}
		}
	}

	/** Pull the handful of counter names that matter out of a Prometheus body. */
	private parseCounters(body: string): (Counters & { cacheHits?: number | undefined }) | null {
		const values = new Map<string, number>();
		let cacheHits: number | undefined;
		for (const line of body.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
			const space = trimmed.lastIndexOf(" ");
			if (space <= 0) continue;
			const full = trimmed.slice(0, space);
			const value = Number(trimmed.slice(space + 1));
			if (!Number.isFinite(value)) continue;
			// Labels stay on the full key: cache hits live in their own
			// {source="cache_hit"} sample of the prompt-tokens counter, and collapsing
			// labels would mix that sample with the plain one.
			if (full.includes("source=\"cache_hit\"")) cacheHits = value;
			const name = full.split("{")[0] ?? full;
			if (!values.has(name)) values.set(name, value);
		}
		const pick = (...names: string[]): number | undefined => {
			for (const name of names) {
				const value = values.get(name);
				if (value !== undefined) return value;
			}
			return undefined;
		};
		const predTokens = pick("llamacpp:tokens_predicted_total", "llm:eval_tokens_total", "llm:tokens_predicted_total");
		const predSeconds = pick(
			"llamacpp:tokens_predicted_seconds_total",
			"llm:eval_seconds_total",
			"llm:predicted_tokens_seconds_total",
		);
		if (predTokens === undefined || predSeconds === undefined) return null;
		return {
			predTokens,
			predSeconds,
			promptTokens: pick("llamacpp:prompt_tokens_total", "llm:prompt_tokens_total") ?? 0,
			promptSeconds: pick("llamacpp:prompt_seconds_total", "llm:prompt_seconds_total") ?? 0,
			cacheHits,
			at: Date.now(),
		};
	}
}
