import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseFixture } from './helpers/database.js';
import { OperationService } from '../src/lifecycle/OperationService.js';
import { OperationDispatcher } from '../src/worker/OperationDispatcher.js';
import { ReconciliationWorker } from '../src/worker/ReconciliationWorker.js';
import { createMaintenanceHandler } from '../src/lambda/maintenance.js';
import { LifecycleTasks } from '../src/lifecycle/LifecycleTasks.js';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';
import { definition, runWorkflow } from './helpers/workflow.js';

test('Immediate dispatch and scheduled outbox recovery share one execution identity', async t => {
  const f = await databaseFixture();
  t.after(() => f.close());
  let fail = false;
  const executions = new Map();
  const dispatcher = new OperationDispatcher(f.operations, { async send(command) {
    if (fail) throw new Error('Step Functions unavailable');
    if (command.constructor.name === 'DescribeExecutionCommand') return { status: 'RUNNING' };
    executions.set(command.input.name, command.input);
    return { executionArn: `arn:aws:states:us-east-1:123456789012:execution:test-start:${command.input.name}` };
  } });
  const service = new OperationService(f.worlds, f.operations, { dispatcher });
  const ready = (await service.create({ name: 'Immediate' }, { key: 'immediate' })).operation;
  assert.equal(executions.size, 1, 'No scheduled tick needed for the normal path');
  assert.equal((await f.operations.get(ready.operation_id)).status, 'RUNNING');
  fail = true;
  const deferred = (await service.create({ name: 'Deferred' }, { key: 'deferred' })).operation;
  assert.equal((await f.operations.get(deferred.operation_id)).status, 'ACCEPTED');
  fail = false;
  await f.operations.pool.query('UPDATE lobby_operations SET next_attempt_at=now()');
  const tasks = new LifecycleTasks(f.worlds, f.operations, new DockerContainerLauncher({ useMock: true }));
  const maintenance = createMaintenanceHandler(async () => ({ ...f, tasks, dispatcher }));
  await maintenance({}, { getRemainingTimeInMillis: () => 30000 });
  assert.equal(executions.size, 2);
  assert.equal((await f.operations.get(deferred.operation_id)).status, 'RUNNING');
  await maintenance({}, { getRemainingTimeInMillis: () => 30000 });
  assert.equal(executions.size, 2);
});

test('Maintenance resumes across invocations, excludes a second owner and does not starve later records', async t => {
  const f = await databaseFixture();
  t.after(() => f.close());
  for (let n = 0; n < 12; n++) await f.worlds.registerHost({ id: `host-${String(n).padStart(2, '0')}`, hostIp: '127.0.0.1', maxWorlds: 2 });
  const dispatcher = { tick: async () => 0 };
  const tasks = { config: {} };
  const visited = new Set();
  let clock = 0;
  const first = new ReconciliationWorker(f.worlds, f.operations, tasks, dispatcher, { now: () => clock });
  first.checkHost = async host => { visited.add(host.id); clock += 100; if (host.id === 'host-00') throw new Error('One bad host'); };
  for (let n = 0; n < 16; n++) await first.tick({ budgetMs: 100 });
  assert.equal(visited.size, 12, 'Progress continues past the first page and past errors');
  assert.ok(await f.operations.checkpoint('hosts'));
  assert.equal(await f.operations.lease('reconciliation', first.token), true);
  const second = new ReconciliationWorker(f.worlds, f.operations, tasks, dispatcher);
  assert.equal((await second.tick()).skipped, true);
  await f.operations.releaseLease('reconciliation', first.token);
  const state = await f.operations.checkpoint('stage');
  await second.tick({ remainingMs: () => 10000 });
  assert.equal(await f.operations.checkpoint('stage'), state, 'No new work when timeout is close');
});

