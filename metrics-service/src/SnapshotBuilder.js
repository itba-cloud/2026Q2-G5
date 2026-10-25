/**
 * SnapshotBuilder: Assembles the dashboard snapshot from the registry and whatever
 * telemetry a store has gathered. Pure: no I/O, no clocks beyond the `now` passed in.
 *
 * Both telemetry stores feed it the same normalised view, so the dashboard contract
 * stays identical whether the samples were scraped in-process (local development) or
 * computed by the Flink pipeline and read from DynamoDB (AWS).
 */

const HOURS_PER_MONTH = 730;

/**
 * @typedef {object} WorldTelemetry
 * @property {object|null} sample Latest metrics payload of the world (players, memory, gameLoop, entities, process)
 * @property {string|null} sampledAt ISO timestamp of that sample
 * @property {number} failedScrapes Consecutive misses (pull) or missed intervals (push)
 * @property {object|null} ai Per-world bot latency, already in dashboard shape
 * @property {number} cumulativeActiveSeconds Billed seconds across every session
 * @property {number} observationSeconds Window the world's elasticity saving is measured over
 */

/**
 * @typedef {object} TelemetryView
 * @property {object[]} worlds Registry rows from the Lobby
 * @property {object[]} hosts Registry rows from the Lobby
 * @property {Map<string, WorldTelemetry>} worldTelemetry Keyed by world id
 * @property {number} fleetObservationSeconds Window used for fleet-level savings
 * @property {number} totalBots Bots reported by the NPC service
 * @property {boolean} npcServiceReachable
 * @property {object} collector Store-specific status block, served as-is
 */

/**
 * @param {TelemetryView} view
 * @param {import('./CostEstimator.js').CostEstimator} costEstimator
 * @param {number} [now] Epoch ms
 * @returns {object}
 */
