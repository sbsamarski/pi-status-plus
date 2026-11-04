/**
 * pi-status-plus — speed engine.
 *
 * All measurements come from pi-visible events only (no llama-server timings,
 * which pi never receives). Per assistant message:
 *   t0      — message_start timestamp (request send time, wall clock)
 *   firstAt — first generation event (text/thinking/toolcall start or delta)
 *   endAt   — message_end time
 *
 * Two TG quantities (per assistant message, tokens = usage.output):
 *   window — tokens in the last tgWindowMs seconds: the average of the recent
 *            stretch, what the bar shows live while the engine generates.
 *   gen    — output / (endAt - firstAt): the average over the whole generation,
 *            the same math llama-server uses for its final "eval rate" printout.
 *
 * The time base is generation, always. Dividing output tokens by the whole
 * request (the prefill wait included) used to be offered as a "wall" mode; it is
 * gone, because it reported a speed for a period in which the engine wrote no
 * tokens, and the figure moved with prompt size instead of with writing speed.
 *
 * PP speed: usage.input / (firstAt - t0) — new (non-cached) prompt tokens
 * over the prefill wait. A fully cached prefix makes this look very fast because
 * cached tokens are never re-read.
 *
 * The "N tok in S s" pair uses the same generation time, so its implied rate
 * equals the gen speed exactly.
 *
 * alignModes "match" keeps the two consistent: the window speed live, the gen
 * average once the response is finished, always matching the pair. "off" shows
 * whatever tgMode names.
 */

/** One windowed token event. */
interface TokenEvent {
	time: number;
	tokens: number;
}

/**
 * Event history cap. Events are appended once per delta burst; 120000 covers a
 * 60 s window at ~2000 t/s (far beyond any real rate), and even a 10-minute
 * generation at 100 t/s stays fully in memory (~few MB).
 */
const MAX_EVENTS = 120000;
const MIN_WINDOW_SPAN = 100; // ms, floor for window span (same as pi-token-speed)

export class SpeedEngine {
	// --- stream state ---------------------------------------------------------
	private streaming = false;
	private paused = false;
	private pauseStart = 0;

	// timestamps (ms, Date.now())
	private t0 = 0; // request send (message_start)
	private firstAt = 0; // first generation event
	private endAt = 0; // message end
	private pausedMs = 0;

	// counters
	private countedTokens = 0; // from deltas / usage diffs (weighted)
	private deltaCount = 0; // raw generation events received this stream
	private deltaTokenRatio = 1; // learned: true tokens per generation event
	private countedUsageOutput = 0; // cumulative provider output seen
	private finalTokens = 0; // authoritative usage.output
	private finalInput = 0;

	// windowed measurement
	private events: TokenEvent[] = [];

	/** Reset all state for a new stream (assistant message_start). */
	start(t0: number): void {
		this.streaming = true;
		this.paused = false;
		this.pauseStart = 0;
		this.t0 = t0;
		this.firstAt = 0;
		this.endAt = 0;
		this.pausedMs = 0;
		this.countedTokens = 0;
		this.deltaCount = 0;
		this.countedUsageOutput = 0;
		this.finalTokens = 0;
		this.finalInput = 0;
		this.events = [];
	}

	/** Record the first generation event time (once per stream). */
	markFirst(now: number): void {
		if (this.streaming && this.firstAt === 0) this.firstAt = now;
	}

	get startTime(): number {
		return this.t0;
	}

	get endTime(): number {
		return this.endAt;
	}

