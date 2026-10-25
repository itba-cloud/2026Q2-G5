import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { LobbyServiceApp } from '../../lobby-service/src/index.js';
import { MetricsServiceApp } from '../src/index.js';
import { CostEstimator, INSTANCE_CATALOG } from '../src/CostEstimator.js';
import { GameLoop } from '../../world-service/src/engine/GameLoop.js';

/**
 * Spins up a stub that answers the same /metrics contract as a real world container,
 * so the collector can be exercised without Docker.
 */
function startFakeWorld(port, payload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function fakeWorldPayload({ rssMb = 60, effectiveHz = 20, players = 3, port = 8098 } = {}) {
  return {
    worldId: 'world-01',
    worldName: 'Bosque Inicial',
    timestamp: new Date().toISOString(),
    players: { total: players, humans: 1, bots: players - 1 },
    memory: { rssMb, heapUsedMb: rssMb * 0.5, heapTotalMb: rssMb * 0.7, externalMb: 2, heapUtilizationPct: 71 },
    gameLoop: {
      isRunning: true, targetHz: 20, intervalMs: 50, effectiveHz,
      totalTicks: 1000, uptimeSeconds: 50, avgDurationMs: 1.2,
      p95DurationMs: 2.4, maxDurationMs: 8.1, budgetUtilizationPct: 2.4,
      clampedTickCount: 0, worstStallMs: 0, sampleCount: 200,
    },
    entities: { players, structures: 4, resources: 120, harvestedResources: 8, projectiles: 2 },
    process: { uptimeSeconds: 120, pid: 1234, nodeVersion: process.version },
    config: { idleTimeoutSeconds: 60, saveIntervalSeconds: 30, port },
  };
}

async function runMetricsTests() {
  console.log('🧪 Starting Monitoring & Cost Dashboard Test Suite...\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // ------------------------------------------------------------------
  // 1. CostEstimator — pure unit checks, no I/O
  // ------------------------------------------------------------------
  console.log('\n--- 1. CostEstimator ---');

  const estimator = new CostEstimator({ defaultInstanceType: 't3.medium', ebsGbPerHost: 30 });
  const spec = estimator.getHostSpec({});
  assert(spec.instanceType === 't3.medium', 'Falls back to the configured default instance type');
  assert(spec.computeHourlyUsd === 0.0416, 't3.medium compute price is $0.0416/h');
  assert(spec.hourlyUsd > spec.computeHourlyUsd, 'Host hourly price includes EBS on top of compute');

  const slotHourly = estimator.getSlotHourlyUsd({ maxWorlds: 10 });
  assert(Math.abs(slotHourly - spec.hourlyUsd / 10) < 1e-9, 'A slot costs exactly 1/maxWorlds of the host');

  const unknownSpec = estimator.getHostSpec({ instanceType: 'not-a-real-type' });
  assert(unknownSpec.instanceType === 'not-a-real-type' && unknownSpec.hourlyUsd === spec.hourlyUsd,
    'An unpriced instance type falls back to default pricing instead of crashing');

  // t2.micro is the AWS Academy / free-tier default and must be priced, not fatal.
  assert(INSTANCE_CATALOG['t2.micro'] !== undefined, 't2.micro is priced in the catalog');

  // The fallback chain must terminate on a spec that exists: an operator can set
  // PRICING_INSTANCE_TYPE to anything, and a throw here kills every collection cycle.
  const bogusDefault = new CostEstimator({ defaultInstanceType: 'nonexistent.type' });
  let bogusSpec = null;
  try {
    bogusSpec = bogusDefault.getHostSpec({});
  } catch (err) {
    bogusSpec = null;
  }
  assert(bogusSpec !== null && bogusSpec.hourlyUsd > 0,
    'An unknown configured default falls back to a real spec instead of throwing');
  assert(bogusDefault.getHostSpec({ instanceType: 'also-fake' }).hourlyUsd > 0,
    'An unknown host type on top of an unknown default still resolves');

  // Cost attribution over a known window
  const cost = estimator.estimateWorldCost({
    world: { id: 'w1', status: 'ACTIVE' },
    host: { maxWorlds: 10 },
    metrics: fakeWorldPayload({ rssMb: 60 }),
    cumulativeActiveSeconds: 3600,
    observationSeconds: 7200,
  });
  assert(Math.abs(cost.accruedCostUsd - slotHourly) < 1e-6, 'One accrued hour bills exactly one slot-hour');
  assert(Math.abs(cost.alwaysOnCostUsd - slotHourly * 2) < 1e-6, 'Always-on cost covers the full observation window');
  assert(Math.abs(cost.savedByElasticityUsd - slotHourly) < 1e-6, 'Elastic saving is always-on minus accrued');
  assert(cost.billing === 'BILLING', 'An ACTIVE world is marked as billing');

  const idleCost = estimator.estimateWorldCost({
    world: { id: 'w2', status: 'INACTIVE' },
    host: { maxWorlds: 10 },
    metrics: null,
    cumulativeActiveSeconds: 0,
    observationSeconds: 7200,
  });
  assert(idleCost.billing === 'IDLE_NOT_BILLED' && idleCost.sessionCostUsd === 0,
    'An INACTIVE world accrues no compute cost');
  assert(idleCost.projectedMonthlyUsd === 0, 'An INACTIVE world projects $0/month');

  // ------------------------------------------------------------------
  // 2. Right-sizing verdicts
  // ------------------------------------------------------------------
  console.log('\n--- 2. Right-sizing analysis ---');

  // t3.medium = 4096 MB over 10 slots => 409.6 MB per slot.
  const oversized = estimator.analyzeRightSizing({
    cost: estimator.estimateWorldCost({
      world: { status: 'ACTIVE' }, host: { maxWorlds: 10 },
      metrics: fakeWorldPayload({ rssMb: 40 }), cumulativeActiveSeconds: 60, observationSeconds: 60,
    }),
    metrics: fakeWorldPayload({ rssMb: 40 }),
    world: { status: 'ACTIVE' },
  });
  assert(oversized.verdict === 'OVERSIZED', 'A world using 10% of its slot is flagged OVERSIZED');
  assert(typeof oversized.action === 'string' && oversized.action.includes('maxWorlds'),
    'The OVERSIZED verdict recommends a concrete provisioning change');

  // A memory-only reading would happily pack dozens of game loops onto two vCPUs.
  const suggestion = estimator.suggestSlots({
    currentSlots: 10, memoryUtilization: 0.02, budgetUtilizationPct: 0.1, vcpu: 2,
  });
  assert(suggestion.slots === 40 && suggestion.boundBy === 'crecimiento gradual',
    'A single recommendation never raises maxWorlds beyond the growth cap (4x)');

  const cpuBound = estimator.suggestSlots({
    currentSlots: 10, memoryUtilization: 0.02, budgetUtilizationPct: 8, vcpu: 2,
  });
  assert(cpuBound.slots === 15 && cpuBound.boundBy === 'CPU del game loop',
    'A CPU-hungry game loop bounds the recommendation below what memory alone would allow');

  const noGrowth = estimator.suggestSlots({
    currentSlots: 10, memoryUtilization: 0.7, budgetUtilizationPct: 1, vcpu: 2,
  });
  assert(noGrowth.slots === 10, 'A well-packed host is never told to shrink its slot count');

  const undersized = estimator.analyzeRightSizing({
    cost: estimator.estimateWorldCost({
      world: { status: 'ACTIVE' }, host: { maxWorlds: 10 },
      metrics: fakeWorldPayload({ rssMb: 390 }), cumulativeActiveSeconds: 60, observationSeconds: 60,
    }),
    metrics: fakeWorldPayload({ rssMb: 390 }),
    world: { status: 'ACTIVE' },
  });
  assert(undersized.verdict === 'UNDERSIZED', 'A world using 95% of its slot is flagged UNDERSIZED');

  const rightSized = estimator.analyzeRightSizing({
    cost: estimator.estimateWorldCost({
      world: { status: 'ACTIVE' }, host: { maxWorlds: 10 },
      metrics: fakeWorldPayload({ rssMb: 200 }), cumulativeActiveSeconds: 60, observationSeconds: 60,
    }),
    metrics: fakeWorldPayload({ rssMb: 200 }),
    world: { status: 'ACTIVE' },
  });
  assert(rightSized.verdict === 'RIGHT_SIZED', 'A world using ~49% of its slot is RIGHT_SIZED');

  // A degraded loop must outrank a comfortable memory reading.
  const degraded = estimator.analyzeRightSizing({
    cost: estimator.estimateWorldCost({
      world: { status: 'ACTIVE' }, host: { maxWorlds: 10 },
      metrics: fakeWorldPayload({ rssMb: 200, effectiveHz: 12 }), cumulativeActiveSeconds: 60, observationSeconds: 60,
    }),
    metrics: fakeWorldPayload({ rssMb: 200, effectiveHz: 12 }),
    world: { status: 'ACTIVE' },
  });
  assert(degraded.verdict === 'UNDERSIZED' && degraded.severity === 'high',
    'A loop running at 12 Hz against a 20 Hz target is UNDERSIZED regardless of memory headroom');

  // A loop scraped 0.3s after boot has too few ticks to judge; a false high-severity
  // stall alert on every world start would train the operator to ignore the panel.
  const justBooted = fakeWorldPayload({ rssMb: 200, effectiveHz: 15 });
  justBooted.gameLoop.uptimeSeconds = 0.3;
  justBooted.gameLoop.recentHz = null;
  const bootVerdict = estimator.analyzeRightSizing({
    cost: estimator.estimateWorldCost({
      world: { status: 'ACTIVE' }, host: { maxWorlds: 10 },
      metrics: justBooted, cumulativeActiveSeconds: 1, observationSeconds: 1,
    }),
    metrics: justBooted,
    world: { status: 'ACTIVE' },
  });
  assert(bootVerdict.verdict !== 'UNDERSIZED',
    `A world 0.3s old is not judged as stalling (got ${bootVerdict.verdict})`);

  const notRunning = estimator.analyzeRightSizing({
    cost: idleCost, metrics: null, world: { status: 'INACTIVE' },
  });
  assert(notRunning.verdict === 'NOT_RUNNING', 'An INACTIVE world yields the NOT_RUNNING verdict');

  // ------------------------------------------------------------------
  // 3. GameLoop instrumentation (the source of the performance metrics)
  // ------------------------------------------------------------------
  console.log('\n--- 3. GameLoop instrumentation ---');

  const stubWorld = { tick() {}, getSyncState: () => ({}) };
  const loop = new GameLoop(stubWorld, null, 10, { recentWindowMs: 120 });

  const idle = loop.getStats();
  assert(idle.totalTicks === 0 && idle.effectiveHz === 0 && idle.recentHz === null,
    'A loop that never started reports no ticks instead of dividing by zero');

  loop.start();
  await new Promise((r) => setTimeout(r, 400));
  const running = loop.getStats();
  loop.stop();

  assert(running.totalTicks > 0, `The loop counts the ticks it performed (${running.totalTicks})`);
  assert(running.effectiveHz > 50 && running.effectiveHz <= 110,
    `Lifetime rate tracks the 100 Hz target (${running.effectiveHz} Hz)`);
  assert(running.recentHz !== null,
    `A sliding window closes and reports the rate being sustained now (${running.recentHz} Hz)`);
  assert(running.maxDurationMs >= running.p95DurationMs,
    'max tick duration is never below p95');
  assert(running.maxDurationMs >= running.avgDurationMs,
    'max tick duration is never below the average');
  assert(running.sampleCount <= loop.perfWindowSize,
    `The duration window stays bounded (${running.sampleCount} <= ${loop.perfWindowSize})`);

  // A throwing world must still be measured: a loop failing slowly is the case the
  // dashboard most needs to surface.
  const throwingLoop = new GameLoop({ tick() { throw new Error('boom'); } }, null, 10);
  throwingLoop.start();
  await new Promise((r) => setTimeout(r, 120));
  const throwingStats = throwingLoop.getStats();
  throwingLoop.stop();
  assert(throwingStats.totalTicks > 0,
    `Ticks that throw are still counted and timed (${throwingStats.totalTicks})`);

  // ------------------------------------------------------------------
  // 4. Fleet aggregation
  // ------------------------------------------------------------------
  console.log('\n--- 4. Fleet aggregation ---');

  const fleet = estimator.aggregateFleetCost(
    [{ id: 'h1', maxWorlds: 10 }],
    [cost, idleCost],
    7200
  );
  assert(Math.abs(fleet.fleetFixedHourlyUsd - spec.hourlyUsd) < 1e-5,
    'Fleet fixed cost is the sum of host prices, billed regardless of occupancy');
  assert(fleet.idleCapacityHourlyUsd > 0, 'Unsold slot capacity is reported as idle cost');
  assert(fleet.savedByElasticityUsd > 0 && fleet.savedByElasticityPct > 0,
    `Elasticity saving is reported (${fleet.savedByElasticityPct}%)`);

  // Ten catalogue entries that never started must not manufacture savings.
  const neverRan = Array.from({ length: 10 }, () => estimator.estimateWorldCost({
    world: { status: 'INACTIVE' }, host: { maxWorlds: 10 },
    metrics: null, cumulativeActiveSeconds: 0, observationSeconds: 7200,
  }));
  const phantom = estimator.aggregateFleetCost([{ id: 'h1', maxWorlds: 10 }], neverRan, 7200);
  assert(phantom.savedByElasticityUsd === 0,
    'Worlds that never ran contribute no elasticity saving');

  // A container older than the collector must never produce a negative saving.
  const predates = estimator.estimateWorldCost({
    world: { status: 'ACTIVE' }, host: { maxWorlds: 10 },
    metrics: fakeWorldPayload({}), cumulativeActiveSeconds: 3600, observationSeconds: 60,
  });
  assert(predates.savedByElasticityUsd >= 0 && predates.alwaysOnCostUsd >= predates.accruedCostUsd,
    'A world running since before the collector started never shows a negative saving');

  // ------------------------------------------------------------------
  // 5. End-to-end through the live HTTP API
  // ------------------------------------------------------------------
  console.log('\n--- 5. Metrics API (end to end) ---');

  // The collector runs in its own process and serves /api/metrics* itself (in AWS the
  // ALB routes those paths straight to it). The Lobby holds no metrics state; the
  // metrics service reads the world and host registry from the Lobby's REST API.
  const testPort = 3098;
  const metricsPort = 3198;
  const fakeWorldPort = 8098;
  const testDataDir = path.resolve('./.test_metrics_data');
  await fs.rm(testDataDir, { recursive: true, force: true });

  const fakeWorld = await startFakeWorld(fakeWorldPort, fakeWorldPayload({ rssMb: 55 }));
  let fakeWorldClosed = false;

  const app = new LobbyServiceApp({
    port: testPort,
    host: '127.0.0.1',
    publicHost: 'localhost',
    dataDir: testDataDir,
    storageMode: 'local',
    useDockerMock: true,
  });

  const metricsApp = new MetricsServiceApp({
    port: metricsPort,
    host: '127.0.0.1',
    lobbyUrl: `http://127.0.0.1:${testPort}`,
    npcServiceUrl: 'http://127.0.0.1:59999', // deliberately unreachable
    metrics: { intervalMs: 300, historyPoints: 20, scrapeTimeoutMs: 500 },
  });
  const collector = metricsApp.metricsCollector;

  await app.start();
  await metricsApp.start();
  const baseUrl = `http://127.0.0.1:${testPort}`;
  const metricsBaseUrl = `http://127.0.0.1:${metricsPort}`;

  try {
    const healthRes = await fetch(`${metricsBaseUrl}/health`);
    const health = await healthRes.json();
    assert(healthRes.status === 200 && health.service === 'metrics-service' && health.collectorRunning === true,
      'The metrics service answers /health with its collector running');

    // Basic Auth checks
    const unauthRes = await fetch(`${metricsBaseUrl}/api/metrics`);
    assert(unauthRes.status === 401 && (unauthRes.headers.get('www-authenticate') || '').includes('Basic'),
      'GET /api/metrics without auth returns HTTP 401 with WWW-Authenticate header');

    const badAuthRes = await fetch(`${metricsBaseUrl}/api/metrics`, {
      headers: { Authorization: `Basic ${Buffer.from('admin:wrongpassword').toString('base64')}` },
    });
    assert(badAuthRes.status === 401, 'GET /api/metrics with invalid credentials returns HTTP 401');

    const validAuthHeader = `Basic ${Buffer.from('admin:cloud2026').toString('base64')}`;
    const authHeaders = { Authorization: validAuthHeader };

    // The registry the collector sees is the Lobby's, fetched over HTTP.
    const viaApi = await metricsApp.repository.listWorlds();
    const viaRepo = await app.repository.listWorlds();
    assert(viaApi.length === viaRepo.length && viaApi[0]?.id === viaRepo[0]?.id,
      'The metrics service reads the same world registry the Lobby serves');
    assert(metricsApp.repository.lobbyReachable === true,
      'The metrics service reports the Lobby as reachable');

    // The Lobby reaches worlds by hostIp. In AWS that must be the private address:
    // PUBLIC_HOST builds the players' wsUrl but is not routable from the private
    // subnet, so conflating them makes every world unreachable on the dashboard.
    const seededHost = (await app.repository.listHosts())[0];
    assert(seededHost.hostIp === seededHost.publicHost && seededHost.hostIp === 'localhost',
      'Without PRIVATE_HOST, hostIp keeps falling back to publicHost (unchanged behaviour)');

    const splitDir = path.resolve('./.test_metrics_split');
    await fs.rm(splitDir, { recursive: true, force: true });
    const { LocalJsonWorldRepository } = await import('../../lobby-service/src/store/LocalJsonWorldRepository.js');
    const splitRepo = new LocalJsonWorldRepository({
      dataDir: splitDir, publicHost: '54.1.2.3', privateHost: '10.0.0.15',
    });
    await splitRepo.init();
    const splitHost = (await splitRepo.listHosts())[0];
    await fs.rm(splitDir, { recursive: true, force: true });
    assert(splitHost.hostIp === '10.0.0.15' && splitHost.publicHost === '54.1.2.3',
      'PRIVATE_HOST separates the scrape address from the address players connect to');

    const snapRes = await fetch(`${metricsBaseUrl}/api/metrics`, { headers: authHeaders });
    const snap = await snapRes.json();
    assert(snapRes.status === 200 && snap.success === true, 'GET /api/metrics on the metrics service returns HTTP 200 with Basic Auth');


    const viaLobbyRes = await fetch(`${baseUrl}/api/metrics`);
    assert(viaLobbyRes.status === 404, 'The Lobby does not serve /api/metrics: the ALB routes it to the metrics service');
    assert(snap.fleet && snap.cost && Array.isArray(snap.worlds) && Array.isArray(snap.hosts),
      'Snapshot carries fleet, cost, worlds and hosts sections');
    assert(snap.collector.npcServiceReachable === false,
      'An unreachable NPC Service degrades gracefully instead of failing the request');

    // Point the default world at the stub and let a collection cycle run.
    await app.repository.updateWorld('world-01', {
      status: 'ACTIVE',
      hostId: 'host-primary-01',
      port: fakeWorldPort,
      wsUrl: `ws://localhost:${fakeWorldPort}`,
      containerId: 'test-container-abcdef123456',
    });

    await collector.collect();
    await new Promise((r) => setTimeout(r, 1200));
    await collector.collect();

    const liveRes = await fetch(`${metricsBaseUrl}/api/metrics`, { headers: authHeaders });
    const live = await liveRes.json();
    const world = live.worlds.find((w) => w.id === 'world-01');

    assert(world && world.reachable === true, 'The collector scraped the running world');
    assert(world.memory && world.memory.rssMb === 55, 'World memory is reported from the scrape');
    assert(world.gameLoop && world.gameLoop.effectiveHz === 20, 'Game loop performance is reported');
    assert(world.players.total === 3, 'Player count comes from the world, not the stale registry field');
    assert(live.fleet.activeWorlds === 1 && live.fleet.totalPlayers === 3, 'Fleet totals aggregate the active world');
    assert(world.cost.slotHourlyUsd > 0 && world.cost.billing === 'BILLING', 'Active world is billed per slot-hour');
    // Billed time must equal the container's own uptime, not a multiple of the poll
    // interval: a world that started moments before a scrape must not be charged for
    // the whole cycle.
    assert(world.cost.cumulativeActiveSeconds === 120,
      `Billed time equals the uptime the world reports, exactly (${world.cost.cumulativeActiveSeconds}s vs 120s reported)`);
    assert(collector.getBilledSeconds('world-01') === 120,
      'Repeated scrapes of an unchanged uptime do not inflate billed time');
    assert(world.rightSizing.verdict === 'OVERSIZED',
      `55 MB in a 409.6 MB slot is deterministically OVERSIZED (got ${world.rightSizing.verdict})`);

    // A container replaced in place reports a lower uptime. The finished session must
    // be banked, never dropped and never counted twice.
    collector._recordBilledTime('world-01', 30);
    assert(collector.getBilledSeconds('world-01') === 150,
      `A restarted container banks its previous session and starts a new one (${collector.getBilledSeconds('world-01')}s = 120 + 30)`);
    collector._recordBilledTime('world-01', 45);
    assert(collector.getBilledSeconds('world-01') === 165,
      'Continuing the new session adds only the delta, not the whole session again');

    // A reading from an overlapping cycle can arrive after a newer one. A small
    // backwards step is scrape skew, not a restart, and must not bank the session.
    collector._recordBilledTime('world-01', 44);
    assert(collector.getBilledSeconds('world-01') === 165,
      'A late, slightly-older reading is ignored rather than counted as a restart');
    // Restore the fixture's reported uptime for the assertions that follow.
    collector.completedActiveSeconds.set('world-01', 0);
    collector.currentSessionSeconds.set('world-01', 120);

    // Overlapping cycles corrupted billed time; collect() now joins the in-flight one.
    const before = collector.scrapeCount;
    const [a, b, c] = await Promise.all([
      collector.collect(),
      collector.collect(),
      collector.collect(),
    ]);
    assert(collector.scrapeCount === before + 1,
      `Three concurrent collect() calls run one cycle, not three (${collector.scrapeCount - before})`);
    assert(a === b && b === c, 'Concurrent callers all receive the same snapshot');

    const histRes = await fetch(`${metricsBaseUrl}/api/metrics/history?limit=10`, { headers: authHeaders });
    const hist = await histRes.json();
    assert(histRes.status === 200 && Array.isArray(hist.points) && hist.points.length > 0,
      `GET /api/metrics/history returns ${hist.points?.length} point(s)`);
    assert(hist.points.every((p) => typeof p.timestamp === 'string'), 'Every history point is timestamped');

    const costRes = await fetch(`${metricsBaseUrl}/api/metrics/costs`, { headers: authHeaders });
    const costs = await costRes.json();
    assert(costRes.status === 200 && costs.cost && Array.isArray(costs.recommendations),
      'GET /api/metrics/costs returns the cost breakdown and recommendations');

    const detailRes = await fetch(`${metricsBaseUrl}/api/metrics/worlds/world-01`, { headers: authHeaders });
    const detail = await detailRes.json();
    assert(detailRes.status === 200 && detail.world.id === 'world-01', 'GET /api/metrics/worlds/:id returns the world');

    const missingRes = await fetch(`${metricsBaseUrl}/api/metrics/worlds/does-not-exist`, { headers: authHeaders });
    assert(missingRes.status === 404, 'An unknown world id returns HTTP 404');

    // History must stay bounded so a long-running lobby cannot leak memory.
    for (let i = 0; i < 25; i++) {
      await collector.collect();
    }
    assert(collector.history.length <= 20,
      `History stays capped at historyPoints (${collector.history.length} <= 20)`);

    // A world whose container dies while the registry still calls it ACTIVE must not
    // keep serving its last successful reading as if it were live.
    await new Promise((resolve) => fakeWorld.close(resolve));
    fakeWorldClosed = true;

    await collector.collect();
    const afterFirstMiss = (await (await fetch(`${metricsBaseUrl}/api/metrics`, { headers: authHeaders })).json())
      .worlds.find((w) => w.id === 'world-01');
    assert(afterFirstMiss.reachable === false && afterFirstMiss.failedScrapes >= 1,
      'A crashed world is reported unreachable on the very first missed scrape');
    assert(afterFirstMiss.sampleAgeSeconds !== null,
      'The surviving reading is labelled with its age instead of passing as current');

    await collector.collect();
    const afterSecondMiss = (await (await fetch(`${metricsBaseUrl}/api/metrics`, { headers: authHeaders })).json())
      .worlds.find((w) => w.id === 'world-01');
    assert(afterSecondMiss.memory === null && afterSecondMiss.gameLoop === null,
      'The stale reading is discarded once the world misses repeated scrapes');

    const degradedFleet = (await (await fetch(`${metricsBaseUrl}/api/metrics`, { headers: authHeaders })).json()).fleet;
    assert(degradedFleet.unreachableWorlds === 1 && degradedFleet.totalMemoryMb === 0,
      'Fleet totals exclude a world that stopped answering');

    // Stopping the world must clear its live sample, not leave a stale reading behind.
    await app.repository.updateWorld('world-01', { status: 'INACTIVE', port: null, hostId: null });
    await collector.collect();
    const afterStop = await (await fetch(`${metricsBaseUrl}/api/metrics`, { headers: authHeaders })).json();
    const stopped = afterStop.worlds.find((w) => w.id === 'world-01');
    assert(stopped.reachable === false && stopped.memory === null,
      'A stopped world drops its stale metrics sample');
    assert(stopped.cost.billing === 'IDLE_NOT_BILLED' && stopped.cost.accruedCostUsd > 0,
      'A stopped world stops billing but keeps its accrued cost');

    // Telemetry going down must not take the control plane with it: the dashboard
    // routes stop answering (the ALB target group turns unhealthy) while the Lobby
    // keeps serving worlds untouched.
    await metricsApp.stop();
    const metricsDown = await fetch(`${metricsBaseUrl}/api/metrics`).then(() => false, () => true);
    assert(metricsDown, 'With the metrics service down, /api/metrics is unreachable');
    const worldsRes = await fetch(`${baseUrl}/api/worlds`);
    assert(worldsRes.status === 200, 'The Lobby keeps serving its own API while metrics are down');
  } finally {
    await metricsApp.stop();
    await app.stop();
    if (!fakeWorldClosed) await new Promise((resolve) => fakeWorld.close(resolve));
    await fs.rm(testDataDir, { recursive: true, force: true });
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('❌ Metrics test suite FAILED.');
    process.exit(1);
  }
  console.log('✅ Metrics test suite PASSED.');
  process.exit(0);
}

runMetricsTests().catch((err) => {
  console.error('💥 Fatal error in metrics test suite:', err);
  process.exit(1);
});
