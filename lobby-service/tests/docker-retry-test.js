import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';

test('Lost Docker create response reuses only its own labelled container', async t => {
  const token = '11111111-1111-4111-8111-111111111111';
  let created = 0;
  let foreign = false;
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/containers/create')) {
      for await (const chunk of req) { /* consume payload */ }
      created++;
      if (created === 1) return req.socket.destroy(); // Docker created it, caller lost its response.
      res.writeHead(409).end();
    } else if (req.url.endsWith('/json')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Id: 'stable-container', Config: { Labels: {
        'elastic-worlds.world-id': 'world-retry', 'elastic-worlds.reservation-token': foreign ? 'another-owner' : token,
      } }, State: { Running: true, Status: 'running' } }));
    } else if (req.url.endsWith('/start')) res.writeHead(304).end();
    else res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const launcher = new DockerContainerLauncher({ useMock: false });
  const host = { id: 'test-host', hostIp: '127.0.0.1', dockerApiUrl: `http://127.0.0.1:${server.address().port}` };
  const world = { id: 'world-retry', token, port: 18001, seed: 1, name: 'Retry', waitForPort: false };
  assert.equal((await launcher.launchWorldContainer(host, world)).containerId, 'stable-container');
  assert.equal((await launcher.launchWorldContainer(host, world)).containerId, 'stable-container');
  foreign = true;
  await assert.rejects(launcher.launchWorldContainer(host, world));
});

test('The world container keeps an ElastiCache rediss:// URL and only rewrites loopback', async t => {
  const envs = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/containers/create')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      envs.push(JSON.parse(body).Env);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(201).end(JSON.stringify({ Id: `container-${envs.length}` }));
    } else if (req.url.endsWith('/start')) res.writeHead(204).end();
    else res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previous = process.env.REDIS_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previous;
    return new Promise(resolve => server.close(resolve));
  });
  const launcher = new DockerContainerLauncher({ useMock: false });
  const host = { id: 'test-host', hostIp: '127.0.0.1', dockerApiUrl: `http://127.0.0.1:${server.address().port}` };
  const redisUrl = env => env.find(entry => entry.startsWith('REDIS_URL=')).slice('REDIS_URL='.length);

  const elastiCache = 'rediss://master.ewo-redis.abc123.use1.cache.amazonaws.com:6379';
  process.env.REDIS_URL = elastiCache;
  await launcher.launchWorldContainer(host, { id: 'world-tls', token: 't1', port: 18002, seed: 1, name: 'TLS', waitForPort: false });
  assert.equal(redisUrl(envs[0]), elastiCache);

  process.env.REDIS_URL = 'redis://localhost:6379';
  await launcher.launchWorldContainer(host, { id: 'world-local', token: 't2', port: 18003, seed: 1, name: 'Local', waitForPort: false });
  assert.equal(redisUrl(envs[1]), 'redis://host.docker.internal:6379');
});