	get firstTime(): number {
		return this.firstAt;
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	/** Tokens counted so far this stream (deltas or usage diffs). */
	get counted(): number {
		return this.countedTokens;
	}

	/** Authoritative token counts from message_end usage. */
	get outputTokens(): number {
		return this.finalTokens;
	}

	get inputTokens(): number {
		return this.finalInput;
	}

	/**
	 * Record generation tokens (from a delta or provider usage). When
	 * useProvider is true and cumulative usage is available, the diff against
	 * the previous cumulative value is recorded. Otherwise the delta is
	 * weighted by the learned tokens-per-event ratio: a generation event is
	 * NOT always one token — some providers pack several tokens into one
	 * chunk. The ratio is learned at each message end (true usage.output /
	 * raw event count) and carried across messages, so the live window speed
	 * converges on the real token rate even for chunk-packing providers.
	 */
	recordTokens(tokens: number, usageOutput: number | undefined, useProvider: boolean): void {
		if (!this.streaming) return;
		if (this.paused) this.resume();
		let handledByProvider = false;
		if (useProvider && usageOutput !== undefined && usageOutput > this.countedUsageOutput) {
			this.addTokens(usageOutput - this.countedUsageOutput, false);
			this.countedUsageOutput = usageOutput;
			handledByProvider = true;
		}
		if (!handledByProvider && tokens > 0) this.addTokens(tokens * this.deltaTokenRatio, true);
	}

	/** Snap totals to the authoritative message_end usage. */
	reconcile(output: number, input: number): void {
		this.finalTokens = output;
		this.finalInput = input;
		if (output > 0 && this.deltaCount > 0) {
			const ratio = output / this.deltaCount;
			if (Number.isFinite(ratio) && ratio > 0) {
				this.deltaTokenRatio = Math.min(50, Math.max(0.1, ratio));
			}
		}
	}

	/** Learned tokens per generation event (1 for strict per-token streamers). */
	get learnedTokensPerEvent(): number {
		return this.deltaTokenRatio;
	}

	/** Called on message_end. */
	stop(endTime: number): void {
		if (this.paused) this.resume();
		this.streaming = false;
		this.endAt = endTime;
	}

	/** Pause timers while a prompt-processing tool executes. */
	pause(): void {
		if (!this.streaming || this.paused) return;
		this.paused = true;
		this.pauseStart = Date.now();
	}

	private resume(): void {
		if (!this.paused) return;
		this.paused = false;
		this.pausedMs += Date.now() - this.pauseStart;
	}

	private addTokens(tokens: number, isDeltaEvent: boolean): void {
		if (tokens <= 0) return;
		const now = Date.now();
		this.countedTokens += tokens;
		if (isDeltaEvent) this.deltaCount += 1;
		if (this.firstAt === 0) this.firstAt = now;
		this.events.push({ time: now, tokens });
		if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
	}

	// --- derived values -------------------------------------------------------

	/** Elapsed time from→to minus paused time; never negative. */
	private elapsedBetween(from: number, to: number): number {
		const span = to - from - this.pausedMs;
		return span > 0 ? span : 0;
	}

	/** Current effective end time (now while streaming, endAt after). */
	private currentTime(): number {
		return this.streaming ? Date.now() : this.endAt;
	}

	/** Tokens to use: authoritative usage once known, else the counted deltas. */
	private pairTokens(tokenSource: "provider" | "estimate"): number {
		if (tokenSource === "provider") return this.finalTokens > 0 ? this.finalTokens : this.countedTokens;
		return this.countedTokens;
	}

	/** Windowed TG: tokens in the last windowMs divided by actual span. */
	tgWindow(windowMs: number): number {
		if (this.events.length === 0) return 0;
		const now = Date.now();
		const windowStart = now - windowMs;

		// Binary search for the first event at/after windowStart (events are
		// appended in time order), so even a 60000 ms window costs O(log n).
		let lo = 0;
		let hi = this.events.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.events[mid]!.time >= windowStart) hi = mid;
			else lo = mid + 1;
		}
		const index = lo;
		if (index >= this.events.length) return 0;

		let tokens = 0;
		for (let i = index; i < this.events.length; i++) {
			tokens += this.events[i]!.tokens;
		}
		if (tokens <= 0) return 0;

		// All events sharing one timestamp (post-stall burst): include the gap before it.
		let spanStart = this.events[index]!.time;
		if (spanStart === this.events[this.events.length - 1]!.time && index > 0) {
			spanStart = this.events[index - 1]!.time;
		}
		const span = Math.max(now - spanStart, MIN_WINDOW_SPAN);
		return (tokens / span) * 1000;
	}

	/** Generation-only TG: output / (first token → end). 0 when unknown. */
	tgGen(): number {
		if (this.finalTokens <= 0 || this.firstAt === 0) return 0;
		const genMs = this.elapsedBetween(this.firstAt, Math.max(this.currentTime(), this.firstAt));
		if (genMs <= 0) return 0;
		return (this.finalTokens / genMs) * 1000;
	}

	/**
	 * The TG speed to display. alignModes "match" keeps the speed and the pair on
	 * the same time base: the window average live, the whole-generation average
	 * once the response is finished. "off" shows whatever tgMode names. While a
	 * stream is running the authoritative usage may not have arrived yet, so match
	 * uses the window until it has.
	 */
	tgDisplayed(windowMs: number, tgMode: "window" | "final", align: "off" | "match"): number {
		if (align === "match") {
			if (this.finalTokens <= 0) return this.tgWindow(windowMs);
			return this.tgGen();
		}
		return tgMode === "final" ? this.tgGen() : this.tgWindow(windowMs);
	}

	/**
	 * The "N tok in S s" pair: output tokens over generation time, the same span
	 * tgGen divides by, so the pair's implied rate and the speed agree.
	 */
	statsPair(tokenSource: "provider" | "estimate"): { tokens: number; seconds: number } {
		const tokens = this.pairTokens(tokenSource);
		if (tokens <= 0) return { tokens: 0, seconds: 0 };
		if (this.firstAt === 0) return { tokens: 0, seconds: 0 };
		const genMs = this.elapsedBetween(this.firstAt, Math.max(this.currentTime(), this.firstAt));
		return { tokens, seconds: genMs / 1000 };
	}

	/**
	 * PP speed: input tokens / prefill time (request to first token).
	 * Prefill runs before generation starts, so tool pauses (which only
	 * happen during generation) do not apply within it.
	 */
	ppSpeed(): number {
		if (this.finalInput <= 0 || this.t0 === 0 || this.firstAt === 0) return 0;
		const prefillMs = this.firstAt - this.t0;
		if (prefillMs <= 0) return 0;
		return (this.finalInput / prefillMs) * 1000;
	}

	/** TTFT in milliseconds (request to first token), 0 when unknown. */
	ttftMs(): number {
		if (this.t0 === 0 || this.firstAt === 0) return 0;
		return Math.max(this.firstAt - this.t0, 0);
	}
}
