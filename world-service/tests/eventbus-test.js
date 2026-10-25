/**
 * EventBus integration test.
 *
 * Requires a reachable Redis. Start one with:
 *   docker run -d --name ew-redis -p 6379:6379 redis:alpine
 *
 * The last case runs without Redis to prove the bus degrades quietly.
 */
import assert from 'assert';
import { EventBus, BusMessageTypes } from '../src/messaging/EventBus.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CHANNEL = 'test-world-events';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
function check(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

async function run() {
  console.log('\n[EventBus] Running integration tests...\n');

  const receivedByB = [];
  const receivedByA = [];

  const busA = new EventBus({
    redisUrl: REDIS_URL,
    channel: CHANNEL,
    worldId: 'world-a',
    worldName: 'Bosque Inicial',
    onMessage: (msg) => receivedByA.push(msg),
  });

  const busB = new EventBus({
    redisUrl: REDIS_URL,
    channel: CHANNEL,
    worldId: 'world-b',
    worldName: 'Desierto Rojo',
    onMessage: (msg) => receivedByB.push(msg),
  });

  const upA = await busA.connect();
  const upB = await busB.connect();

  assert.strictEqual(upA && upB, true, 'both buses should connect');
  check('two worlds connect to the shared channel');

  // --- A publishes, B receives ---
  await busA.publish(BusMessageTypes.CHAT, {
    playerName: 'Pepe',
    text: 'alguien tiene madera?',
  });
  await wait(150);

  assert.strictEqual(receivedByB.length, 1, 'B should have received one message');
  assert.strictEqual(receivedByB[0].type, BusMessageTypes.CHAT);
  assert.strictEqual(receivedByB[0].text, 'alguien tiene madera?');
  assert.strictEqual(receivedByB[0].playerName, 'Pepe');
  check('a chat line published by A reaches B');

  assert.strictEqual(receivedByB[0].worldName, 'Bosque Inicial');
  assert.strictEqual(receivedByB[0].worldId, 'world-a');
  check('the message carries the origin world identity');

  assert.ok(receivedByB[0].timestamp, 'timestamp should be stamped');
  check('the envelope is timestamped');

  // --- A must not receive its own echo ---
  assert.strictEqual(receivedByA.length, 0, 'A should ignore its own message');
  check('the publisher discards its own echo');

  // --- Both directions work ---
  await busB.publish(BusMessageTypes.WORLD_ONLINE, {
    message: 'El mundo "Desierto Rojo" está online',
  });
  await wait(150);

  assert.strictEqual(receivedByA.length, 1);
  assert.strictEqual(receivedByA[0].type, BusMessageTypes.WORLD_ONLINE);
  assert.strictEqual(receivedByA[0].worldName, 'Desierto Rojo');
  check('lifecycle notices travel in the other direction too');

  await busA.close();
  await busB.close();

  // --- Degrades quietly when Redis is unreachable ---
  const offline = new EventBus({
    redisUrl: 'redis://127.0.0.1:6399', // nothing listening here
    channel: CHANNEL,
    worldId: 'world-c',
    worldName: 'Mundo Aislado',
    onMessage: () => assert.fail('should never receive anything'),
  });

  const upC = await offline.connect();
  assert.strictEqual(upC, false, 'connect should report failure, not throw');
  assert.strictEqual(offline.enabled, false);
  check('an unreachable Redis disables the bus instead of throwing');

  await offline.publish(BusMessageTypes.CHAT, { text: 'nadie me escucha' });
  check('publishing on a disabled bus is a silent no-op');

  await offline.close();

  console.log(`\n[EventBus] ${passed}/${passed} checks passed.\n`);
}

run().catch((err) => {
  console.error('\n[EventBus] TEST FAILED:', err.message);
  process.exit(1);
});
