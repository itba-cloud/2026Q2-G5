/**
 * MetricsCollector: Pull-mode telemetry store (TELEMETRY_MODE=pull). Periodically
 * scrapes every running world and the NPC service, and keeps a bounded in-memory
 * time series of the fleet. Meant for local development: in AWS the worlds push to
 * the Kinesis pipeline and DynamoDbTelemetryStore serves the same contract stateless.
 *
 * The collector is deliberately read-only with respect to the rest of the control
 * plane: it reads the repository, polls read-only HTTP endpoints, and never mutates
 * world or host records. A scrape failure degrades one world's row to
 * `reachable: false` and never propagates.
 */

import { CostEstimator } from './CostEstimator.js';
import { buildSnapshot, toHistoryPoint, round } from './SnapshotBuilder.js';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_HISTORY_POINTS = 180; // 15 min at 5s
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_STALE_AFTER_FAILURES = 2;
/** Smallest uptime drop that can mean a restart rather than an out-of-order reading. */
const MIN_RESTART_DROP_SECONDS = 2;

export class MetricsCollector {
  /**
   * @param {object} params
   * @param {{ listWorlds(): Promise<object[]>, listHosts(): Promise<object[]> }} params.repository Source of the world and host registry
   * @param {object} params.config Metrics service configuration
   */
  constructor({ repository, config }) {
    this.repository = repository;
    this.config = config;

    const metricsConfig = config?.metrics || {};
    this.intervalMs = metricsConfig.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.historyPoints = metricsConfig.historyPoints ?? DEFAULT_HISTORY_POINTS;
    this.timeoutMs = metricsConfig.scrapeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Consecutive failures tolerated before a world's metrics are discarded. One blip
    // should not blank the row, but a dead container must not keep serving its last
    // reading as if it were live.
    this.staleAfterFailures = metricsConfig.staleAfterFailures ?? DEFAULT_STALE_AFTER_FAILURES;
    this.npcServiceUrl = config?.npcServiceUrl || 'http://127.0.0.1:5001';

    this.costEstimator = new CostEstimator(config?.pricing);

    this.timer = null;
    this.isRunning = false;
    /** @type {Promise<object>|null} the cycle currently in flight, if any */
    this._inFlight = null;
    this.startedAt = null;
    this.lastScrapeDurationMs = 0;
    this.scrapeCount = 0;

    /** @type {Map<string, object>} worldId -> last successful scrape */
    this.worldSamples = new Map();
    /** @type {Map<string, number>} worldId -> consecutive failed scrapes */
    this.scrapeFailures = new Map();
    /** @type {Map<string, number>} worldId -> billed seconds from sessions already finished */
    this.completedActiveSeconds = new Map();
    /** @type {Map<string, number>} worldId -> uptime reported by the running container */
    this.currentSessionSeconds = new Map();
    /** @type {object[]} bounded fleet time series */
    this.history = [];
    /** @type {object|null} last NPC service payload */
    this.npcSample = null;
    /** @type {object|null} last full snapshot, served to HTTP callers */
    this.lastSnapshot = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = Date.now();

    // Prime the first sample immediately so the dashboard is not blank on first load.
    this.collect().catch((err) => {
      console.warn('[MetricsCollector] Initial collection failed:', err.message);
    });

    this.timer = setInterval(() => {
      this.collect().catch((err) => {
        console.warn('[MetricsCollector] Collection cycle failed:', err.message);
      });
    }, this.intervalMs);

    // Never hold the process open on account of telemetry.
    if (typeof this.timer.unref === 'function') this.timer.unref();

    console.log(`[MetricsCollector] Started. Scraping every ${this.intervalMs}ms, retaining ${this.historyPoints} points.`);
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[MetricsCollector] Stopped.');
  }

