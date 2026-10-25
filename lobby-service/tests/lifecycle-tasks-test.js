import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseFixture } from './helpers/database.js';
import { OperationService } from '../src/lifecycle/OperationService.js';
import { LifecycleTasks } from '../src/lifecycle/LifecycleTasks.js';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';

test('Lifecycle ownership, compensation, cancellation and generations', async t => {
  const fixture = await databaseFixture();
  const { worlds, operations } = fixture;
  t.after(() => fixture.close());
  await worlds.registerHost({ id: 'host', hostIp: '127.0.0.1', maxWorlds: 4, portRange: { min: 18001, max: 18004 } });
  const service = new OperationService(worlds, operations);
  const launcher = new DockerContainerLauncher({ useMock: true });
  const tasks = new LifecycleTasks(worlds, operations, launcher);
  const create = async name => (await service.create({ name, seed: 1 }, { key: name })).operation;
  const invoke = (op, action) => tasks.invoke(action, op.operation_id);
  const runStart = async op => {
    for (const action of ['reserve', 'launch', 'health', 'confirm', 'bots', 'finish']) await invoke(op, action);
  };
  const op = await create('Ready world');
  await invoke(op, 'reserve');
  await invoke(op, 'reserve');
  const lease = await operations.claimTask(op.operation_id);
  await assert.rejects(invoke(op, 'launch'), { code: 'TASK_BUSY' });
  await operations.releaseTask(op.operation_id, lease.token);
  await invoke(op, 'launch');
  const firstContainer = (await worlds.getWorld(op.target_world_id)).containerId;
  await invoke(op, 'launch');
  assert.equal((await worlds.getWorld(op.target_world_id)).containerId, firstContainer);
  await assert.rejects(operations.taskWrite(op.operation_id, lease.token, () => {}), { code: 'TASK_OWNERSHIP_LOST' });
  for (const action of ['health', 'confirm', 'bots', 'finish']) await invoke(op, action);
  assert.equal((await operations.get(op.operation_id)).status, 'SUCCEEDED');
  assert.equal((await operations.get(op.operation_id)).result.warning, undefined, 'Bots no longer depend on a reachable NPC endpoint');
  assert.equal((await worlds.getWorld(op.target_world_id)).runtimeId, op.operation_id);
  const npcTarget = (await worlds.pool.query('SELECT npc_ws_url, npc_bot_count FROM worlds WHERE world_id=$1', [op.target_world_id])).rows[0];
  assert.equal(npcTarget.npc_bot_count, 2, 'The created world asks NPC replicas for its default bots');
  assert.match(npcTarget.npc_ws_url, /^ws:\/\//);

  const cancelled = await create('Cancelled before reserve');
  const stop = await service.submit('STOP', cancelled.target_world_id, {}, { key: 'cancel-before', visibility: 'internal' });
  assert.equal((await invoke(cancelled, 'reserve')).failed, true);
  assert.equal((await invoke(stop, 'claimStop')).waiting, true);
  await invoke(cancelled, 'cleanup');
  await invoke(cancelled, 'recordFailure');
  assert.equal((await operations.get(cancelled.operation_id)).status, 'CANCELLED');
  await invoke(stop, 'claimStop');
  await invoke(stop, 'finish');
  assert.equal((await worlds.getWorld(cancelled.target_world_id)).status, 'INACTIVE');

  const during = await create('Cancelled after Docker');
  await invoke(during, 'reserve');
  await invoke(during, 'launch');
  await service.submit('STOP', during.target_world_id, {}, { key: 'during', visibility: 'internal' });
  assert.equal((await invoke(during, 'confirm')).failed, true);
  await invoke(during, 'cleanup');
  await invoke(during, 'recordFailure');
  assert.equal((await worlds.getWorld(during.target_world_id)).status, 'INACTIVE');

  const failed = await create('Unreachable cleanup');
  await invoke(failed, 'reserve');
  await invoke(failed, 'launch');
  const inspect = launcher.getContainerStatus.bind(launcher);
  launcher.getContainerStatus = async () => ({ exists: false, hostUnreachable: true });
  assert.equal((await invoke(failed, 'cleanup')).recoveryPending, true);
  assert.equal((await worlds.getWorld(failed.target_world_id)).status, 'STARTING');
  assert.equal((await operations.get(failed.operation_id)).status, 'RECOVERY_PENDING');
  launcher.getContainerStatus = inspect;

  const stopping = await service.submit('STOP', op.target_world_id, {}, { key: 'stop-ready', visibility: 'internal' });
  for (const action of ['claimStop', 'despawn', 'remove', 'release', 'finish']) await invoke(stopping, action);
  const restarted = await service.submit('START', op.target_world_id, {}, { key: 'restart' });
  await assert.rejects(service.submit('SELF_SHUTDOWN', op.target_world_id, { runtimeId: op.operation_id }, { key: 'old-while-accepted' }), { code: 'STALE_RUNTIME' });
  assert.equal((await operations.get(restarted.operation_id)).cancel_requested, false);
  await runStart(restarted);
  await assert.rejects(service.submit('SELF_SHUTDOWN', op.target_world_id, { runtimeId: op.operation_id }, { key: 'stale' }), { code: 'STALE_RUNTIME' });
  assert.equal((await worlds.getWorld(op.target_world_id)).runtimeId, restarted.operation_id);

  let clock = Date.now();
  const slowTasks = new LifecycleTasks(worlds, operations, launcher, { config: { healthTimeoutMs: 1000 }, now: () => clock, probe: async () => false });
  const slow = await create('Readiness timeout');
  await slowTasks.invoke('reserve', slow.operation_id);
  await slowTasks.invoke('launch', slow.operation_id);
  assert.equal((await slowTasks.invoke('health', slow.operation_id)).ready, false);
  clock += 1001;
  assert.equal((await slowTasks.invoke('health', slow.operation_id)).failed, true);
  await slowTasks.invoke('cleanup', slow.operation_id);
  await slowTasks.invoke('recordFailure', slow.operation_id);
  assert.equal((await operations.get(slow.operation_id)).error.code, 'HEALTH_TIMEOUT');
  assert.equal((await worlds.getWorld(slow.target_world_id)).status, 'INACTIVE');

  const deleted = await service.submit('DELETE', op.target_world_id, {}, { key: 'delete', visibility: 'internal' });
  for (const action of ['claimStop', 'despawn', 'remove', 'release', 'delete', 'finish']) await invoke(deleted, action);
  assert.equal(await worlds.getWorld(op.target_world_id), null);
  const history = await operations.get(deleted.operation_id);
  assert.equal(history.status, 'SUCCEEDED');
  assert.equal(history.world_id, null);
  assert.equal(history.target_world_id, op.target_world_id);
});
