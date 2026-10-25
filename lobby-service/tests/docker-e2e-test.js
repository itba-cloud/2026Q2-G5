import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { databaseFixture } from './helpers/database.js';
import { definition, runWorkflow } from './helpers/workflow.js';
import { OperationService } from '../src/lifecycle/OperationService.js';
import { LifecycleTasks } from '../src/lifecycle/LifecycleTasks.js';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';
import { createLobbyHttpApp } from '../src/server.js';
import { createLifecycleHandler } from '../src/lambda/lifecycle.js';
import { OperationDispatcher } from '../src/worker/OperationDispatcher.js';
import { createMaintenanceHandler } from '../src/lambda/maintenance.js';
import { LocalWorkflowClient } from './helpers/local-workflows.js';

test('HTTP acceptance → PostgreSQL → workflow tasks → real Docker world → WebSocket → stop', { timeout: 60000 }, async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const { worlds, operations } = fixture;
  const service = new OperationService(worlds, operations);
  const launcher = new DockerContainerLauncher({ useMock: false, defaultImage: process.env.TEST_WORLD_IMAGE || 'ewo-world-migration-test:local' });
  const tasks = new LifecycleTasks(worlds, operations, launcher);
  const handler = createLifecycleHandler(async () => ({ tasks }));
  const server = createLobbyHttpApp({ corsOrigins: ['*'] }, worlds, null, null, { operationService: service, profile: 'internal' }).listen(0, '0.0.0.0');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const proxy = http.createServer((req, res) => {
    const upstream = http.request({ socketPath: process.env.TEST_DOCKER_SOCKET || '/var/run/docker.sock', path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  }).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const host = await worlds.registerHost({ id: 'docker-e2e-host', hostIp: '127.0.0.1', publicHost: '127.0.0.1',
    dockerApiUrl: `http://127.0.0.1:${proxy.address().port}`, maxWorlds: 1, portRange: { min: 18501, max: 18501 } });
  const previousStorage = process.env.WORLD_STORAGE_MODE;
  const previousRedis = process.env.REDIS_URL;
  const previousLobby = process.env.LOBBY_LOAD_BALANCER_URL;
  process.env.WORLD_STORAGE_MODE = 'local';
  process.env.REDIS_URL = '';
  process.env.LOBBY_LOAD_BALANCER_URL = `http://host.docker.internal:${server.address().port}`;
  t.after(() => {
    if (previousStorage === undefined) delete process.env.WORLD_STORAGE_MODE; else process.env.WORLD_STORAGE_MODE = previousStorage;
    if (previousRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousRedis;
    if (previousLobby === undefined) delete process.env.LOBBY_LOAD_BALANCER_URL; else process.env.LOBBY_LOAD_BALANCER_URL = previousLobby;
  });
  let containerId;
  t.after(async () => { if (containerId) await promisify(execFile)('docker', ['rm', '-f', containerId]).catch(() => {}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/worlds`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'real-docker-e2e' }, body: JSON.stringify({ name: 'Docker E2E', seed: 12345, botCount: 0 }) });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  const startResult = await runWorkflow(await definition('start'), async event => {
    const value = await handler(event);
    containerId = (await worlds.getWorld(accepted.worldId))?.containerId || containerId;
    return value;
  }, { operationId: accepted.operationId }, { wait: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)) });
  assert.equal(startResult.status, 'SUCCEEDED');
  const operation = (await (await fetch(`${base}/operations/${accepted.operationId}`)).json()).operation;
  assert.equal(operation.status, 'SUCCEEDED');
  assert.equal(operation.result.world.status, 'ACTIVE');
  const inspection = await launcher.getContainerStatus(host, containerId);
  assert.equal(inspection.running, true);
  assert.equal(inspection.labels['elastic-worlds.reservation-token'], accepted.operationId);
  const ws = new WebSocket(operation.result.wsUrl);
  t.after(() => ws.close());
  const initialized = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket INIT timeout')), 5000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'JOIN', payload: { playerName: 'MigrationTester' } })));
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket connection failed')); });
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'INIT') { clearTimeout(timeout); resolve(message.payload); }
    });
  });
  assert.equal(initialized.worldId, accepted.worldId);
  assert.equal(initialized.player.name, 'MigrationTester');
  ws.close();

  const liveJoin = await (await fetch(`${base}/worlds/${accepted.worldId}/start`, { method: 'POST', headers: { 'Idempotency-Key': 'join-live' } })).json();
  await runWorkflow(await definition('start'), handler, { operationId: liveJoin.operationId });
  assert.equal((await worlds.getWorld(accepted.worldId)).containerId, containerId, 'Healthy join reuses the actual container');
  const killed = await fetch(`${host.dockerApiUrl}/containers/${containerId}/kill?signal=SIGKILL`, { method: 'POST' });
  assert.equal(killed.status, 204);
  const beforeRecovery = containerId;
  const joins = await Promise.all(['join-a','join-b'].map(key => fetch(`${base}/worlds/${accepted.worldId}/start`, {
    method: 'POST', headers: { 'Idempotency-Key': key },
  })));
  assert.deepEqual(joins.map(r => r.status).sort(), [202,409]);
  const join = await joins.find(r => r.status === 202).json();
  assert.equal((await runWorkflow(await definition('start'), handler, { operationId: join.operationId }, {
    wait: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
  })).status, 'SUCCEEDED');
  containerId = (await worlds.getWorld(accepted.worldId)).containerId;
  assert.notEqual(containerId, beforeRecovery);
  assert.equal((await launcher.getContainerStatus(host, beforeRecovery)).exists, false);
  assert.equal((await launcher.getContainerStatus(host, containerId)).running, true);
  const stoppedResponse = await fetch(`${base}/worlds/${accepted.worldId}/stop`, { method: 'POST', headers: { 'Idempotency-Key': 'stop-real-docker' } });
  const stop = await stoppedResponse.json();
  assert.equal(stoppedResponse.status, 202);
  const stopped = await runWorkflow(await definition('stop'), handler, { operationId: stop.operationId });
  assert.equal(stopped.status, 'SUCCEEDED');
  assert.equal((await worlds.getWorld(accepted.worldId)).status, 'INACTIVE');
  assert.equal((await launcher.getContainerStatus(host, containerId)).exists, false);

  // Restart and let the world perform its own shutdown, preserving its final snapshot.
  const restartResponse = await fetch(`${base}/worlds/${accepted.worldId}/start`, { method: 'POST', headers: { 'Idempotency-Key': 'restart-for-self-shutdown' } });
  const restart = await restartResponse.json();
  const restarted = await runWorkflow(await definition('start'), handler, { operationId: restart.operationId }, { wait: seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)) });
  assert.equal(restarted.status, 'SUCCEEDED');
  containerId = (await worlds.getWorld(accepted.worldId)).containerId;
  const signalled = await fetch(`${host.dockerApiUrl}/containers/${containerId}/kill?signal=SIGTERM`, { method: 'POST' });
  assert.equal(signalled.status, 204);
  let callback;
  for (let attempt = 0; attempt < 80; attempt++) {
    callback = (await operations.pool.query(`SELECT * FROM lobby_operations WHERE target_world_id=$1 AND kind='SELF_SHUTDOWN'`, [accepted.worldId])).rows[0];
    const state = await launcher.getContainerStatus(host, containerId);
    if (callback && !state.running) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(callback, 'The actual world callback is accepted with the new runtime identity');
  assert.equal(callback.request.runtimeId, restart.operationId);
  assert.equal((await worlds.getWorld(accepted.worldId)).status, 'ACTIVE', 'A callback alone does not release unverified placement');
  const directory = await mkdtemp(path.join(tmpdir(), 'ewo-final-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotFile = path.join(directory, 'snapshot.json');
  await promisify(execFile)('docker', ['cp', `${containerId}:/app/.data/${accepted.worldId}.json`, snapshotFile]);
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  assert.equal(snapshot.world_id, accepted.worldId, 'Final snapshot belongs to the actual world');
  assert.equal(snapshot.seed, 12345);
  const selfStopped = await runWorkflow(await definition('stop'), handler, { operationId: callback.operation_id });
  assert.equal(selfStopped.status, 'SUCCEEDED');
  assert.equal((await worlds.getWorld(accepted.worldId)).status, 'INACTIVE');
  assert.equal((await launcher.getContainerStatus(host, containerId)).exists, false);

  // No permanent dispatcher: API dispatches immediately through the local AWS
  // double; a manual scheduled invocation later cleans up a world nobody rejoins.
  const client = new LocalWorkflowClient(operations, handler);
  t.after(() => client.drain());
  const dispatcher = new OperationDispatcher(operations, client);
  service.dispatcher = dispatcher;
  const lastStart = await (await fetch(`${base}/worlds/${accepted.worldId}/start`, {
    method: 'POST', headers: { 'Idempotency-Key': 'scheduled-abandoned' },
  })).json();
  await client.drain();
  assert.equal((await operations.get(lastStart.operationId)).status, 'SUCCEEDED');
  containerId = (await worlds.getWorld(accepted.worldId)).containerId;
  await fetch(`${host.dockerApiUrl}/containers/${containerId}/kill?signal=SIGKILL`, { method: 'POST' });
  const maintenance = createMaintenanceHandler(async () => ({ worlds, operations, tasks, dispatcher }));
  await maintenance({}, { getRemainingTimeInMillis: () => 30000 });
  await client.drain();
  assert.equal((await worlds.getWorld(accepted.worldId)).status, 'INACTIVE');
  assert.equal((await launcher.getContainerStatus(host, containerId)).exists, false);
});
