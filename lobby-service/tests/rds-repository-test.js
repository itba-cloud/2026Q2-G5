import assert from 'node:assert/strict';
import { createWorldRepository, RdsWorldRepository } from '../src/store/WorldRegistry.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  console.log('SKIP rds-repository-test: definir TEST_DATABASE_URL para ejecutar pruebas PostgreSQL.');
  process.exit(0);
}

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const hostId = `host_test_${suffix}`;
const worldId = `world_test_${suffix}`;
const secondWorldId = `world_second_${suffix}`;
const repository = createWorldRepository({
  storageMode: 'rds',
  db: { connectionString: databaseUrl },
  seedDefaultHost: false,
  worldPortRange: { min: 8001, max: 8050 },
});

const run = async () => {
  assert(repository instanceof RdsWorldRepository, 'STORAGE_MODE=rds debe crear RdsWorldRepository');

  try {
    await repository.init();
    await repository.init();

    const defaultWorlds = (await repository.listWorlds()).filter((world) => world.id === 'world-01');
    assert.equal(defaultWorlds.length, 1, 'El mundo por defecto se siembra una sola vez');
    assert.equal(defaultWorlds[0].botCount, 2, 'El mundo por defecto conserva sus dos bots');

    const host = await repository.registerHost({
      id: hostId,
      name: 'Host de prueba RDS',
      hostIp: '10.0.0.10',
      publicHost: '203.0.113.10',
      publicWsProtocol: 'ws',
      dockerApiUrl: 'http://10.0.0.10:2375',
      portRange: { min: 8101, max: 8110 },
      maxWorlds: 3,
      status: 'HEALTHY',
      hierarchy: 75,
    });
    assert.deepEqual(host.portRange, { min: 8101, max: 8110 }, 'El rango de puertos conserva su mapeo');
    assert.equal(host.activeWorlds, 0, 'El host nuevo inicia sin mundos activos');

    const heartbeat = await repository.registerHost({
      id: hostId,
      name: 'Host de prueba RDS actualizado',
      hostIp: '10.0.0.10',
      publicHost: '203.0.113.10',
      portRange: { min: 8101, max: 8110 },
      maxWorlds: 3,
      status: 'HEALTHY',
    });
    assert.equal(heartbeat.name, 'Host de prueba RDS actualizado', 'El heartbeat actualiza el mismo host');
    assert.equal((await repository.listHosts()).filter((item) => item.id === hostId).length, 1, 'El heartbeat no duplica hosts');

    await repository.createWorld({
      id: worldId,
      name: 'Mundo de prueba RDS',
      seed: 12345,
      status: 'INACTIVE',
      maxPlayers: 12,
      botCount: 1,
      isDefault: false,
    });
    const active = await repository.updateWorld(worldId, {
      status: 'ACTIVE',
      hostId,
      port: 8101,
      wsUrl: 'ws://203.0.113.10:8101',
      containerId: 'container-test',
    });
    assert.equal(active.hostId, hostId, 'El patch parcial conserva la asignacion de host');
    assert.equal((await repository.listWorlds({ status: 'ACTIVE', hostId })).length, 1, 'Los filtros SQL devuelven el mundo activo');
    assert.equal((await repository.getHost(hostId)).activeWorlds, 1, 'host_load calcula la carga activa');

    await repository.createWorld({
      id: secondWorldId,
      name: 'Mundo duplicado de prueba RDS',
      seed: 67890,
      status: 'INACTIVE',
    });
    await assert.rejects(
      () => repository.updateWorld(secondWorldId, { status: 'ACTIVE', hostId, port: 8101 }),
      (err) => err.code === '23505'
    );

    await repository.updateWorld(worldId, { status: 'INACTIVE', hostId: null, port: null, wsUrl: null });
    const reassigned = await repository.updateWorld(secondWorldId, { status: 'ACTIVE', hostId, port: 8101 });
    assert.equal(reassigned.port, 8101, 'Liberar un puerto permite reasignarlo');

    console.log('PASS rds-repository-test: CRUD, seeds, heartbeat y restricciones verificados.');
  } finally {
    await repository.deleteWorld(worldId).catch(() => {});
    await repository.deleteWorld(secondWorldId).catch(() => {});
    await repository.pool.query('DELETE FROM hosts WHERE host_id = $1', [hostId]).catch(() => {});
    await repository.close();
  }

  await assert.rejects(() => repository.listWorlds());
};

run().catch((err) => {
  console.error('FAIL rds-repository-test:', err);
  process.exit(1);
});
