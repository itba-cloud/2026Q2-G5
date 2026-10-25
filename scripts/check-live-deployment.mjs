#!/usr/bin/env node
// Exercises a deployed stack. Only worlds created by this run are stopped/deleted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: {
  outputs: { type: 'string' }, project: { type: 'string' },
  region: { type: 'string', default: 'us-east-1' },
  'metrics-user': { type: 'string', default: 'admin' },
  'metrics-password-file': { type: 'string' },
  'keep-worlds': { type: 'boolean', default: false },
  report: { type: 'string', default: '.build/live-deployment-report.json' },
} });
for (const key of ['outputs', 'project']) {
  assert(values[key], `Missing --${key}`);
}
assert.match(values.project, /^[a-z][a-z0-9-]{2,24}$/);
const outputs = JSON.parse(readFileSync(values.outputs, 'utf8'));
const output = name => outputs[name].value;
const api = output('alb_url');
const temporary = mkdtempSync(join(tmpdir(), 'ewo-live-'));
const report = { checkedAt: new Date().toISOString(), project: values.project, api, checks: [], worlds: [] };
const clients = [];
const saveReport = () => writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const aws = (...args) => JSON.parse(execFileSync('aws', [
  ...args, '--region', values.region, '--output', 'json',
], { encoding: 'utf8', timeout: 100_000, stdio: ['ignore', 'pipe', 'pipe'] }));
// The Metrics password lives in Secrets Manager; --metrics-password-file overrides it.
const metricsPassword = values['metrics-password-file']
  ? readFileSync(values['metrics-password-file'], 'utf8').trim()
  : aws('secretsmanager', 'get-secret-value', '--secret-id', output('metrics_password_secret_arn')).SecretString.trim();
