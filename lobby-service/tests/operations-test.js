import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { databaseFixture } from './helpers/database.js';
import { OperationService } from '../src/lifecycle/OperationService.js';
import { createLobbyHttpApp } from '../src/server.js';

test('Durable acceptance, deduplication and HTTP profiles', async t => {
  const fixture = await databaseFixture();
  const { worlds, operations } = fixture;
  const service = new OperationService(worlds, operations);
  t.after(() => fixture.close());

  const results = await Promise.all(Array.from({ length: 8 }, () => service.create({ name: 'Atomic world', seed: 1 }, { key: 'one-intent' })));
  const op = results[0].operation;
  assert.equal(new Set(results.map(r => r.operation.operation_id)).size, 1);
  assert.equal((await worlds.listWorlds()).filter(w => w.name === 'Atomic world').length, 1);
  assert.equal((await worlds.getWorld(op.target_world_id)).status, 'INACTIVE');
  await assert.rejects(service.create({ name: 'Different input' }, { key: 'one-intent' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(service.submit('START', op.target_world_id, {}, { key: 'different-intent' }), { code: 'OPERATION_PENDING' });
  const stop = await service.submit('STOP', op.target_world_id, {}, { key: 'cancel', visibility: 'internal' });
  assert.equal((await operations.get(op.operation_id)).cancel_requested, true);
  assert.notEqual(stop.operation_id, op.operation_id);
  const claimed = await Promise.all([operations.claimDispatch(1), operations.claimDispatch(1)]);
  assert.equal(new Set(claimed.flat().map(o => o.operation_id)).size, 2);

  const badService = new OperationService(worlds, new (operations.constructor)(worlds, {}));
  await assert.rejects(badService.create({ name: 'Rollback world' }, { key: 'rollback' }), { code: 'WORKFLOW_NOT_CONFIGURED' });
  assert.equal((await worlds.listWorlds()).some(w => w.name === 'Rollback world'), false);

  const app = createLobbyHttpApp({ corsOrigins: ['*'] }, worlds, null, null, { profile: 'public', operationService: service });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/hosts', '/api/hosts', '/announce', `/worlds/${op.target_world_id}/stop`]) {
    assert.equal((await fetch(`${base}${path}`, { method: 'POST' })).status, 404);
  }
  assert.equal((await fetch(`${base}/operations/${stop.operation_id}`)).status, 404);
  const created = await fetch(`${base}/api/worlds`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http' }, body: JSON.stringify({ name: 'HTTP world' }) });
  assert.equal(created.status, 202);
  const payload = await created.json();
  assert.ok(payload.operationId);
  assert.equal(payload.wsUrl, undefined);
  const operationResponse = await (await fetch(`${base}/api/operations/${payload.operationId}`)).json();
  assert.equal(operationResponse.operation.status, 'ACCEPTED');
  assert.equal(operationResponse.operation.context, undefined);
  assert.equal(operationResponse.operation.execution_arn, undefined);

  const create = service.create.bind(service);
  service.create = async () => { throw Object.assign(new Error('Connection lost while committing'), { code: 'ECONNRESET' }); };
  const unavailable = await fetch(`${base}/worlds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unknown commit result' }) });
  assert.equal(unavailable.status, 503, 'An uncertain commit must remain retryable with the same idempotency key');
  assert.equal((await unavailable.json()).error, 'Servicio temporalmente no disponible');
  service.create = create;
});
