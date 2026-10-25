import { KinesisTelemetryPublisher } from '../src/telemetry/KinesisTelemetryPublisher.js';

/**
 * Exercises the Kinesis publisher against a fake client: record shape, partitioning,
 * failure isolation. No AWS access is needed.
 */
async function runTelemetryPublisherTests() {
  console.log('🧪 Starting Telemetry Publisher Test Suite...\n');

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

  const sent = [];
  const fakeClient = {
    failNext: 0,
    async send(command) {
      if (this.failNext > 0) {
        this.failNext--;
        throw new Error('ProvisionedThroughputExceededException');
      }
      sent.push(command.input);
      return { SequenceNumber: String(sent.length) };
    },
  };

  const payload = {
    worldId: 'world-01',
    worldName: 'Bosque Inicial',
    timestamp: '2026-10-15T12:00:00.000Z',
    players: { total: 3, humans: 1, bots: 2 },
    memory: { rssMb: 55 },
    gameLoop: { effectiveHz: 20, recentHz: 19.8 },
    entities: { players: 3 },
    process: { uptimeSeconds: 120, pid: 1, nodeVersion: 'v22' },
    config: { port: 8001 },
  };

  // ------------------------------------------------------------------
  console.log('--- 1. Construction ---');

  let threw = false;
  try {
    new KinesisTelemetryPublisher({ worldId: 'w', getPayload: () => ({}), client: fakeClient });
  } catch {
    threw = true;
  }
  assert(threw, 'A missing stream name is rejected at construction');

  const publisher = new KinesisTelemetryPublisher({
    streamName: 'elastic-worlds-telemetry',
    worldId: 'world-01',
    containerId: 'abc123def456',
    getPayload: () => payload,
    client: fakeClient,
  });

  // ------------------------------------------------------------------
  console.log('\n--- 2. Record contract ---');

  const record = publisher.buildRecord();
  assert(record.type === 'world' && record.schemaVersion === 1, 'Record is typed "world" with schemaVersion 1');
  assert(record.worldId === 'world-01' && record.containerId === 'abc123def456',
    'Record carries the world id and the container id used as billing session');
  assert(record.timestamp === payload.timestamp, 'Record keeps the payload timestamp');
  assert(record.process.uptimeSeconds === 120 && record.memory.rssMb === 55 && record.players.total === 3,
    'Record embeds process, memory and players from the metrics payload');

  const ok = await publisher.publish();
  assert(ok === true && sent.length === 1, 'publish() sends exactly one PutRecord');
  assert(sent[0].StreamName === 'elastic-worlds-telemetry', 'PutRecord targets the configured stream');
  assert(sent[0].PartitionKey === 'world-01', 'Partition key is the world id so Flink sees a world in order');
  const decoded = JSON.parse(Buffer.from(sent[0].Data).toString('utf8'));
  assert(decoded.type === 'world' && decoded.worldId === 'world-01', 'Data is the JSON record, UTF-8 encoded');

  // ------------------------------------------------------------------
  console.log('\n--- 3. Failure isolation ---');

  fakeClient.failNext = 2;
  const first = await publisher.publish();
  const second = await publisher.publish();
  assert(first === false && second === false, 'Failures resolve to false instead of throwing');
  assert(publisher.consecutiveFailures === 2, 'Consecutive failures are counted');
  const recovered = await publisher.publish();
  assert(recovered === true && publisher.consecutiveFailures === 0, 'A successful publish resets the failure counter');
  assert(publisher.publishedCount === 2, 'Only successful publishes are counted');

  const defaultId = new KinesisTelemetryPublisher({
    streamName: 's', worldId: 'w', getPayload: () => ({}), client: fakeClient,
  });
  assert(typeof defaultId.containerId === 'string' && defaultId.containerId.length > 0,
    'Without CONTAINER_ID the hostname is used as session id');

  publisher.start();
  assert(publisher.timer !== null, 'start() schedules the periodic publish');
  await publisher.close();
  assert(publisher.timer === null, 'close() clears the timer');

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('❌ Telemetry publisher test suite FAILED.');
    process.exit(1);
  }
  console.log('✅ Telemetry publisher test suite PASSED.');
}

runTelemetryPublisherTests().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
