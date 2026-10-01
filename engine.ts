/**
 * pi-status-plus — speed engine.
 *
 * All measurements come from pi-visible events only (no llama-server timings,
 * which pi never receives). Per assistant message:
 *   t0      — message_start timestamp (request send time, wall clock)
 *   firstAt — first generation event (text/thinking/toolcall start or delta)
 *   endAt   — message_end time
 *
 * Three TG quantities (per assistant message, tokens = usage.output):
 *   window — tokens in the last tgWindowMs / window seconds. Instantaneous,
 *            close to what llama-server prints live while generating.
 *   gen    — output / (endAt - firstAt): generation-only speed, the same math
 *            llama-server uses for its final "eval rate" printout.
 *   wall   — output / (t0 → endAt): the old pi-token-speed "average" TPS.
 *            Lower than gen because the prefill wait (TTFT) is included.
 *
 * PP speed: usage.input / (firstAt - t0) — new (non-cached) prompt tokens
 * over the prefill wait. Same math as pi-stamp-lite. A fully cached prefix
 * makes this look very fast because cached tokens are never re-read.
 *
 * The "N tok in S s" pair:
 *   gen  — output tokens over (endAt - firstAt): generation-only, so its math
 *          equals the gen speed exactly.
 *   wall — output tokens over (t0 → endAt): its math equals the wall speed
 *          exactly (this is the pair the old tps extension showed with
 *          endTpsBehavior "average").
 *
 * alignModes "match" displays the TG speed whose math equals the chosen
 * statsMode pair (gen pair ↔ gen speed, wall pair ↔ wall speed), so the two
 * numbers on screen always agree. "off" displays the configured tgMode.
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

	/** Wall TG: output / (request → end), the old tps "average". 0 when unknown. */
	tgWall(): number {
		if (this.finalTokens <= 0 || this.t0 === 0) return 0;
		const wallMs = this.elapsedBetween(this.t0, Math.max(this.currentTime(), this.t0));
		if (wallMs <= 0) return 0;
		return (this.finalTokens / wallMs) * 1000;
	}

	/**
	 * The TG speed to display. alignModes "match" keeps the displayed speed
	 * consistent with the "N tok in S s" pair (gen pair ↔ gen speed, wall pair
	 * ↔ wall speed); "off" always shows the configured tgMode. While a stream
	 * is still running the authoritative usage may not be known yet, so match
	 * falls back to the window speed live and switches to the matching final
	 * math once usage arrives.
	 */
	tgDisplayed(windowMs: number, tgMode: "window" | "final", statsMode: "wall" | "gen", align: "off" | "match"): number {
		if (align === "match") {
			if (this.finalTokens <= 0) return this.tgWindow(windowMs);
			return statsMode === "gen" ? this.tgGen() : this.tgWall();
		}
		return tgMode === "final" ? this.tgGen() : this.tgWindow(windowMs);
	}

	/**
	 * The "N tok in S s" pair: tokens and elapsed seconds for the statsMode.
	 *   gen  — output tokens over generation time (matches tgGen)
	 *   wall — output tokens over the whole stream (matches tgWall)
	 */
	statsPair(tokenSource: "provider" | "estimate", statsMode: "wall" | "gen"): { tokens: number; seconds: number } {
		const tokens = this.pairTokens(tokenSource);
		if (tokens <= 0) return { tokens: 0, seconds: 0 };
		if (statsMode === "gen") {
			if (this.firstAt === 0) return { tokens: 0, seconds: 0 };
			const genMs = this.elapsedBetween(this.firstAt, Math.max(this.currentTime(), this.firstAt));
			return { tokens, seconds: genMs / 1000 };
		}
		if (this.t0 === 0) return { tokens: 0, seconds: 0 };
		const wallMs = this.elapsedBetween(this.t0, Math.max(this.currentTime(), this.t0));
		return { tokens, seconds: wallMs / 1000 };
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
