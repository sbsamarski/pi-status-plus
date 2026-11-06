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
	/** Tokens this request had to read: the prompt minus its cached part. */
	promptFresh: number;
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
	/** When that activity began in wall-clock ms (0 = idle). Lets the caller tell
	 *  "the engine is busy with something new" from "still finishing what we timed". */
	busySince: number;
	/** The activity right now is reading a prompt (so PP is the live rate and TG
	 *  is not). Engines keep reporting their prefill mean during decode, so the
	 *  caller cannot tell this from the numbers alone. */
	prefilling: boolean;
	/** The engine's own words for what it is doing ("idle", "reading", ...). */
	state: string;
	/** When the engine was last seen busy (wall-clock ms; 0 = never). */
	lastBusyMs: number;
	/** Is the reader actually polling right now? */
	watching: boolean;
	/** Prompt tokens read so far in the current prefill (0 = not reported). */
	prefillDone: number;
	/** Total prompt tokens of the current prefill (0 = not reported). */
	prefillTotal: number;
	/** Live decode speed, averaged over the window passed to view() (0 = none). */
	liveTg: number;
	/** Live prefill speed, averaged over the window passed to view(). */
	livePp: number;
	/** The same two rates as the engine read them this instant, unaveraged. */
	liveTgRaw: number;
	livePpRaw: number;
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

/** One live reading, kept so the instantaneous rate can be averaged over a window. */
interface LiveSample {
	t: number;
	/** Decode rate as the engine reported it at t. */
	tg: number;
	/** Prefill rate as the engine reported it at t. */
	pp: number;
	/** Output tokens counted so far, when the engine exposes such a counter. */
	tokens: number | null;
}

/** How far back live samples are kept (longer than any window we average over). */
const SAMPLE_RETENTION_MS = 60000;
/** Below this span a "window average" is one or two samples: show the raw rate. */
const MIN_SMOOTH_SPAN_MS = 250;
/** An engine that stops answering "busy" for less than this is still working:
 *  one poll reading "idle" in the middle of a stream must not end the activity,
 *  or every window and every number on the bar would stutter with it. */
const BUSY_GRACE_MS = 700;
/** How long the engine must be idle before the live sample series is dropped. */
const IDLE_SERIES_CLEAR_MS = 4000;
/** Keep polling fast this long after activity ended: the engine writes the
 *  finished request's record just after the stream closes, and the exact averages
 *  on the bar depend on reading it promptly. */
const FINISHED_LOOKUP_MS = 4000;

