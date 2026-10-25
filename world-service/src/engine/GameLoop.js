/**
 * GameLoop: Fixed-frequency authoritative simulation ticker (20 Hz / 50ms).
 */

export class GameLoop {
  /**
   * @param {object} world Instance of World
   * @param {Function} onSync Callback invoked on each tick with synchronization payload
   * @param {number} [tickIntervalMs=50] Interval between ticks in milliseconds
   * @param {object} [options]
   * @param {number} [options.maxDeltaTicks=2] Longest simulation step, in tick intervals
   */
  constructor(world, onSync, tickIntervalMs = 50, options = {}) {
    this.world = world;
    this.onSync = onSync;
    this.tickIntervalMs = tickIntervalMs;

    // setInterval only guarantees "not before"; a blocked event loop (GC pause, CPU
    // contention, disk I/O, a suspended host) makes a callback arrive arbitrarily late.
    // Feeding that raw elapsed time to the physics would advance every moving entity by
    // speed * elapsed in a single step, teleporting the whole world forward at once.
    // Clamping trades a little time dilation during a hiccup for never teleporting.
    this.maxDeltaTicks = options.maxDeltaTicks ?? 2;
    this.maxDeltaSeconds = (this.tickIntervalMs * this.maxDeltaTicks) / 1000;

    this.timer = null;
    this.isRunning = false;
    this.lastTickTime = 0;

    // Diagnostics for stalls that had to be clamped
    this.clampedTickCount = 0;
    this.worstStallMs = 0;
    this._lastStallLogAt = 0;

    // Rolling performance window for the monitoring dashboard. A bounded ring buffer
    // keeps the cost of instrumentation constant regardless of how long a world runs.
    this.perfWindowSize = options.perfWindowSize ?? 200;
    this._durationSamples = new Float64Array(this.perfWindowSize);
    this._sampleCount = 0;
    this._sampleCursor = 0;
    this.totalTicks = 0;
    this.startedAt = 0;

    // Lifetime tick rate is nearly immune to a stall that starts after hours of
    // healthy running, which is exactly when an operator needs to see one. A sliding
    // window reports the rate the loop is sustaining *now*.
    this.recentWindowMs = options.recentWindowMs ?? 10000;
    this.recentHz = null;
    this._windowStartedAt = 0;
    this._windowTicks = 0;
  }

  /**
   * Starts the game loop.
   */
  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    this.lastTickTime = Date.now();
    this.startedAt = Date.now();
    this._windowStartedAt = this.startedAt;
    this._windowTicks = 0;

    this.timer = setInterval(() => {
      this.tick();
    }, this.tickIntervalMs);

    console.log(`[GameLoop] Started at ${1000 / this.tickIntervalMs} Hz (${this.tickIntervalMs}ms interval)`);
  }

  /**
   * Performs a single simulation step.
   */
  tick() {
    if (!this.isRunning) return;

    const tickStartedAt = performance.now();

    try {
      const now = Date.now();
      const elapsedMs = now - this.lastTickTime;
      this.lastTickTime = now;

      // Guard against a stalled event loop or a clock that jumped backwards.
      const rawDelta = elapsedMs > 0 ? elapsedMs / 1000 : this.tickIntervalMs / 1000;
      const deltaTime = Math.min(rawDelta, this.maxDeltaSeconds);

      if (rawDelta > this.maxDeltaSeconds) {
        this.clampedTickCount++;
        if (elapsedMs > this.worstStallMs) this.worstStallMs = elapsedMs;
        // Rate limited so a sustained stall cannot itself flood the log
        if (now - this._lastStallLogAt > 5000) {
          this._lastStallLogAt = now;
          console.warn(
            `[GameLoop] Tick arrived ${Math.round(elapsedMs)}ms late (expected ${this.tickIntervalMs}ms). ` +
              `Clamping simulation step to ${Math.round(this.maxDeltaSeconds * 1000)}ms to avoid teleporting entities. ` +
              `(${this.clampedTickCount} clamped ticks so far, worst ${Math.round(this.worstStallMs)}ms)`
          );
        }
      }

      // 1. Advance physics and world simulation
      this.world.tick(deltaTime);

      // 2. Broadcast STATE_SYNC to all clients
      if (typeof this.onSync === 'function') {
        const syncState = this.world.getSyncState();
        this.onSync(syncState);
      }
    } catch (err) {
      console.error('[GameLoop] Error during tick:', err);
    } finally {
      // Recorded in `finally` so a throwing tick still counts as work performed:
      // a loop that fails slowly is exactly what the dashboard needs to surface.
      this._recordTickDuration(performance.now() - tickStartedAt);
    }
  }

  /**
   * Stores one tick duration in the rolling window.
   * @param {number} durationMs
   */
  _recordTickDuration(durationMs) {
    this._durationSamples[this._sampleCursor] = durationMs;
    this._sampleCursor = (this._sampleCursor + 1) % this.perfWindowSize;
    if (this._sampleCount < this.perfWindowSize) this._sampleCount++;
    this.totalTicks++;

    // The window closes on a tick boundary rather than on read, so the reported rate
    // does not vary with how often the dashboard happens to scrape.
    this._windowTicks++;
    const windowAgeMs = Date.now() - this._windowStartedAt;
    if (windowAgeMs >= this.recentWindowMs) {
      this.recentHz = (this._windowTicks / windowAgeMs) * 1000;
      this._windowTicks = 0;
      this._windowStartedAt = Date.now();
    }
  }

  /**
   * Returns the current performance profile of the loop.
   *
   * `effectiveHz` is measured from wall-clock elapsed time and total ticks, so it
   * reflects ticks the runtime actually delivered — not the rate that was requested.
   * @returns {object}
   */
  getStats() {
    const samples = this._durationSamples.slice(0, this._sampleCount);
    const sorted = Array.from(samples).sort((a, b) => a - b);
    const uptimeSeconds = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;

    const percentile = (p) => {
      if (!sorted.length) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return sorted[idx];
    };

    const avgDuration = sorted.length
      ? sorted.reduce((acc, v) => acc + v, 0) / sorted.length
      : 0;

    return {
      isRunning: this.isRunning,
      targetHz: round(1000 / this.tickIntervalMs, 2),
      intervalMs: this.tickIntervalMs,
      effectiveHz: uptimeSeconds > 0 ? round(this.totalTicks / uptimeSeconds, 2) : 0,
      recentHz: this.recentHz !== null ? round(this.recentHz, 2) : null,
      recentWindowMs: this.recentWindowMs,
      totalTicks: this.totalTicks,
      uptimeSeconds: round(uptimeSeconds, 1),
      avgDurationMs: round(avgDuration, 3),
      p95DurationMs: round(percentile(95), 3),
      maxDurationMs: round(sorted.length ? sorted[sorted.length - 1] : 0, 3),
      // Share of the 50ms budget spent simulating; above 100% the loop cannot keep up.
      budgetUtilizationPct: round((avgDuration / this.tickIntervalMs) * 100, 1),
      clampedTickCount: this.clampedTickCount,
      worstStallMs: round(this.worstStallMs, 0),
      sampleCount: this._sampleCount,
    };
  }

  /**
   * Stops the game loop.
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    console.log('[GameLoop] Stopped.');
  }
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