export function buildSnapshot(view, costEstimator, now = Date.now()) {
  const { worlds, hosts } = view;
  const hostsById = new Map(hosts.map((h) => [h.id, h]));

  const worldRows = worlds.map((world) => {
    const host = world.hostId ? hostsById.get(world.hostId) || null : null;
    const telemetry = view.worldTelemetry.get(world.id) || null;
    const metrics = telemetry?.sample || null;
    const failures = telemetry?.failedScrapes || 0;
    const cumulative = telemetry?.cumulativeActiveSeconds || 0;
    // A world nobody has ever observed has no window to save money over.
    const observationSeconds = telemetry?.observationSeconds ?? 0;

    const cost = costEstimator.estimateWorldCost({
      world,
      host,
      metrics,
      cumulativeActiveSeconds: cumulative,
      observationSeconds,
    });
    const rightSizing = costEstimator.analyzeRightSizing({ cost, metrics, world });

    return {
      id: world.id,
      name: world.name,
      status: world.status,
      biome: world.biome || null,
      hostId: world.hostId || null,
      hostName: host?.name || null,
      port: world.port || null,
      wsUrl: world.wsUrl || null,
      containerId: world.containerId ? world.containerId.slice(0, 12) : null,
      reachable: world.status === 'ACTIVE' && failures === 0 && Boolean(metrics),
      failedScrapes: failures,
      // Age of the reading below. Non-zero means the world missed its last sample
      // and these numbers describe the past, not the present.
      sampleAgeSeconds: telemetry?.sampledAt
        ? round((now - new Date(telemetry.sampledAt).getTime()) / 1000, 1)
        : null,
      players: {
        total: metrics?.players?.total ?? world.playersCount ?? 0,
        humans: metrics?.players?.humans ?? 0,
        bots: metrics?.players?.bots ?? 0,
        max: world.maxPlayers ?? null,
      },
      memory: metrics?.memory ?? null,
      gameLoop: metrics?.gameLoop ?? null,
      entities: metrics?.entities ?? null,
      process: metrics?.process ?? null,
      rolling: metrics?.rolling ?? null,
      ai: telemetry?.ai ?? null,
      cost,
      rightSizing,
      scrapedAt: telemetry?.sampledAt ?? null,
    };
  });

  const activeRows = worldRows.filter((w) => w.status === 'ACTIVE');
  const reachableRows = activeRows.filter((w) => w.reachable && w.memory);

  const fleet = {
    totalWorlds: worldRows.length,
    activeWorlds: activeRows.length,
    idleWorlds: worldRows.length - activeRows.length,
    unreachableWorlds: activeRows.length - reachableRows.length,
    totalHosts: hosts.length,
    healthyHosts: hosts.filter((h) => h.status === 'HEALTHY').length,
    totalPlayers: sum(reachableRows.map((w) => w.players.total)),
    humanPlayers: sum(reachableRows.map((w) => w.players.humans)),
    botPlayers: sum(reachableRows.map((w) => w.players.bots)),
    totalMemoryMb: round(sum(reachableRows.map((w) => w.memory?.rssMb ?? 0)), 1),
    avgTickHz: avg(reachableRows.map((w) => w.gameLoop?.recentHz ?? w.gameLoop?.effectiveHz).filter(isNum)),
    avgAiLatencyMs: avg(worldRows.map((w) => w.ai?.avgMs).filter(isNum)),
    totalBots: view.totalBots ?? 0,
  };

  const cost = costEstimator.aggregateFleetCost(
    hosts,
    worldRows.map((w) => w.cost),
    view.fleetObservationSeconds
  );

  const hostRows = hosts.map((host) => {
    const spec = costEstimator.getHostSpec(host);
    const onHost = activeRows.filter((w) => w.hostId === host.id);
    const capacity = Math.max(1, host.maxWorlds || 10);
    return {
      id: host.id,
      name: host.name || host.id,
      status: host.status || 'UNKNOWN',
      hostIp: host.hostIp || null,
      instanceType: spec.instanceType,
      vcpu: spec.vcpu,
      memoryMb: spec.memoryMb,
      hourlyUsd: round(spec.hourlyUsd, 6),
      monthlyUsd: round(spec.hourlyUsd * HOURS_PER_MONTH, 2),
      activeWorlds: onHost.length,
      maxWorlds: capacity,
      utilizationPct: round((onHost.length / capacity) * 100, 1),
      usedMemoryMb: round(sum(onHost.map((w) => w.memory?.rssMb ?? 0)), 1),
      isPermanent: Boolean(host.isPermanent),
      lastHeartbeat: host.lastHeartbeat || null,
    };
  });

  const recommendations = worldRows
    .filter((w) => w.rightSizing.severity !== 'none')
    .map((w) => ({
      worldId: w.id,
      worldName: w.name,
      verdict: w.rightSizing.verdict,
      severity: w.rightSizing.severity,
      message: w.rightSizing.message,
      action: w.rightSizing.action,
    }));

  return {
    timestamp: new Date(now).toISOString(),
    collector: {
      ...view.collector,
      npcServiceReachable: Boolean(view.npcServiceReachable),
    },
    fleet,
    cost,
    hosts: hostRows,
    worlds: worldRows,
    recommendations,
  };
}

/**
 * Fleet-level slice of a snapshot, as stored in the history series.
 * @param {object} snapshot
 * @returns {object}
 */
export function toHistoryPoint(snapshot) {
  return {
    timestamp: snapshot.timestamp,
    activeWorlds: snapshot.fleet.activeWorlds,
    totalPlayers: snapshot.fleet.totalPlayers,
    humanPlayers: snapshot.fleet.humanPlayers,
    botPlayers: snapshot.fleet.botPlayers,
    totalMemoryMb: snapshot.fleet.totalMemoryMb,
    avgTickHz: snapshot.fleet.avgTickHz,
    avgAiLatencyMs: snapshot.fleet.avgAiLatencyMs,
    hourlyUsd: snapshot.cost.attributedHourlyUsd,
  };
}

export function sum(values) {
  return values.reduce((acc, v) => acc + (Number(v) || 0), 0);
}

export function isNum(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

export function avg(values) {
  if (!values.length) return null;
  return round(sum(values) / values.length, 2);
}

export function round(value, decimals) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