  /**
   * Fetches JSON from a URL, resolving to null on any failure or timeout.
   * @param {string} url
   * @returns {Promise<object|null>}
   */
  async _fetchJson(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * Resolves the address the lobby should use to reach a world's HTTP endpoint.
   * Mirrors HostPlacementEngine._waitForWorldReady so both agree on the target.
   * @param {object} host
   * @param {number} port
   * @returns {string}
   */
  _worldMetricsUrl(host, port) {
    const hostIp = host?.hostIp;
    const target = !hostIp || hostIp === '0.0.0.0' || hostIp === '127.0.0.1' ? '127.0.0.1' : hostIp;
    return `http://${target}:${port}/metrics`;
  }

  /**
   * Runs one collection cycle, joining the one already in flight if there is one.
   *
   * Cycles must not overlap. Each awaits every world in parallel, so a cycle held up
   * by one slow world can finish after a later cycle that failed fast, and the older
   * readings would then be applied last — which the billing logic would read as a
   * container restart. Serialising removes the interleaving entirely.
   * @returns {Promise<object>} The snapshot produced by the cycle
   */
  collect() {
    if (this._inFlight) return this._inFlight;

    this._inFlight = this._collectOnce().finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  /**
   * Performs one full collection cycle across the fleet.
   * @returns {Promise<object>} The snapshot produced by this cycle
   */
  async _collectOnce() {
    const cycleStart = Date.now();

    const [worlds, hosts] = await Promise.all([
      this.repository.listWorlds(),
      this.repository.listHosts(),
    ]);

    const hostsById = new Map(hosts.map((h) => [h.id, h]));
    const activeWorlds = worlds.filter((w) => w.status === 'ACTIVE');

    // Scrape every active world in parallel; a slow world must not delay the others.
    const scrapes = await Promise.all(
      activeWorlds.map(async (world) => {
        const host = hostsById.get(world.hostId) || null;
        if (!world.port) return { worldId: world.id, payload: null };
        const payload = await this._fetchJson(this._worldMetricsUrl(host, world.port));
        return { worldId: world.id, payload };
      })
    );

    for (const { worldId, payload } of scrapes) {
      if (payload) {
        this.worldSamples.set(worldId, { ...payload, scrapedAt: new Date().toISOString() });
        this.scrapeFailures.delete(worldId);
        this._recordBilledTime(worldId, payload.process?.uptimeSeconds ?? 0);
      } else {
        // The world is still registered ACTIVE but did not answer. Its container may
        // have crashed, so the last successful reading must not outlive it: after a
        // couple of failures the sample is discarded and the row reports no metrics.
        const failures = (this.scrapeFailures.get(worldId) || 0) + 1;
        this.scrapeFailures.set(worldId, failures);
        if (failures >= this.staleAfterFailures) {
          this.worldSamples.delete(worldId);
        }
      }
    }

    // Drop samples for worlds that are no longer active so the dashboard cannot show
    // a stale memory or tick reading for a container that is already gone.
    const activeIds = new Set(activeWorlds.map((w) => w.id));
    for (const worldId of [...this.worldSamples.keys()]) {
      if (!activeIds.has(worldId)) this.worldSamples.delete(worldId);
    }
    for (const worldId of [...this.scrapeFailures.keys()]) {
      if (!activeIds.has(worldId)) this.scrapeFailures.delete(worldId);
    }
    for (const worldId of [...this.currentSessionSeconds.keys()]) {
      if (!activeIds.has(worldId)) this._closeBillingSession(worldId);
    }

    this.npcSample = await this._fetchJson(`${this.npcServiceUrl}/bots`);

    this.lastScrapeDurationMs = Date.now() - cycleStart;
    this.scrapeCount++;

    const snapshot = this.buildSnapshot(worlds, hosts);
    this.lastSnapshot = snapshot;
    this._appendHistory(snapshot);
    return snapshot;
  }

  /**
   * Records how long a world has been running, from the container's own uptime.
   *
   * Deriving billed time from uptime rather than from the polling interval keeps the
   * figure exact: a world that started 0.2s before a scrape is billed 0.2s, not a
   * whole cycle. A drop in reported uptime means the container was replaced, so the
   * previous session is banked before the new one starts counting.
   * @param {string} worldId
   * @param {number} uptimeSeconds
   */
  _recordBilledTime(worldId, uptimeSeconds) {
    const previous = this.currentSessionSeconds.get(worldId) ?? 0;

    if (uptimeSeconds < previous) {
      // A container that truly restarted reports an uptime near zero, far below the
      // previous one. A drop smaller than the scrape skew is a late reading, not a
      // restart, and banking it would charge the session twice. The floor keeps the
      // tolerance meaningful when the interval is configured very short.
      const skewToleranceSeconds = Math.max(
        MIN_RESTART_DROP_SECONDS,
        (this.intervalMs + this.timeoutMs) / 1000
      );
      if (previous - uptimeSeconds <= skewToleranceSeconds) return;

      this.completedActiveSeconds.set(
        worldId,
        (this.completedActiveSeconds.get(worldId) || 0) + previous
      );
    }

    this.currentSessionSeconds.set(worldId, uptimeSeconds);
  }

  /**
   * Banks the running session of a world that is no longer active.
   * @param {string} worldId
   */
  _closeBillingSession(worldId) {
    const session = this.currentSessionSeconds.get(worldId) ?? 0;
    if (session > 0) {
      this.completedActiveSeconds.set(
        worldId,
        (this.completedActiveSeconds.get(worldId) || 0) + session
      );
    }
    this.currentSessionSeconds.delete(worldId);
  }

  /**
   * Total seconds a world has been billed for, across every observed session.
   * @param {string} worldId
   * @returns {number}
   */
  getBilledSeconds(worldId) {
    return (this.completedActiveSeconds.get(worldId) || 0)
      + (this.currentSessionSeconds.get(worldId) || 0);
  }

  /**
   * Appends the fleet-level slice of a snapshot to the bounded time series.
   * @param {object} snapshot
   */
  _appendHistory(snapshot) {
    this.history.push(toHistoryPoint(snapshot));

    if (this.history.length > this.historyPoints) {
      this.history.splice(0, this.history.length - this.historyPoints);
    }
  }

  /**
   * Extracts per-world AI decision latency from the NPC service payload.
   * @param {string} worldId
   * @returns {object|null}
   */
  _aiLatencyForWorld(worldId) {
    const world = this.npcSample?.worlds?.[worldId];
    if (!world) return null;
    return {
      botCount: world.botCount ?? 0,
      avgMs: world.aiLatency?.avgMs ?? null,
      p95Ms: world.aiLatency?.p95Ms ?? null,
      maxMs: world.aiLatency?.maxMs ?? null,
      decisions: world.aiLatency?.decisions ?? 0,
    };
  }

  /**
   * Assembles the complete dashboard snapshot from the latest samples.
   * @param {object[]} worlds
   * @param {object[]} hosts
   * @returns {object}
   */
  buildSnapshot(worlds, hosts) {
    const now = Date.now();
    const observationSeconds = this.startedAt ? (now - this.startedAt) / 1000 : 0;

    const worldTelemetry = new Map();
    for (const world of worlds) {
      const sample = this.worldSamples.get(world.id) || null;
      worldTelemetry.set(world.id, {
        sample,
        sampledAt: sample?.scrapedAt ?? null,
        failedScrapes: this.scrapeFailures.get(world.id) || 0,
        ai: this._aiLatencyForWorld(world.id),
        cumulativeActiveSeconds: this.getBilledSeconds(world.id),
        observationSeconds,
      });
    }

    return buildSnapshot({
      worlds,
      hosts,
      worldTelemetry,
      fleetObservationSeconds: observationSeconds,
      totalBots: this.npcSample?.totalBotsCount ?? 0,
      npcServiceReachable: this.npcSample !== null,
      collector: {
        mode: 'pull',
        running: this.isRunning,
        intervalMs: this.intervalMs,
        scrapeCount: this.scrapeCount,
        lastScrapeDurationMs: this.lastScrapeDurationMs,
        observationSeconds: round(observationSeconds, 0),
      },
    }, this.costEstimator, now);
  }

  /**
   * Returns the most recent snapshot, collecting on demand if none exists yet.
   * @returns {Promise<object>}
   */
  async getSnapshot() {
    if (!this.lastSnapshot) {
      return this.collect();
    }
    return this.lastSnapshot;
  }

  /**
   * Returns the bounded fleet time series.
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async getHistory(limit) {
    if (!limit || limit >= this.history.length) return [...this.history];
    return this.history.slice(-limit);
  }

  /**
   * Status block for /health.
   * @returns {object}
   */
  describe() {
    return {
      mode: 'pull',
      running: this.isRunning,
      scrapeCount: this.scrapeCount,
    };
  }
}
