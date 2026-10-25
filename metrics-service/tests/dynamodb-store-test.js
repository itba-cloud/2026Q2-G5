import { DynamoDbTelemetryStore } from '../src/store/DynamoDbTelemetryStore.js';
import { MetricsServiceApp } from '../src/index.js';

/**
 * Exercises the stateless telemetry store against a fake DynamoDB document client
 * holding the item shapes the Flink job writes (see .docs/telemetry-pipeline.md).
 * No AWS access and no Lobby process are needed.
 */

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const iso = (offsetSeconds) => new Date(NOW - offsetSeconds * 1000).toISOString();

function worldItem(worldId, { ageSeconds = 2, uptime = 120, banked = 0, firstSeenAgo = 600, rssMb = 55, ai = true } = {}) {
  return {
    pk: `WORLD#${worldId}`,
    sk: 'LATEST',
    worldId,
    containerId: 'abc123def456',
    sampledAt: iso(ageSeconds),
    updatedAt: NOW - ageSeconds * 1000,
    sample: {
      worldName: 'Bosque Inicial',
      players: { total: 3, humans: 1, bots: 2 },
      memory: { rssMb, heapUsedMb: 30, heapTotalMb: 40, externalMb: 2, heapUtilizationPct: 75 },
      gameLoop: { isRunning: true, targetHz: 20, effectiveHz: 20, recentHz: 19.8, maxDurationMs: 8 },
      entities: { players: 3, structures: 4, resources: 120, harvestedResources: 8, projectiles: 0 },
      process: { uptimeSeconds: uptime, pid: 1, nodeVersion: 'v22' },
      config: { idleTimeoutSeconds: 60, saveIntervalSeconds: 30, port: 8001 },
    },
    rolling: { windowSeconds: 60, samples: 12, avgTickHz: 19.9, avgRssMb: rssMb, maxTickDurationMs: 8 },
    billing: {
      cumulativeActiveSeconds: banked + uptime,
      currentSessionSeconds: uptime,
      sessions: banked > 0 ? 2 : 1,
      firstSeenAt: NOW - firstSeenAgo * 1000,
    },
    ...(ai ? { ai: { botCount: 2, avgMs: 1.8, p95Ms: 4.2, maxMs: 9, decisions: 120, sampledAt: iso(ageSeconds) } } : {}),
    ttl: Math.floor(NOW / 1000) + 7 * 86400,
  };
}

function fleetItem(endOffsetSeconds, activeWorlds) {
  const end = NOW - endOffsetSeconds * 1000;
  return {
    pk: 'FLEET',
    sk: String(end).padStart(13, '0'),
    timestamp: new Date(end).toISOString(),
    windowSeconds: 10,
    activeWorlds,
    totalPlayers: 3 * activeWorlds,
    humanPlayers: activeWorlds,
    botPlayers: 2 * activeWorlds,
    totalMemoryMb: 55 * activeWorlds,
    avgTickHz: 19.9,
    avgAiLatencyMs: 1.8,
    totalBots: 2 * activeWorlds,
    ttl: Math.floor(end / 1000) + 86400,
  };
}

