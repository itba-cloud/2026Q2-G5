import assert from 'node:assert/strict';
import { LobbyServiceApp } from '../src/index.js';
import { databaseFixture } from './helpers/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  console.log('SKIP rds-lobby-test: definir TEST_DATABASE_URL para ejecutar pruebas PostgreSQL.');
  process.exit(0);
}

const port = 3198;
const worldName = `Mundo HTTP RDS ${Date.now()}`;
const fixture = await databaseFixture();
const app = new LobbyServiceApp({
  port,
  host: '127.0.0.1',
  publicHost: 'localhost',
  storageMode: 'rds',
  db: fixture.config.db,
  seedDefaultHost: true,
  useDockerMock: true,
  redisUrl: '',
});

const run = async () => {
  let worldId = null;

  try {
    await app.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const createResponse = await fetch(`${baseUrl}/worlds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: worldName, seed: 12345 }),
    });
    const created = await createResponse.json();
    worldId = created.worldId;
    assert.equal(createResponse.status, 201, 'El Lobby RDS crea un mundo mediante HTTP');
    assert.equal(created.world.status, 'ACTIVE', 'El mundo creado por HTTP queda activo');

    const staleShutdown = await fetch(`${baseUrl}/worlds/${worldId}/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtimeId: '11111111-1111-4111-8111-111111111111' }) });
    assert.equal(staleShutdown.status, 409, 'El puente también rechaza callbacks de otra generación');
    assert.equal((await app.repository.getWorld(worldId)).status, 'ACTIVE');
    const shutdownResponse = await fetch(`${baseUrl}/worlds/${worldId}/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtimeId: created.world.runtimeId }) });
    const shutdown = await shutdownResponse.json();
    assert.equal(shutdownResponse.status, 200, 'El Lobby RDS procesa el apagado mediante HTTP');
    assert.equal(shutdown.world.status, 'INACTIVE', 'El apagado libera el mundo en RDS');

    console.log('PASS rds-lobby-test: ciclo HTTP RDS verificado.');
  } finally {
    if (worldId) {
      await app.repository.deleteWorld(worldId).catch(() => {});
    }
    await app.stop();
    await fixture.close();
  }
};

run().catch((err) => {
  console.error('FAIL rds-lobby-test:', err);
  process.exit(1);
});
