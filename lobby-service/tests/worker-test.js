import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseFixture } from './helpers/database.js';
import { OperationService } from '../src/lifecycle/OperationService.js';
import { LifecycleTasks } from '../src/lifecycle/LifecycleTasks.js';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';
import { OperationDispatcher } from '../src/worker/OperationDispatcher.js';
import { ReconciliationWorker } from '../src/worker/ReconciliationWorker.js';

test('Dispatcher recovers a lost ARN and never starts a second execution', async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const { worlds, operations } = fixture;
  const service = new OperationService(worlds, operations);
  const op = (await service.create({ name: 'Dispatch crash' }, { key: 'dispatch' })).operation;
  const executions = new Map();
  const client = { async send(command) {
    const input = command.input;
    if (command.constructor.name === 'StartExecutionCommand') {
      if (executions.size) { const err = new Error(); err.name = 'ExecutionAlreadyExists'; throw err; }
      const executionArn = `arn:aws:states:us-east-1:123456789012:execution:test-start:${input.name}`;
      executions.set(executionArn, { executionArn, input: input.input, stateMachineVersionArn: input.stateMachineArn, status: 'SUCCEEDED' });
      return { executionArn };
    }
    return executions.get(input.executionArn);
  } };
  const dispatcher = new OperationDispatcher(operations, client);
  const dispatched = operations.dispatched.bind(operations);
  operations.dispatched = async () => { throw new Error('Worker crashed before saving ARN'); };
  await dispatcher.tick();
  assert.equal((await operations.get(op.operation_id)).status, 'ACCEPTED');
  await operations.pool.query('UPDATE lobby_operations SET next_attempt_at=now() WHERE operation_id=$1', [op.operation_id]);
  operations.dispatched = dispatched;
  await dispatcher.tick();
  assert.equal(executions.size, 1);
  assert.ok((await operations.get(op.operation_id)).execution_arn);
  assert.equal((await operations.get(op.operation_id)).status, 'RUNNING');
});

test('Recovery waits for running Lambda lease and compensates only after quiescence', async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const { worlds, operations } = fixture;
  await worlds.registerHost({ id: 'host', hostIp: '127.0.0.1', maxWorlds: 4 });
  const service = new OperationService(worlds, operations);
  const tasks = new LifecycleTasks(worlds, operations, new DockerContainerLauncher({ useMock: true }));
  let status = 'RUNNING';
  const dispatcher = new OperationDispatcher(operations, { async send(command) {
    if (command.constructor.name === 'StopExecutionCommand') { status = 'ABORTED'; return {}; }
    return { status };
  } });
  const worker = new ReconciliationWorker(worlds, operations, tasks, dispatcher);
  const op = (await service.create({ name: 'Interrupted' }, { key: 'interrupted' })).operation;
  await tasks.invoke('reserve', op.operation_id);
  await tasks.invoke('launch', op.operation_id);
  const task = await operations.claimTask(op.operation_id);
  await operations.pool.query(`UPDATE lobby_operations SET deadline_at=now()-interval '1 second' WHERE operation_id=$1`, [op.operation_id]);
  await worker.recover(await operations.get(op.operation_id));
  assert.equal(status, 'ABORTED');
  await worker.recover(await operations.get(op.operation_id));
  assert.equal((await worlds.getWorld(op.target_world_id)).status, 'STARTING');
  await operations.pool.query(`UPDATE lobby_operations SET task_expires_at=now()-interval '1 second' WHERE operation_id=$1`, [op.operation_id]);
  await worker.recover(await operations.get(op.operation_id));
  assert.equal((await worlds.getWorld(op.target_world_id)).status, 'INACTIVE');
  assert.equal((await operations.get(op.operation_id)).status, 'FAILED');
  await assert.rejects(operations.taskWrite(op.operation_id, task.token, () => {}), { code: 'TASK_OWNERSHIP_LOST' });

  assert.equal(await operations.lease('leader', '11111111-1111-4111-8111-111111111111'), true);
  assert.equal(await operations.lease('leader', '22222222-2222-4222-8222-222222222222'), false);
  await operations.pool.query(`UPDATE lobby_worker_leases SET expires_at=now()-interval '1 second' WHERE name='leader'`);
  assert.equal(await operations.lease('leader', '22222222-2222-4222-8222-222222222222'), true);
  assert.equal(await operations.lease('leader', '11111111-1111-4111-8111-111111111111'), false);
});