test('A join checks ACTIVE worlds and restarts a dead container once for simultaneous players', async t => {
  const f = await databaseFixture();
  t.after(() => f.close());
  await f.worlds.registerHost({ id: 'host', hostIp: '127.0.0.1', maxWorlds: 2 });
  const service = new OperationService(f.worlds, f.operations);
  const launcher = new DockerContainerLauncher({ useMock: true });
  let alive = true;
  let launches = 0;
  const launch = launcher.launchWorldContainer.bind(launcher);
  launcher.launchWorldContainer = async (...args) => { launches++; alive = true; return launch(...args); };
  launcher.getContainerStatus = async () => ({ exists: alive, running: alive, status: alive ? 'running' : 'not_found' });
  const tasks = new LifecycleTasks(f.worlds, f.operations, launcher);
  const start = await definition('start');
  const handler = event => tasks.invoke(event.action, event.operationId);
  const created = (await service.create({ name: 'Join me', botCount: 0 }, { key: 'create' })).operation;
  await runWorkflow(start, handler, { operationId: created.operation_id });
  const original = await f.worlds.getWorld(created.target_world_id);
  const liveJoin = await service.submit('START', original.id, {}, { key: 'live' });
  await runWorkflow(start, handler, { operationId: liveJoin.operation_id });
  assert.equal(launches, 1, 'A healthy world is reused');
  assert.equal((await f.worlds.getWorld(original.id)).runtimeId, original.runtimeId);
  alive = false;
  const joins = await Promise.allSettled(['player-1', 'player-2'].map(key => service.submit('START', original.id, {}, { key })));
  const accepted = joins.find(r => r.status === 'fulfilled').value;
  assert.equal(joins.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(joins.find(r => r.status === 'rejected').reason.operationId, accepted.operation_id);
  assert.equal((await runWorkflow(start, handler, { operationId: accepted.operation_id })).status, 'SUCCEEDED');
  const restarted = await f.worlds.getWorld(original.id);
  assert.equal(restarted.status, 'ACTIVE');
  assert.notEqual(restarted.runtimeId, original.runtimeId);
  assert.equal(launches, 2);
  assert.equal((await f.worlds.listWorlds()).filter(w => w.hostId === 'host' && w.status === 'ACTIVE').length, 1);
});

test('A world nobody rejoins is reconciled and its capacity is eventually released', async t => {
  const f = await databaseFixture();
  t.after(() => f.close());
  await f.worlds.registerHost({ id: 'host', hostIp: '127.0.0.1', maxWorlds: 1 });
  const service = new OperationService(f.worlds, f.operations);
  const launcher = new DockerContainerLauncher({ useMock: true });
  const tasks = new LifecycleTasks(f.worlds, f.operations, launcher);
  const created = (await service.create({ name: 'Abandoned' }, { key: 'abandoned' })).operation;
  for (const action of ['reserve','launch','confirm','finish']) await tasks.invoke(action, created.operation_id);
  launcher.getContainerStatus = async () => ({ exists: false, running: false, status: 'not_found' });
  const stop = await definition('stop');
  const dispatcher = new OperationDispatcher(f.operations, { async send(command) {
    if (command.constructor.name === 'DescribeExecutionCommand') return { status: 'SUCCEEDED' };
    await runWorkflow(stop, event => tasks.invoke(event.action, event.operationId), { operationId: command.input.name });
    return { executionArn: `arn:aws:states:us-east-1:123456789012:execution:test-stop:${command.input.name}` };
  } });
  await new ReconciliationWorker(f.worlds, f.operations, tasks, dispatcher).tick();
  const world = await f.worlds.getWorld(created.target_world_id);
  assert.equal(world.status, 'INACTIVE');
  assert.equal(world.hostId, null);
  assert.equal(world.port, null);
});

test('On-demand checks retain uncertain capacity and reject a foreign container', async t => {
  const f = await databaseFixture();
  t.after(() => f.close());
  await f.worlds.registerHost({ id: 'host', hostIp: '127.0.0.1', maxWorlds: 2 });
  const service = new OperationService(f.worlds, f.operations);
  const launcher = new DockerContainerLauncher({ useMock: true });
  const tasks = new LifecycleTasks(f.worlds, f.operations, launcher);
  const create = (await service.create({ name: 'Uncertain' }, { key: 'create' })).operation;
  for (const action of ['reserve','launch','confirm','finish']) await tasks.invoke(action, create.operation_id);
  const original = await f.worlds.getWorld(create.target_world_id);
  launcher.getContainerStatus = async () => ({ hostUnreachable: true });
  const join = await service.submit('START', original.id, {}, { key: 'uncertain' });
  assert.equal((await tasks.invoke('reserve', join.operation_id)).recoveryPending, true);
  assert.equal((await f.worlds.getWorld(original.id)).containerId, original.containerId);
  assert.equal((await f.worlds.getWorld(original.id)).runtimeId, original.runtimeId);
  launcher.isMockMode = () => false;
  launcher.getContainerStatus = async () => ({ exists: true, running: true, labels: { 'elastic-worlds.world-id': 'another-world' } });
  let removed = 0;
  launcher.stopWorldContainer = async () => { removed++; return true; };
  assert.equal((await tasks.invoke('cleanup', join.operation_id, { recovery: true })).recoveryPending, true);
  assert.equal(removed, 0);
  assert.equal((await f.worlds.getWorld(original.id)).port, original.port);
});

test('A stale host snapshot cannot overwrite a new heartbeat or prune its host', async t => {
  const f = await databaseFixture();
  t.after(() => f.close());
  await f.worlds.registerHost({ id: 'renewed', hostIp: '127.0.0.1', maxWorlds: 1 });
  const reconciler = new ReconciliationWorker(f.worlds, f.operations, {}, {});
  await reconciler.checkHost({ id: 'renewed', status: 'HEALTHY', lastHeartbeat: new Date(Date.now()-600000).toISOString() });
  assert.equal((await f.worlds.getHost('renewed')).status, 'HEALTHY');
});

test('Restart resumes if the old container was removed before a database interruption', async t => {
  const f = await databaseFixture();
  t.after(() => f.close());
  await f.worlds.registerHost({ id: 'host', hostIp: '127.0.0.1', maxWorlds: 1 });
  const service = new OperationService(f.worlds, f.operations);
  const launcher = new DockerContainerLauncher({ useMock: true });
  const tasks = new LifecycleTasks(f.worlds, f.operations, launcher);
  const first = (await service.create({ name: 'Partial restart' }, { key: 'first' })).operation;
  for (const action of ['reserve','launch','confirm','finish']) await tasks.invoke(action, first.operation_id);
  launcher.getContainerStatus = async () => ({ exists: false, running: false, status: 'not_found' });
  const restart = await service.submit('START', first.target_world_id, {}, { key: 'restart' });
  const context = tasks.context.bind(tasks);
  let failed = false;
  tasks.context = async (...args) => {
    const op = await f.operations.get(restart.operation_id);
    if (!failed && op.context.phase === 'RELEASED') {
      failed = true;
      throw Object.assign(new Error('Connection lost between release and re-reserve'), { code: 'ECONNRESET' });
    }
    return context(...args);
  };
  await assert.rejects(tasks.invoke('reserve', restart.operation_id), { code: 'ECONNRESET' });
  assert.equal((await f.worlds.getWorld(first.target_world_id)).status, 'INACTIVE');
  assert.equal((await tasks.invoke('reserve', restart.operation_id)).active, false);
  const world = await f.worlds.getWorld(first.target_world_id);
  assert.equal(world.status, 'STARTING');
  assert.equal(world.runtimeId, restart.operation_id);
});
