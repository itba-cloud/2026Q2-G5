import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.window = { location: { protocol: 'http:', hostname: 'localhost' } };
const { ApiClient } = await import('../js/api.js');
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const active = { id: 'world', status: 'ACTIVE', wsUrl: 'ws://host:8001', runtimeId: 'runtime' };
const storage = () => {
  const values = new Map();
  return { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
};

test('Lost acceptance response retries with the same key, then waits for current active generation', async () => {
  const keys = [];
  let polls = 0;
  const statuses = [];
  const api = new ApiClient('http://lobby', { storage: storage(), wait: async () => {}, fetch: async (url, options = {}) => {
    if (options.method === 'POST') {
      keys.push(options.headers['Idempotency-Key']);
      if (keys.length === 1) throw new Error('Response lost after commit');
      return response({ operationId: 'op', worldId: 'world', status: 'ACCEPTED' }, 202);
    }
    if (url.includes('/operations/')) return response({ operation: { worldId: 'world', status: ++polls === 1 ? 'RUNNING' : 'SUCCEEDED', result: { world: active, wsUrl: active.wsUrl } } });
    return response({ world: active });
  } });
  const result = await api.startWorld('world', { onProgress: status => statuses.push(status) });
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 1);
  assert.deepEqual(statuses, ['RUNNING', 'SUCCEEDED']);
  assert.equal(result.wsUrl, active.wsUrl);
});

test('Polling timeout persists the operation across reload and never resubmits START', async () => {
  const session = storage();
  let clock = 0;
  let posts = 0;
  let finished = false;
  const options = { storage: session, now: () => clock, pollTimeoutMs: 1000,
    wait: async ms => { clock += ms; }, fetch: async (url, opts = {}) => {
      if (opts.method === 'POST') { posts++; return response({ operationId: 'pending-op' }, 202); }
      if (url.includes('/operations/')) return response({ operation: { worldId: 'world', status: finished ? 'SUCCEEDED' : 'RUNNING', result: { world: active } } });
      return response({ world: active });
    } };
  const api = new ApiClient('http://lobby', options);
  await assert.rejects(api.startWorld('world'), error => error.pending && error.operationId === 'pending-op');
  finished = true;
  const restored = new ApiClient('http://lobby', options);
  assert.equal((await restored.startWorld('world')).world.status, 'ACTIVE');
  assert.equal(posts, 1);
});

test('Recovery pending and stale operation results never supply an old endpoint', async () => {
  const api = new ApiClient('http://lobby', { storage: storage(), wait: async () => {}, fetch: async (url, options = {}) => {
    if (options.method === 'POST') return response({ operationId: 'recovering' }, 202);
    return response({ operation: { status: 'RECOVERY_PENDING' } });
  } });
  await assert.rejects(api.startWorld('world'), error => error.pending);
  let calls = 0;
  const stale = new ApiClient('http://lobby', { storage: storage(), fetch: async () => {
    calls++;
    if (calls === 1) return response({ operationId: 'old' }, 202);
    if (calls === 2) return response({ operation: { worldId: 'world', status: 'SUCCEEDED', result: { world: active } } });
    return response({ world: { ...active, runtimeId: 'another-runtime' } });
  } });
  await assert.rejects(stale.startWorld('world'), /cambió de ejecución/);
});

test('Existing synchronous API remains compatible', async () => {
  const api = new ApiClient('http://lobby', { storage: storage(), fetch: async () => response({ success: true, world: active, wsUrl: active.wsUrl }) });
  assert.equal((await api.startWorld('world')).wsUrl, active.wsUrl);
});
