import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import Redis from 'ioredis';
import { AnnouncementPublisher, retryDelay } from '../src/modules/messaging/AnnouncementPublisher.js';

const hasRedis = spawnSync('redis-server', ['--version']).status === 0;

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startRedis(port) {
  const child = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 50; attempt++) {
    const up = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    if (up) return child;
    await wait(100);
  }
  throw new Error('redis-server did not start');
}

const stopRedis = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); });

test('gives up quickly while connecting and keeps retrying once connected', () => {
  assert.equal(retryDelay(4, false), null);
  assert.equal(retryDelay(50, true), 2000);
});

test('announcements resume after a Redis outage longer than the startup retries', { skip: !hasRedis && 'redis-server is not installed' }, async () => {
  const port = await freePort();
  let redis = await startRedis(port);
  const url = `redis://127.0.0.1:${port}`;
  const publisher = new AnnouncementPublisher({ redisUrl: url, channel: 'announce-test' });
  const listener = new Redis(url, { lazyConnect: true });
  listener.on('error', () => {});
  try {
    assert.equal(await publisher.connect(), true);
    await stopRedis(redis);
    await wait(3000);
    redis = await startRedis(port);

    await listener.connect();
    const received = [];
    listener.on('message', (_channel, raw) => received.push(JSON.parse(raw)));
    await listener.subscribe('announce-test');

    const deadline = Date.now() + 10000;
    while (received.length === 0 && Date.now() < deadline) {
      await publisher.announce('mantenimiento en 5 minutos');
      await wait(200);
    }
    assert.equal(received[0]?.message, 'mantenimiento en 5 minutos');
    assert.equal(publisher.enabled, true);
  } finally {
    listener.disconnect();
    await publisher.close();
    await stopRedis(redis);
  }
});