export class EngineProbe {
	private base = "";
	private name = "";
	private kind: "none" | "json" | "prometheus" = "none";
	private note = "";
	private reachable = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pollMs = 250;
	private busyMs = 0; // 0 = idle, else when the current activity began
	private liveTg = 0; // raw, as the engine said it this instant
	private livePp = 0;
	private liveState = "";
	private prefillingNow = false;
	private lastBusyAt = 0;
	private idleSince = 0;
	private lastAdoptedId = "";
	private prefillDone = 0;
	private prefillTotal = 0;
	private prefillCached = 0;
	private lastPrefillTokens = 0;
	/** Whether this poll's /metrics already contributed a live sample. */
	private sampledThisPoll = false;
	private lastFinal: EngineRequestNumbers | null = null;
	private samples: LiveSample[] = [];
	private lastTokens: number | null = null;

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
		this.samples = [];
		this.lastTokens = null;
		this.prefillDone = 0;
		this.prefillTotal = 0;
		this.prefillCached = 0;
		this.lastPrefillTokens = 0;
	}

	/** Is the reader polling? Lets the caller re-arm it without disturbing it. */
	watching(): boolean {
		return !this.stopped && this.base !== "";
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
		this.samples = []; // a new request must not be averaged with the previous one
		this.lastTokens = null;
		this.prefillDone = 0; // this request's prompt size is not known yet
		this.prefillTotal = 0;
		this.prefillCached = 0;
		this.lastPrefillTokens = 0; // the previous prompt's count is not this one's
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

	/**
	 * Current picture for the bar. Cheap: nothing is fetched here.
	 *
	 * `windowMs` averages the live rates over that many milliseconds of samples;
	 * 0 returns the engine's instantaneous reading. An engine's instantaneous
	 * decode rate is jumpy by nature (it is re-measured over a short recent span,
	 * and a chunk boundary or a speculative-draft miss moves it), so the bar
	 * passes its tgWindowMs here and the number it prints means what it says.
	 */
	view(windowMs = 0): EngineView {
		// Nothing to average while the engine is not working: the series still holds
		// the last activity's samples, and reporting their average as a live rate
		// would put a moving number on a bar that has nothing running.
		const smooth = windowMs >= MIN_SMOOTH_SPAN_MS && this.busyMs > 0;
		return {
			name: this.name || "engine",
			url: this.base,
			reachable: this.reachable,
			busy: this.busyMs > 0,
			busySince: this.busyMs,
			prefilling: this.prefillingNow,
			state: this.liveState || (this.prefillingNow ? "prefill" : ""),
			lastBusyMs: this.lastBusyAt,
			watching: !this.stopped && this.base !== "",
			liveTg: smooth ? this.smooth("tg", windowMs) : this.liveTg,
			// An engine that publishes a prefill mean (basalt, strata) is already
			// giving the exact average from the start of this prompt to this moment,
			// so that number is shown as it is: re-averaging it over a window would
			// keep moving for seconds after the prefill ended, which is a wrong
			// average, not a smoother one. Counter-only engines get the window.
			livePp: smooth && this.kind !== "json" ? this.smooth("pp", windowMs) : this.livePp,
			liveTgRaw: this.liveTg,
			livePpRaw: this.livePp,
			prefillDone: this.prefillDone,
			prefillTotal: this.prefillTotal,
			final: this.lastFinal,
			kind: this.kind,
			note: this.note,
		};
	}

	/** Remember what the engine said at this instant, for the window average. */
	private addSample(tg: number, pp: number, tokens: number | null): void {
		const now = Date.now();
		// A counter that went backwards is a new request or an engine restart; an
		// older sample would turn the delta negative, so the series starts over.
		this.idleSince = 0;
		if (tokens !== null && this.lastTokens !== null && tokens < this.lastTokens) this.samples = [];
		if (tokens !== null) this.lastTokens = tokens;
		this.samples.push({ t: now, tg, pp, tokens });
		const cutoff = now - SAMPLE_RETENTION_MS;
		while (this.samples.length > 2 && this.samples[0]!.t < cutoff) this.samples.shift();
	}

	/** Stop treating the previous request's readings as history. */
	private clearSamples(): void {
		if (this.samples.length > 0) this.samples = [];
		this.lastTokens = null;
	}

	/**
	 * The engine just said it is idle. Keep the series a while.
	 *
	 * Dropping it on the first idle reading looks tidy and is wrong in practice:
	 * engines blink "idle" between chunk groups, and each blink would throw the
	 * averaging window away and start it over - which makes the displayed average
	 * jump exactly as much as the raw rate did, the opposite of what a window is
	 * for. Only a sustained idle means the readings are history.
	 */
	private noteIdle(): void {
		if (this.idleSince === 0) this.idleSince = Date.now();
		if (Date.now() - this.idleSince > IDLE_SERIES_CLEAR_MS) this.clearSamples();
	}

	/**
	 * The engine's rate averaged over the last windowMs.
	 *
	 * Preferred, whenever the engine exposes an output-token counter: tokens
	 * counted inside the window divided by the window's own span. That IS "the
	 * average of the last five seconds", with no estimating involved.
	 *
	 * Fallback: the time-weighted mean of the instantaneous readings, which is the
	 * integral of the rate over the window divided by the window - the same
	 * answer, from readings instead of from a counter.
	 *
	 * Fewer than two samples (a window shorter than a few poll intervals) returns
	 * the raw reading, because there is nothing to average yet.
	 */
	private smooth(kind: "tg" | "pp", windowMs: number): number {
		const raw = kind === "tg" ? this.liveTg : this.livePp;
		const now = Date.now();
		const inWindow = this.samples.filter((s) => s.t >= now - windowMs);
		if (inWindow.length < 2) return raw;
		// The newest reading decides whether this rate exists at all. While the
		// engine reads a prompt it has no decode rate to report, and averaging the
		// last seconds of the previous decode into that moment would put a number on
		// the bar that describes nothing that is happening now.
		const latest = inWindow[inWindow.length - 1]!;
		if ((kind === "tg" ? latest.tg : latest.pp) === 0) return 0;
		// While the window is still filling, do not divide by what it has.
		// Each request's token counter starts from zero, so a partially filled
		// window is a genuine average over a short stretch - it climbs from the
		// first burst to the true rate, which on screen looks like a number jumping
		// every refresh for the first seconds of every request. The engine's own
		// recent rate is steadier and is still the engine's measurement, so the bar
		// shows that until the window is actually full, then the real window average.
		if (inWindow[0] !== undefined && latest.t - inWindow[0]!.t < windowMs * 0.8 && raw > 0) return raw;
		const first = inWindow[0]!;
		const last = inWindow[inWindow.length - 1]!;
		const span = last.t - first.t;

		// The counter method needs a real span: over a few hundred ms a speculative
		// engine hands out tokens in bursts and the delta is a burst, not a rate.
		const minSpan = Math.max(MIN_SMOOTH_SPAN_MS, Math.min(1000, windowMs / 2));
		if (kind === "tg" && span >= minSpan && first.tokens !== null && last.tokens !== null) {
			let monotonic = true;
			for (let i = 1; i < inWindow.length; i++) {
				const prev = inWindow[i - 1]!.tokens;
				const cur = inWindow[i]!.tokens;
				if (prev === null || cur === null || cur < prev) {
					monotonic = false;
					break;
				}
			}
			const delta = last.tokens - first.tokens;
			if (monotonic && delta >= 1) return (delta / span) * 1000;
		}

		let weighted = 0;
		let weights = 0;
		for (let i = 0; i < inWindow.length; i++) {
			const endT = i + 1 < inWindow.length ? inWindow[i + 1]!.t : Math.max(now, last.t);
			const weight = endT - inWindow[i]!.t;
			const value = kind === "tg" ? inWindow[i]!.tg : inWindow[i]!.pp;
			// Zero readings are the prefill phase for TG (and vice versa): they
			// belong to a different number, so they must not dilute this average.
			if (weight > 0 && value > 0) {
				weighted += value * weight;
				weights += weight;
			}
		}
		return weights > 0 ? weighted / weights : raw;
	}

	/** Tokens generated in the current request, when the engine tells us. */
	private requestTokens(data: Record<string, unknown>): number | null {
		const live = (data.live ?? data.status ?? {}) as Record<string, unknown>;
		const fromLive = num(live.generated) ?? num(live.output_tokens);
		if (fromLive !== undefined) return fromLive;
		if (Array.isArray(data.slots)) {
			for (const slot of data.slots) {
				const generated = num((slot as Record<string, unknown>)?.generated);
				if (generated !== undefined) return generated;
			}
		}
		return null;
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
		// Just finished: the engine is about to write the record with the exact
		// averages, so stay fast instead of dropping to the idle cadence.
		if (Date.now() - this.lastBusyAt < FINISHED_LOOKUP_MS) return this.pollMs;
		return Math.max(this.pollMs * 6, 1500); // long idle: stay cheap, still notice restarts
	}

	private async poll(): Promise<void> {
		if (this.stopped) return;
		try {
			if (!this.name || Date.now() - this.nameCheckedAt > 300000) await this.identify();
			this.sampledThisPoll = false; // one live sample per poll, whoever reports it
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
			// Slot state is worth reading even with no /metrics: it is how a busy
			// engine is noticed at all when the engine publishes no counters.
			await this.readSlots();
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
		if (busy) {
			this.lastBusyAt = Date.now();
			if (this.busyMs === 0) this.busyMs = this.lastBusyAt;
		} else if (this.busyMs > 0 && Date.now() - this.lastBusyAt > BUSY_GRACE_MS) {
			this.busyMs = 0;
		}
		const active = busy || Date.now() - this.lastBusyAt <= BUSY_GRACE_MS;
		// Reading a prompt: there is no decode rate yet, and the engine says so by
		// leaving tok_s empty. Do not carry the previous request's rate into that.
		const prefilling = /read|prefill|prompt|queue|load/.test(state);
		this.prefillingNow = prefilling && busy;
		this.liveTg = prefilling ? 0 : (num(live.tok_s) ?? this.slotLiveTg(data) ?? (active ? this.liveTg : 0));
		// The engine's prefill mean outlives the prefill itself (it describes the
		// prompt that was just read), so PP stays on the bar during decode too.
		this.livePp = num(live.prefill_tok_s_mean) ?? num(live.prefill_tok_s) ?? (active ? this.livePp : 0);
		if (busy) {
			this.addSample(this.liveTg, this.livePp, this.requestTokens(data));
			this.sampledThisPoll = true;
		} else this.noteIdle();

		// the request that just finished, if the engine has written its entry
		this.adoptFinishedActivity(data);

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

	/**
	 * Adopt whatever the engine did last, even when it was not our request.
	 *
	 * A compaction, a session summary or another client's call never reaches
	 * beginRequest(), so nothing attributes it - and without this the bar would
	 * keep showing whatever live average was on screen when it ended, which is a
	 * window average, not the start-to-end average the finished numbers must be.
	 * The engine wrote the exact figures into its own record, so take those.
	 */
	private adoptFinishedActivity(data: Record<string, unknown>): void {
		if (this.busyMs > 0 || this.lastBusyAt === 0) return;
		const list = data.requests;
		if (!Array.isArray(list) || list.length === 0) return;
		const newest = list[0] as Record<string, unknown>;
		const id = typeof newest.id === "string" ? newest.id : "";
		if (id !== "" && id === this.lastAdoptedId) return;
		const numbers = this.requestNumbers(newest);
		if (!numbers || numbers.tg <= 0) return; // still running or not written yet
		this.lastAdoptedId = id;
		this.lastFinal = numbers;
		// The engine's own record is the exact figure for a prompt that finished
		// without us watching the slot, so it wins over whatever the slot guessed.
		if (numbers.promptFresh > 0) this.lastPrefillTokens = numbers.promptFresh;
	}

	/** /slots carries the same live numbers on engines without a live block. */
	/**
	 * /slots: the prefill's own progress, and a second opinion on "busy".
	 *
	 * basalt and strata count the prompt as they read it (prefill_done of
	 * prompt_tokens), which is the two numbers the bar shows beside PP - /metrics
	 * does not carry them. The slot's is_processing flag matters just as much:
	 * the live block of /metrics is one field's opinion, and a request from
	 * another client (a compaction summary goes direct, not through pi) must not
	 * become invisible because that one field stayed quiet for a moment.
	 */
	private async readSlots(): Promise<void> {
		const body = await this.fetchText("/slots");
		if (body === undefined) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return;
		}
		if (!Array.isArray(parsed)) return;
		let done = 0;
		let total = 0;
		let cached = 0;
		let working = false;
		let slotState = "";
		for (const entry of parsed) {
			const slot = entry as Record<string, unknown>;
			const promptTokens = num(slot.prompt_tokens) ?? 0;
			if (promptTokens > total) {
				total = promptTokens;
				done = num(slot.prefill_done) ?? 0;
				cached = num(slot.reused) ?? 0;
			}
			if (slot.is_processing === true) working = true;
			if (typeof slot.state === "string" && slot.state.toLowerCase() !== "idle") working = true;
			if (typeof slot.state === "string") slotState = slot.state.toLowerCase();
		}
		if (total > 0) {
			this.prefillTotal = total;
			this.prefillDone = Math.max(0, Math.min(done, total));
			this.prefillCached = Math.min(cached, total);
			// The figure that still means something after the read finishes: what this
			// prompt had to actually read. The slot knows the whole prompt and the
			// cached part from the first moment, so this is known before the read ends.
			const fresh = total - this.prefillCached;
			if (fresh > 0) this.lastPrefillTokens = fresh;
		} else if (!working) {
			this.prefillDone = 0;
			this.prefillTotal = 0;
		}
		if (!working) return;
		this.idleSince = 0;
		this.lastBusyAt = Date.now();
		if (this.busyMs === 0) this.busyMs = this.lastBusyAt;
		// A slot named "prefill"/"reading" is reading the prompt even if the live
		// block called this second something else.
		if (/^prefill|^read|^prompt/.test(slotState)) {
			this.prefillingNow = true;
			this.liveTg = 0;
		}
		// Keep one sample per poll: a poll whose /metrics said nothing still gets a
		// reading, so the averaging window covers this slice of time.
		if (!this.sampledThisPoll) this.addSample(this.liveTg, this.livePp, this.lastTokens);
	}

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
		const numbers = this.requestNumbers(chosen);
		if (!numbers) return null;
		if (numbers.out <= 0 && this.reqOut > 0) numbers.out = this.reqOut;
		this.lastAdoptedId = numbers.id; // do not adopt the same record again later
		return numbers;
	}

	/**
	 * One finished engine record, in the numbers the bar needs. Returns null while
	 * the request is still running (no decode rate written yet).
	 *
	 * These are the engine's own start-to-end figures: decode_tok_s is output
	 * tokens over the whole decode phase, and PP is the fresh prompt tokens (the
	 * cached part never re-read) over the time the prompt actually took. Nothing
	 * here is averaged over a trailing window, so a finished number is the real
	 * average of that request and nothing else.
	 */
	private requestNumbers(entry: Record<string, unknown>): EngineRequestNumbers | null {
		const out = firstNum(num(entry.output_tokens), num(entry.completion_tokens), num(entry.generated)) ?? 0;
		const tg = firstNum(num(entry.decode_tok_s), num(entry.tok_s), num(entry.decode_tps), num(entry.eval_tok_s)) ?? 0;
		const ttftS = firstNum(num(entry.ttft_s), num(entry.time_to_first_token_s), num(entry.ttft)) ?? 0;
		const durationS = firstNum(num(entry.duration_s), num(entry.elapsed_s)) ?? 0;
		const promptTokens = firstNum(num(entry.prompt_tokens), num(entry.prompt)) ?? 0;
		const reused = firstNum(num(entry.reused), num(entry.cached_tokens)) ?? 0;
		const promptMs = firstNum(num(entry.prompt_ms), num(entry.prefill_ms)) ?? 0;
		const fresh = promptTokens - reused;
		const pp = promptMs > 0 && fresh > 0 ? (fresh / promptMs) * 1000 : 0;
		const genSeconds = durationS > ttftS ? durationS - ttftS : out > 0 && tg > 0 ? out / tg : 0;
		const at = firstNum(num(entry.time), num(entry.timestamp)) ?? 0;

		return {
			tg,
			pp,
			ttftS,
			out,
			promptFresh: fresh > 0 ? fresh : promptTokens,
			genSeconds,
			id: typeof entry.id === "string" ? entry.id : "",
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
				this.prefillingNow = false;
				this.busyMs = this.busyMs || Date.now();
			} else if (dPrompt > 0 && dPromptSec > 0.05) {
				this.livePp = dPrompt / dPromptSec;
				this.prefillingNow = true; // prompt counters moved, decode did not
				this.busyMs = this.busyMs || Date.now();
			} else if (this.busyMs > 0 && Date.now() - this.busyMs > 1500) {
				this.busyMs = 0;
				this.liveTg = 0;
				this.prefillingNow = false;
			}
		}
		this.prevCounters = counters;
		if (this.busyMs > 0) {
			this.addSample(this.liveTg, this.livePp, counters.predTokens);
			this.sampledThisPoll = true;
		} else this.noteIdle();

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
					promptFresh: fresh > 0 ? fresh : dPrompt,
					genSeconds: dPredSec,
					id: "counters",
					startMs: base.at,
					resolvedMs: Date.now(),
				};
				// What that prompt really had to read, from the counter difference.
				if (fresh > 0) this.lastPrefillTokens = fresh;
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
