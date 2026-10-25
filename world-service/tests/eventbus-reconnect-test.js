/**
 * EventBus reconnection: a connected bus must survive a Redis outage longer than
 * the few attempts it allows while starting, like an ElastiCache failover.
 *
 * Starts its own redis-server on a free port; skipped when redis-server is not
 * installed.
 */
import assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import { EventBus, BusMessageTypes, retryDelay } from '../src/messaging/EventBus.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
function check(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startRedis(port) {
  const child = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const probe = () => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(child); });
      socket.on('error', () => (Date.now() > deadline ? reject(new Error('redis-server did not start')) : setTimeout(probe, 100)));
    };
    probe();
  });
}

function stopRedis(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
}

async function until(condition, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(100);
  }
}

async function run() {
  console.log('\n[EventBus] Running reconnection tests...\n');

  assert.strictEqual(retryDelay(4, false), null);
  assert.strictEqual(retryDelay(1, false), 200);
  check('while connecting, the bus gives up after three attempts');

  assert.strictEqual(retryDelay(50, true), 2000);
  assert.strictEqual(retryDelay(1, true), 200);
  check('once connected, it keeps retrying with a bounded delay');

  if (spawnSync('redis-server', ['--version']).status !== 0) {
    console.log('  - SKIP outage test: redis-server is not installed');
    console.log(`\n[EventBus] ${passed}/${passed} checks passed.\n`);
    return;
  }

  const port = await freePort();
  let redis = await startRedis(port);
  const url = `redis://127.0.0.1:${port}`;
  const received = [];
  const sender = new EventBus({ redisUrl: url, channel: 'reconnect-test', worldId: 'world-a', worldName: 'A' });
  const listener = new EventBus({
    redisUrl: url, channel: 'reconnect-test', worldId: 'world-b', worldName: 'B',
    onMessage: (message) => received.push(message),
  });

  try {
    assert.strictEqual((await sender.connect()) && (await listener.connect()), true);

    // Longer than the three attempts (about 1.2 s) the bus allows while starting.
    await stopRedis(redis);
    await wait(3000);
    redis = await startRedis(port);

    const ready = (bus) => bus.publisher.status === 'ready' && bus.subscriber.status === 'ready';
    await until(() => ready(sender) && ready(listener), 10000, 'both buses to reconnect');
    assert.strictEqual(sender.enabled && listener.enabled, true);
    check('both buses reconnect after a three-second outage');

    // ioredis resubscribes on its own; give it a moment after "ready".
    await until(() => {
      sender.publish(BusMessageTypes.CHAT, { playerName: 'Pepe', text: 'volvio el chat' });
      return received.length > 0;
    }, 5000, 'a chat line after the outage');
    assert.strictEqual(received[0].text, 'volvio el chat');
    check('the listener is subscribed again and receives chat');
  } finally {
    await sender.close();
    await listener.close();
    await stopRedis(redis);
  }

  console.log(`\n[EventBus] ${passed}/${passed} checks passed.\n`);
}

run().catch((err) => {
  console.error('\n[EventBus] TEST FAILED:', err.message);
  process.exit(1);
});