/** Minimal DynamoDB document client: BatchGet, Get and Query over an in-memory map. */
class FakeDocumentClient {
  constructor(items) {
    this.items = new Map(items.map((i) => [`${i.pk}|${i.sk}`, i]));
    this.batchSizes = [];
    this.unprocessedOnce = false;
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;

    if (name === 'BatchGetCommand') {
      const [table, { Keys }] = Object.entries(input.RequestItems)[0];
      this.batchSizes.push(Keys.length);
      if (Keys.length > 100) throw new Error('ValidationException: Too many items requested for the BatchGetItem call');
      let keys = Keys;
      let unprocessed = [];
      if (this.unprocessedOnce) {
        this.unprocessedOnce = false;
        unprocessed = keys.slice(-1);
        keys = keys.slice(0, -1);
      }
      const found = keys.map((k) => this.items.get(`${k.pk}|${k.sk}`)).filter(Boolean);
      return {
        Responses: { [table]: found },
        UnprocessedKeys: unprocessed.length ? { [table]: { Keys: unprocessed } } : {},
      };
    }

    if (name === 'GetCommand') {
      return { Item: this.items.get(`${input.Key.pk}|${input.Key.sk}`) };
    }

    if (name === 'QueryCommand') {
      const pk = input.ExpressionAttributeValues[':pk'];
      let rows = [...this.items.values()].filter((i) => i.pk === pk).sort((a, b) => (a.sk < b.sk ? -1 : 1));
      if (input.ScanIndexForward === false) rows = rows.reverse();
      if (input.Limit) rows = rows.slice(0, input.Limit);
      return { Items: rows };
    }

    throw new Error(`Unexpected command ${name}`);
  }
}

function fakeRepository({ worlds, hosts }) {
  return {
    lobbyReachable: true,
    async init() {},
    async listWorlds() { return worlds; },
    async listHosts() { return hosts; },
  };
}