const authorization = `Basic ${Buffer.from(`${values['metrics-user']}:${metricsPassword}`).toString('base64')}`;
async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${api}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
function internal(path, method = 'GET', body) {
  const event = {
    requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/live-check/0000000000000000' } },
    httpMethod: method, path, queryStringParameters: {}, isBase64Encoded: false,
    headers: { host: 'live-check.internal', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : '',
  };
  const destination = join(temporary, 'lambda.json');
  const metadata = aws('lambda', 'invoke', '--function-name', `${values.project}-lobby-internal`,
    '--qualifier', 'live', '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(event), destination);
  assert(!metadata.FunctionError, `Internal Lambda failed: ${readFileSync(destination, 'utf8')}`);
  const response = JSON.parse(readFileSync(destination, 'utf8'));
  const raw = response.isBase64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body;
  return { status: response.statusCode, data: JSON.parse(raw) };
}
async function eventually(label, callback, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  let nextUpdate = Date.now() + 20_000;
  let lastError;
  while (Date.now() < end) {
    try { const result = await callback(); if (result) return result; }
    catch (error) { if (error.terminal) throw error; lastError = error; }
    if (Date.now() >= nextUpdate) {
      console.log(`WAIT ${label}`);
      nextUpdate = Date.now() + 20_000;
    }
    await delay(2000);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}
async function check(name, callback) {
  const start = Date.now();
  try {
    const detail = await callback();
    report.checks.push({ name, pass: true, durationMs: Date.now() - start, ...(detail && { detail }) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, pass: false, error: error.message });
    throw error;
  } finally { saveReport(); }
}
async function operation(id, privateOperation = false) {
  return eventually(`operation ${id}`, async () => {
    const result = privateOperation ? internal(`/api/operations/${id}`) : await request(`/api/operations/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const op = result.data.operation;
    if (['FAILED', 'CANCELLED'].includes(op.status)) {
      throw Object.assign(new Error(JSON.stringify(op)), { terminal: true });
    }
    return op.status === 'SUCCEEDED' && op;
  });
}
async function connect(world, name) {
  const socket = new WebSocket(world.wsUrl);
  const client = { socket, messages: [], latest: new Map(), name };
  clients.push(client);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'JOIN', payload: { playerName: name } })));
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    client.latest.set(message.type, message.payload);
    if (message.type !== 'STATE_SYNC') client.messages.push(message);
  });
  await eventually(`WebSocket JOIN ${name}`, () => client.latest.get('INIT'), 30_000);
  client.send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
  return client;
}
try {
  await check('frontend and runtime configuration', async () => {
    const page = await fetch(output('client_website_url'), { signal: AbortSignal.timeout(15_000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Elastic Worlds/i);
    const config = await fetch(`${output('client_website_url')}/runtime-config.js`);
    assert.equal(config.status, 200);
    assert((await config.text()).includes(api));
  });
  await check('Lobby and PostgreSQL', async () => {
    const health = await eventually('Lobby health', async () => {
      const response = await request('/health');
      return response.status === 200 && response.data;
    }, 600_000);
    return { totalWorldsCount: health.totalWorldsCount };
  });
  await check('private routes and Metrics authentication', async () => {
    assert.equal((await request('/api/hosts')).status, 403);
    assert.equal((await request('/api/worlds/check/stop', { method: 'POST', body: {} })).status, 403);
    await eventually('Metrics targets ready', async () => (await request('/api/metrics')).status === 401, 300_000);
    assert.equal((await request('/api/metrics', { headers: { authorization: 'Basic YWRtaW46aW52YWxpZA==' } })).status, 401);
    assert.equal((await request('/api/metrics', { headers: { authorization } })).status, 200);
  });
  await check('Flink running and two replicas per ECS service', async () => {
    const application = aws('kinesisanalyticsv2', 'describe-application', '--application-name', output('flink_application_name'));
    assert.equal(application.ApplicationDetail.ApplicationStatus, 'RUNNING');
    for (const service of ['npc', 'metrics']) {
      await eventually(`ECS ${service} replicas`, () => {
        const data = aws('ecs', 'describe-services', '--cluster', `${values.project}-${service}`, '--services', `${values.project}-${service}`);
        const current = data.services[0];
        return current?.desiredCount >= 2 && current.runningCount >= current.desiredCount && !current.pendingCount;
      }, 300_000);
    }
  });
  await check('world creation, idempotency and Step Functions', async () => {
    for (const suffix of ['A', 'B']) {
      const body = { name: `AWS validation ${suffix} ${report.checkedAt}`, seed: 424242, botCount: 2, autoStart: true };
      const headers = { 'Idempotency-Key': `aws-check-${report.checkedAt}-${suffix}` };
      const first = await request('/api/worlds', { method: 'POST', body, headers });
      assert.equal(first.status, 202, JSON.stringify(first.data));
      report.worlds.push(first.data.worldId); saveReport();
      const repeat = await request('/api/worlds', { method: 'POST', body, headers });
      assert.equal(repeat.status, 202, JSON.stringify(repeat.data));
      assert.equal(repeat.data.operationId, first.data.operationId);
      await operation(first.data.operationId);
    }
    const running = aws('ecs', 'list-tasks', '--cluster', output('world_tasks').cluster, '--desired-status', 'RUNNING').taskArns;
    assert(running.length >= 2, `Expected a Fargate task per world, found ${running.length}`);
  });
  const worlds = await Promise.all(report.worlds.map(async id => (await request(`/api/worlds/${id}`)).data.world));
  let alice;
  let bob;
  await check('multiplayer WebSockets and authoritative movement', async () => {
    let observer;
    [alice, bob, observer] = await Promise.all([
      connect(worlds[0], 'AWS-Alice'), connect(worlds[1], 'AWS-Bob'), connect(worlds[0], 'AWS-Observer'),
    ]);
    const initial = alice.latest.get('INIT');
    assert.equal(initial.worldId, worlds[0].id);
    assert(initial.resources.length > 0);
    const moved = await eventually('player movement', async () => {
      for (const direction of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
        alice.send('MOVE', { direction }); await delay(500);
        const stopTick = alice.latest.get('STATE_SYNC')?.tick ?? -1;
        alice.send('MOVE', { direction: { x: 0, y: 0 } });
        // A fixed sleep can capture an earlier position while MOVE/STOP is still
        // in flight. Compare clients only after the server acknowledges STOP.
        const player = await eventually('server acknowledges movement stop', () => {
          const state = alice.latest.get('STATE_SYNC');
          const current = state?.players.find(p => p.id === initial.playerId);
          return state?.tick > stopTick && current?.dirX === 0 && current?.dirY === 0 && current;
        }, 10_000);
        if (player && Math.hypot(player.x - initial.player.x, player.y - initial.player.y) > 1) return player;
      }
    }, 20_000);
    await eventually('movement visible to the second player', () => {
      const state = observer.latest.get('STATE_SYNC');
      return state?.players.some(p => p.id === initial.playerId && Math.hypot(p.x - moved.x, p.y - moved.y) < 1)
        && state.players.some(p => p.id === observer.latest.get('INIT').playerId);
    }, 10_000);
    return { from: { x: initial.player.x, y: initial.player.y }, to: { x: moved.x, y: moved.y } };
  });
  await check('cross-world Redis chat', async () => {
    const text = `AWS Redis check ${Date.now()}`;
    alice.send('CHAT_SEND', { text });
    await eventually('chat received in second world', () => bob.messages.find(m => m.type === 'CHAT_MESSAGE' && m.payload.text === text && m.payload.isRemote), 30_000);
  });
  await check('World/NPC to Kinesis/Flink/DynamoDB and Metrics history', async () => {
    await eventually('world and NPC telemetry', async () => {
      const key = JSON.stringify({ pk: { S: `WORLD#${worlds[0].id}` }, sk: { S: 'LATEST' } });
      const result = aws('dynamodb', 'get-item', '--table-name', output('telemetry_table_name'), '--key', key, '--consistent-read');
      if (!result.Item?.sample?.M || !result.Item?.ai?.M) return false;
      const metrics = await request('/api/metrics', { headers: { authorization } });
      assert.equal(metrics.status, 200);
      const history = await request('/api/metrics/history', { headers: { authorization } });
      assert.equal(history.status, 200);
      return metrics.data.worlds?.some(w => w.id === worlds[0].id && w.players?.bots > 0) && history.data.points?.length > 0;
    }, 300_000);
  });
  await check('S3 snapshot survives STOP and START', async () => {
    alice.socket.close(); await delay(1000);
    const stop = internal(`/api/worlds/${worlds[0].id}/stop`, 'POST', { force: true });
    assert.equal(stop.status, 202, JSON.stringify(stop.data));
    await operation(stop.data.operationId, true);
    const snapshotFile = join(temporary, 'snapshot.json');
    aws('s3api', 'get-object', '--bucket', output('snapshot_bucket_name'), '--key', `worlds/${worlds[0].id}/snapshot.json`, snapshotFile);
    const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    const saved = snapshot.players_data['AWS-Alice'];
    assert(saved, 'Snapshot does not contain the disconnected player');
    const start = await request(`/api/worlds/${worlds[0].id}/start`, { method: 'POST', body: {} });
    assert.equal(start.status, 202, JSON.stringify(start.data));
    await operation(start.data.operationId);
    const restoredWorld = (await request(`/api/worlds/${worlds[0].id}`)).data.world;
    const restored = await connect(restoredWorld, 'AWS-Alice');
    const player = restored.latest.get('INIT').player;
    assert(Math.hypot(player.x - saved.x, player.y - saved.y) < 1, 'Restored position differs from S3 snapshot');
    return { worldId: worlds[0].id, playerRestored: true };
  });
  await check('scheduled maintenance completes without item errors', async () => {
    await eventually('Scheduler invokes maintenance', () => {
      const schedule = aws('scheduler', 'get-schedule', '--group-name', `${values.project}-lobby`,
        '--name', `${values.project}-lobby-maintenance`);
      if (schedule.State !== 'ENABLED') return false;
      const logs = aws('logs', 'filter-log-events', '--log-group-name', `/aws/lambda/${values.project}-lobby-maintenance`,
        '--start-time', String(Date.parse(report.checkedAt)), '--filter-pattern', '"maintenance.completed"');
      for (const event of logs.events ?? []) {
        const start = event.message.indexOf('{');
        if (start < 0) continue;
        const result = JSON.parse(event.message.slice(start));
        if (result.event === 'maintenance.completed' && result.errors === 0) return true;
      }
      return false;
    }, 300_000);
  });
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = error.message;
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const client of clients) client.socket.close();
  if (!values['keep-worlds']) {
    for (const id of report.worlds) {
      try {
        const result = internal(`/api/worlds/${id}`, 'DELETE', { force: true });
        assert.equal(result.status, 202, JSON.stringify(result.data));
        await operation(result.data.operationId, true);
      } catch (error) {
        report.cleanupErrors ??= [];
        report.cleanupErrors.push({ worldId: id, error: error.message });
        report.pass = false;
        process.exitCode = 1;
      }
    }
  }
  report.keptWorlds = values['keep-worlds'];
  saveReport();
  rmSync(temporary, { recursive: true, force: true });
}
