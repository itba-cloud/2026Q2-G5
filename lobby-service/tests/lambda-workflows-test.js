import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseFixture } from './helpers/database.js';
import { definition, runWorkflow, validateTransitions } from './helpers/workflow.js';
import { OperationService } from '../src/lifecycle/OperationService.js';
import { LifecycleTasks } from '../src/lifecycle/LifecycleTasks.js';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';
import { createPublicHandler } from '../src/lambda/public/handler.js';
import { createInternalHandler } from '../src/lambda/internal/handler.js';
import { createLifecycleHandler } from '../src/lambda/lifecycle.js';

export const albEvent = (path, method = 'GET', body, { base64 = false, key } = {}) => ({
  requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/local/123' } },
  httpMethod: method, path, queryStringParameters: {}, isBase64Encoded: base64,
  headers: { host: 'lobby.test', 'content-type': 'application/json', ...(key && { 'idempotency-key': key }) },
  body: body ? (base64 ? Buffer.from(JSON.stringify(body)).toString('base64') : JSON.stringify(body)) : '',
});

test('ALB Lambda handlers and actual workflow definitions agree on success and failure', async t => {
  const fixture = await databaseFixture();
  t.after(() => fixture.close());
  const { worlds, operations } = fixture;
  await worlds.registerHost({ id: 'host', hostIp: '127.0.0.1', maxWorlds: 1 });
  const service = new OperationService(worlds, operations);
  let healthProbes = 0;
  const tasks = new LifecycleTasks(worlds, operations, new DockerContainerLauncher({ useMock: true }), {
    probe: async () => ++healthProbes > 1,
  });
  const runtime = { ...fixture, config: { corsOrigins: ['*'] }, service, tasks, announcements: { announce: async () => true } };
  let inits = 0;
  const publicHandler = createPublicHandler(async () => { inits++; return runtime; });
  const internalHandler = createInternalHandler(async () => runtime);
  const lifecycle = createLifecycleHandler(async () => runtime);
  const response = await publicHandler(albEvent('/api/worlds', 'POST', { name: 'Through Lambda', seed: 2 }, { base64: true, key: 'alb' }), {});
  assert.equal(response.statusCode, 202);
  const accepted = JSON.parse(response.body);
  const start = await definition('start');
  const stop = await definition('stop');
  validateTransitions(start);
  validateTransitions(stop);
  const started = await runWorkflow(start, lifecycle, { operationId: accepted.operationId });
  assert.equal(started.status, 'SUCCEEDED');
  assert.ok(started.trace.includes('WaitReady'));
  assert.equal((await operations.get(accepted.operationId)).status, 'SUCCEEDED');
  const world = await worlds.getWorld(accepted.worldId);
  assert.equal(world.status, 'ACTIVE');
  assert.ok(world.wsUrl);
  assert.equal((await publicHandler(albEvent('/hosts'), {})).statusCode, 404);
  assert.equal((await publicHandler(albEvent('/api/announce', 'POST', { message: 'blocked' }), {})).statusCode, 404);
  assert.equal(inits, 1);
  const internalWorlds = JSON.parse((await internalHandler(albEvent('/api/worlds'), {})).body);
  assert.equal(internalWorlds.worlds.find(w => w.id === world.id).hostId, 'host', 'metrics retain placement through internal entry');
  const stale = await internalHandler(albEvent(`/worlds/${world.id}/shutdown`, 'POST', { runtimeId: '11111111-1111-4111-8111-111111111111' }), {});
  assert.equal(stale.statusCode, 409);
  const second = (await service.create({ name: 'No capacity' }, { key: 'full' })).operation;
  assert.equal((await runWorkflow(start, lifecycle, { operationId: second.operation_id })).status, 'FAILED');
  assert.equal((await operations.get(second.operation_id)).status, 'FAILED');
  const shutdownResponse = await internalHandler(albEvent(`/worlds/${world.id}/shutdown`, 'POST', { runtimeId: world.runtimeId }, { key: 'shutdown' }), {});
  assert.equal(shutdownResponse.statusCode, 202);
  const shutdown = JSON.parse(shutdownResponse.body);
  assert.equal((await runWorkflow(stop, lifecycle, { operationId: shutdown.operationId })).status, 'SUCCEEDED');
  assert.equal((await worlds.getWorld(world.id)).status, 'INACTIVE');
});

test('Failed cold initialization is retried by a later invocation', async () => {
  let attempts = 0;
  const handler = createPublicHandler(async () => { attempts++; throw new Error('Transient connection failure'); });
  assert.equal((await handler(albEvent('/health'), {})).statusCode, 503);
  assert.equal((await handler(albEvent('/health'), {})).statusCode, 503);
  assert.equal(attempts, 2);
});


test('Local Choice evaluation rejects absent paths unless an IsPresent guard short-circuits', async () => {
  const asl = { StartAt: 'Task', States: {
    Task: { Type: 'Task', Parameters: { action: 'reserve' }, Next: 'Choice' },
    Choice: { Type: 'Choice', Choices: [{ Variable: '$.task.done', BooleanEquals: true, Next: 'Done' }], Default: 'Done' },
    Done: { Type: 'Succeed' },
  } };
  await assert.rejects(runWorkflow(asl, async () => ({}), { operationId: 'test' }), { name: 'States.Runtime' });
  asl.States.Choice.Choices[0] = { And: [
    { Variable: '$.task.done', IsPresent: true },
    { Variable: '$.task.done', BooleanEquals: true },
  ], Next: 'Done' };
  assert.equal((await runWorkflow(asl, async () => ({}), { operationId: 'test' })).status, 'SUCCEEDED');
});