async function runDynamoDbStoreTests() {
  console.log('🧪 Starting DynamoDB Telemetry Store Test Suite...\n');

  // Every age in the fixtures is relative to NOW, so the clock is pinned for the run.
  const realNow = Date.now;
  Date.now = () => NOW;

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

  const hosts = [
    { id: 'i-aaa', name: 'World Host (a)', status: 'HEALTHY', hostIp: '10.0.0.10', maxWorlds: 10, instanceType: 't3.medium' },
  ];
  const worlds = [
    { id: 'world-01', name: 'Bosque Inicial', status: 'ACTIVE', hostId: 'i-aaa', port: 8001, wsUrl: 'ws://x:8001', containerId: 'abc123def456ffff' },
    { id: 'world-02', name: 'Desierto', status: 'ACTIVE', hostId: 'i-aaa', port: 8002, wsUrl: 'ws://x:8002', containerId: 'bbb' },
    { id: 'world-03', name: 'Tundra', status: 'ACTIVE', hostId: 'i-aaa', port: 8003, wsUrl: 'ws://x:8003', containerId: 'ccc' },
    { id: 'world-04', name: 'Isla', status: 'INACTIVE', hostId: null, port: null, wsUrl: null, containerId: null },
    { id: 'world-05', name: 'Nunca arrancó', status: 'INACTIVE', hostId: null, port: null, wsUrl: null, containerId: null },
  ];

  const client = new FakeDocumentClient([
    worldItem('world-01', { ageSeconds: 2, uptime: 120, banked: 30 }),
    worldItem('world-02', { ageSeconds: 25, uptime: 50, ai: false }), // stale but still shown with age
    worldItem('world-03', { ageSeconds: 600, uptime: 10 }),           // long dead: reading dropped
    worldItem('world-04', { ageSeconds: 3600, uptime: 200, banked: 100, firstSeenAgo: 3600, ai: false }), // stopped, keeps accrued cost
    { pk: 'SERVICE#npc', sk: 'TASK#a', sampledAt: iso(3), updatedAt: NOW - 3000, totalBots: 3, activeWorlds: 2 },
    { pk: 'SERVICE#npc', sk: 'TASK#b', sampledAt: iso(5), updatedAt: NOW - 5000, totalBots: 1, activeWorlds: 1 },
    { pk: 'SERVICE#npc', sk: 'TASK#gone', sampledAt: iso(600), updatedAt: NOW - 600000, totalBots: 9, activeWorlds: 4 }, // scaled in
    fleetItem(30, 1),
    fleetItem(20, 2),
    fleetItem(10, 3),
    fleetItem(0, 3),
  ]);

  const config = {
    telemetry: { tableName: 'elastic-worlds-telemetry', staleAfterSeconds: 15, fleetWindowSeconds: 10 },
    metrics: { intervalMs: 5000 },
    pricing: { defaultInstanceType: 't3.medium', ebsGbPerHost: 30 },
  };

  // ------------------------------------------------------------------
  console.log('--- 1. Construction ---');

  let threw = false;
  try {
    new DynamoDbTelemetryStore({ repository: fakeRepository({ worlds, hosts }), config: { telemetry: {} } });
  } catch {
    threw = true;
  }
  assert(threw, 'A missing table name is rejected at construction');

  const store = new DynamoDbTelemetryStore({ repository: fakeRepository({ worlds, hosts }), config, client });
  store.start();
  assert(store.describe().mode === 'dynamodb' && store.describe().running === true,
    'describe() reports the dynamodb mode for /health');

  // ------------------------------------------------------------------
  console.log('\n--- 2. Snapshot from DynamoDB rows ---');

  const snapshot = await store.getSnapshot();

  const byId = Object.fromEntries(snapshot.worlds.map((w) => [w.id, w]));

  assert(snapshot.collector.mode === 'dynamodb' && snapshot.collector.intervalMs === 10000,
    'Snapshot labels its source and the fleet window as the history cadence');
  assert(snapshot.collector.reportingWorlds === 1, 'Only worlds with a fresh sample count as reporting');

  const w1 = byId['world-01'];
  assert(w1.reachable === true && w1.failedScrapes === 0 && w1.sampleAgeSeconds === 2,
    'A world sampled 2s ago is reachable with no misses');
  assert(w1.memory.rssMb === 55 && w1.gameLoop.recentHz === 19.8 && w1.players.total === 3,
    'Memory, game loop and players come from the stored sample');
  assert(w1.rolling && w1.rolling.avgTickHz === 19.9, 'The 60s rolling window computed by Flink is exposed');
  assert(w1.ai && w1.ai.botCount === 2 && w1.ai.avgMs === 1.8, 'Bot latency merged by Flink is exposed per world');
  assert(w1.cost.cumulativeActiveSeconds === 150 && w1.cost.billing === 'BILLING',
    `Billed seconds come from the Flink ledger, sessions included (${w1.cost.cumulativeActiveSeconds}s = 30 + 120)`);
  assert(w1.cost.alwaysOnCostUsd >= w1.cost.accruedCostUsd && w1.cost.savedByElasticityUsd >= 0,
    'The elasticity baseline spans the time since Flink first saw the world');
  assert(w1.process.uptimeSeconds === 120 && w1.cost.sessionSeconds === 120, 'Session seconds follow container uptime');

  const w2 = byId['world-02'];
  assert(w2.reachable === false && w2.failedScrapes === 5 && w2.sampleAgeSeconds === 25,
    'A world silent for 25s is unreachable with 5 missed 5s intervals');
  assert(w2.memory !== null && w2.ai === null,
    'Its last reading is still shown with its age, and no bot data since none was merged');

  const w3 = byId['world-03'];
  assert(w3.reachable === false && w3.memory === null && w3.gameLoop === null,
    'A world silent for 10 minutes has its stale reading dropped');
  assert(w3.cost.cumulativeActiveSeconds === 10, 'Its ledger is still reported');

  const w4 = byId['world-04'];
  assert(w4.reachable === false && w4.cost.billing === 'IDLE_NOT_BILLED' && w4.cost.accruedCostUsd > 0,
    'A stopped world stops billing but keeps its accrued cost from the ledger');

  const w5 = byId['world-05'];
  assert(w5.memory === null && w5.cost.cumulativeActiveSeconds === 0 && w5.cost.savedByElasticityUsd === 0,
    'A world with no DynamoDB row has no telemetry and manufactures no savings');

  assert(snapshot.fleet.activeWorlds === 3 && snapshot.fleet.unreachableWorlds === 2,
    'Fleet counts ACTIVE worlds from the registry and flags the silent ones');
  assert(snapshot.fleet.totalPlayers === 3 && snapshot.fleet.totalMemoryMb === 55,
    'Fleet totals only aggregate reachable worlds');
  assert(snapshot.fleet.totalBots === 4 && snapshot.collector.npcServiceReachable === true,
    'Bot total sums the fresh SERVICE#npc replica heartbeats');
  assert(snapshot.collector.npcReplicas === 2, 'A replica that stopped reporting is not counted');
  assert(snapshot.hosts.length === 1 && snapshot.hosts[0].activeWorlds === 3,
    'Host rows are built from the registry');
  assert(snapshot.cost.observationSeconds === 3600,
    `Fleet observation window starts at the earliest firstSeenAt (${snapshot.cost.observationSeconds}s)`);

  // ------------------------------------------------------------------
  console.log('\n--- 3. History from FLEET rows ---');

  const history = await store.getHistory(3);
  assert(history.length === 3, 'History honours the limit');
  assert(history[0].activeWorlds === 2 && history[2].activeWorlds === 3 && history[0].timestamp < history[2].timestamp,
    'History is returned oldest first, newest last, as the charts expect');
  const slot = store.costEstimator.getSlotHourlyUsd({});
  assert(Math.abs(history[2].hourlyUsd - 3 * slot) < 1e-6,
    'Cost per point is priced at read time: activeWorlds × slot price');
  assert(history[2].avgTickHz === 19.9 && history[2].avgAiLatencyMs === 1.8 && history[2].totalPlayers === 9,
    'Fleet aggregates computed by Flink are passed through');

  const all = await store.getHistory();
  assert(all.length === 4, 'Without a limit every stored point is returned');

  // ------------------------------------------------------------------
  console.log('\n--- 4. Batch reads ---');

  const manyWorlds = Array.from({ length: 150 }, (_, i) => ({
    id: `w-${i}`, name: `W${i}`, status: 'INACTIVE', hostId: null, port: null,
  }));
  const bigClient = new FakeDocumentClient([worldItem('w-149', { ageSeconds: 1 })]);
  bigClient.unprocessedOnce = true;
  const bigStore = new DynamoDbTelemetryStore({ repository: fakeRepository({ worlds: manyWorlds, hosts: [] }), config, client: bigClient });
  const bigSnapshot = await bigStore.getSnapshot();
  assert(bigClient.batchSizes[0] === 100 && bigClient.batchSizes[2] === 50,
    `Keys are fetched in batches of at most 100 (${bigClient.batchSizes.join(', ')})`);
  assert(bigClient.batchSizes.length === 3 && bigClient.batchSizes[1] === 1,
    'Unprocessed keys are retried before moving on instead of reported as silent worlds');
  assert(bigSnapshot.worlds.find((w) => w.id === 'w-149').memory !== null,
    'The world whose key was initially unprocessed still gets its telemetry');

  // ------------------------------------------------------------------
  console.log('\n--- 5. App wiring ---');

  const app = new MetricsServiceApp({
    port: 3199,
    host: '127.0.0.1',
    lobbyUrl: 'http://127.0.0.1:59998',
    telemetry: { mode: 'dynamodb', tableName: 'elastic-worlds-telemetry', region: 'us-east-1' },
  });
  assert(app.telemetry instanceof DynamoDbTelemetryStore && app.metricsCollector === null,
    'TELEMETRY_MODE=dynamodb wires the stateless store and no in-process collector');

  let unknownThrew = false;
  try {
    new MetricsServiceApp({ telemetry: { mode: 'kinesis' } });
  } catch {
    unknownThrew = true;
  }
  assert(unknownThrew, 'An unknown TELEMETRY_MODE fails fast at startup');

  Date.now = realNow;

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('❌ DynamoDB telemetry store test suite FAILED.');
    process.exit(1);
  }
  console.log('✅ DynamoDB telemetry store test suite PASSED.');
}

runDynamoDbStoreTests().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
