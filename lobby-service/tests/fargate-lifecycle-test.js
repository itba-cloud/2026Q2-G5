import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseFixture } from './helpers/database.js';
import { OperationService } from '../src/lifecycle/OperationService.js';
import { LifecycleTasks } from '../src/lifecycle/LifecycleTasks.js';
import { FargateWorldLauncher } from '../src/orchestrator/FargateWorldLauncher.js';

// In-memory ECS: tasks are keyed by clientToken, like RunTask's idempotency.
function fakeEcs() {
  const tasks = new Map();
  const arn = token => `arn:aws:ecs:us-east-1:123456789012:task/ewo/${token}`;
  return { tasks, arn, async send(command) {
    const input = command.input;
    switch (command.constructor.name) {
      case 'RunTaskCommand':
        if (!tasks.has(arn(input.clientToken))) tasks.set(arn(input.clientToken), {
          taskArn: arn(input.clientToken), startedBy: input.startedBy, lastStatus: 'PROVISIONING', desiredStatus: 'RUNNING',
          tags: input.tags, attachments: [],
        });
        return { tasks: [tasks.get(arn(input.clientToken))] };
      case 'DescribeTasksCommand': return { tasks: input.tasks.map(id => tasks.get(id)).filter(Boolean) };
      case 'ListTasksCommand': return { taskArns: [...tasks.values()]
        .filter(t => t.startedBy === input.startedBy && t.desiredStatus === 'RUNNING').map(t => t.taskArn) };
      case 'StopTaskCommand': Object.assign(tasks.get(input.task), { desiredStatus: 'STOPPED', lastStatus: 'DEACTIVATING' }); return {};
      default: throw new Error(`unexpected ${command.constructor.name}`);
    }
  } };
}

const attach = (task, ip) => Object.assign(task, { lastStatus: 'RUNNING', attachments: [{ type: 'ElasticNetworkInterface',
  details: [{ name: 'networkInterfaceId', value: `eni-${ip}` }, { name: 'privateIPv4Address', value: ip }] }] });

test('Fargate worlds start without hosts, resolve their address and drain on stop', async t => {
  const fixture = await databaseFixture();
  const { worlds, operations } = fixture;
  t.after(() => fixture.close());
  const ecs = fakeEcs();
  const ec2 = { async send(command) {
    const [eni] = command.input.NetworkInterfaceIds;
    return { NetworkInterfaces: [{ Association: { PublicIp: `54.0.0.${eni.split('.').at(-1)}` } }] };
  } };
  const launcher = new FargateWorldLauncher({ cluster: 'ewo', taskDefinition: 'ewo-world:1', subnets: ['s'], securityGroups: ['g'] }, { ecs, ec2 });
  const probed = [];
  let clock = Date.now();
  const tasks = new LifecycleTasks(worlds, operations, launcher, {
    config: { healthTimeoutMs: 120000 }, now: () => clock,
    probe: async (host, world) => { probed.push(`${host.hostIp}:${world.port}`); return true; },
  });
  const service = new OperationService(worlds, operations);
  const create = async name => (await service.create({ name, seed: 1 }, { key: name })).operation;
  const invoke = (op, action) => tasks.invoke(action, op.operation_id);

  // No World Host registered: reserve still succeeds and every world uses the task port.
  const first = await create('Fargate uno');
  const second = await create('Fargate dos');
  for (const op of [first, second]) {
    await invoke(op, 'reserve');
    await invoke(op, 'launch');
    await invoke(op, 'launch');
  }
  assert.equal(ecs.tasks.size, 2);
  const reserved = await worlds.getWorld(first.target_world_id);
  assert.equal(reserved.hostId, null);
  assert.equal(reserved.port, 8001);
  assert.equal((await worlds.getWorld(second.target_world_id)).port, 8001);

  const task = ecs.tasks.get(ecs.arn(first.operation_id));
  assert.equal((await invoke(first, 'health')).ready, false);
  attach(task, '10.0.1.7');
  assert.equal((await invoke(first, 'health')).ready, true);
  assert.deepEqual(probed, ['10.0.1.7:8001']);
  for (const action of ['confirm', 'bots', 'finish']) await invoke(first, action);
  const active = await worlds.getWorld(first.target_world_id);
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.wsUrl, 'ws://54.0.0.7:8001');
  assert.equal(active.containerId, task.taskArn);
  // NPC replicas dial the task's private address, never the public one.
  const npcTarget = async id => (await worlds.pool.query(
    'SELECT npc_ws_url, npc_bot_count FROM worlds WHERE world_id=$1', [id])).rows[0];
  assert.deepEqual(await npcTarget(first.target_world_id), { npc_ws_url: 'ws://10.0.1.7:8001', npc_bot_count: active.botCount });

  const stop = await service.submit('STOP', first.target_world_id, {}, { key: 'stop-first', visibility: 'internal' });
  for (const action of ['claimStop', 'despawn']) await invoke(stop, action);
  assert.equal((await invoke(stop, 'remove')).removed, false);
  assert.equal(task.desiredStatus, 'STOPPED');
  assert.equal((await worlds.getWorld(first.target_world_id)).status, 'STOPPING');
  task.lastStatus = 'STOPPED';
  assert.equal((await invoke(stop, 'remove')).removed, true);
  for (const action of ['release', 'finish']) await invoke(stop, action);
  assert.equal((await worlds.getWorld(first.target_world_id)).status, 'INACTIVE');
  assert.deepEqual(await npcTarget(first.target_world_id), { npc_ws_url: null, npc_bot_count: 0 });

  // A task that exits before /health fails the start and releases the world.
  Object.assign(ecs.tasks.get(ecs.arn(second.operation_id)), { lastStatus: 'STOPPED', desiredStatus: 'STOPPED' });
  assert.equal((await invoke(second, 'health')).failed, true);
  await invoke(second, 'cleanup');
  await invoke(second, 'recordFailure');
  assert.equal((await operations.get(second.operation_id)).error.code, 'TASK_STOPPED');
  assert.equal((await worlds.getWorld(second.target_world_id)).status, 'INACTIVE');

  // A START cleanup cannot wait for StopTask: it leaves the task to recovery.
  const slow = await create('Fargate lento');
  await invoke(slow, 'reserve');
  await invoke(slow, 'launch');
  clock += 120001;
  assert.equal((await invoke(slow, 'health')).failed, true);
  assert.equal((await invoke(slow, 'cleanup')).recoveryPending, true);
  assert.equal(ecs.tasks.get(ecs.arn(slow.operation_id)).desiredStatus, 'STOPPED');
  assert.equal((await worlds.getWorld(slow.target_world_id)).status, 'STARTING');
  ecs.tasks.get(ecs.arn(slow.operation_id)).lastStatus = 'STOPPED';
  await tasks.invoke('cleanup', slow.operation_id, { recovery: true });
  assert.equal((await worlds.getWorld(slow.target_world_id)).status, 'INACTIVE');
});
