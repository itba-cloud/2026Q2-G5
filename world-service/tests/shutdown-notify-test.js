import http from 'node:http';
import { once } from 'node:events';
import { WorldServiceApp } from '../src/index.js';

/**
 * Exercises the shutdown notification against a local fake Lobby: a slow cold
 * start is retried with the same idempotency key, and a 4xx is not retried.
 */
async function runShutdownNotifyTests() {
  console.log('🧪 Starting Shutdown Notification Test Suite...\n');

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

  const requests = [];
  let respond = () => 200;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, key: req.headers['idempotency-key'], body: JSON.parse(body) });
    const status = respond(requests.length);
    if (status === 'hang') return; // Simulates a cold Lambda slower than the timeout.
    res.writeHead(status).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');

  const runtimeId = '11111111-1111-4111-8111-111111111111';
  const app = new WorldServiceApp({
    worldId: 'world-test', runtimeId, lobbyApiUrl: `http://127.0.0.1:${server.address().port}`,
  });
  const notify = () => app.notifyLobbyShutdown({ timeoutMs: 200, retryDelayMs: 10 });

  try {
    respond = (n) => (n === 1 ? 'hang' : 200);
    assert(await notify() === true, 'A timed-out first attempt is retried and succeeds');
    assert(requests.length === 2, 'Exactly two attempts were made');
    assert(requests.every((r) => r.key === `shutdown:${runtimeId}`), 'Both attempts share the runtime idempotency key');
    assert(requests[0].url === '/worlds/world-test/shutdown' && requests[0].body.runtimeId === runtimeId, 'The request targets this world and runtime');

    requests.length = 0;
    respond = () => 503;
    assert(await notify() === false, 'Persistent 5xx responses report failure');
    assert(requests.length === 2, 'A 5xx response is retried once');

    requests.length = 0;
    respond = () => 409;
    assert(await notify() === false, 'A stale runtime (409) reports failure');
    assert(requests.length === 1, 'A 4xx response is not retried');
  } finally {
    server.closeAllConnections();
    server.close();
  }

  console.log(`\n📊 Shutdown notification: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runShutdownNotifyTests().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
