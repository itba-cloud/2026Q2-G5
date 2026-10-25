import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorldRepository } from '../src/store/WorldRegistry.js';
import { HostPlacementEngine } from '../src/orchestrator/HostPlacementEngine.js';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Orquestador con Docker mockeado y sin llamadas al servicio de NPCs.
 */
function createEngine(repository, overrides = {}) {
  const engine = new HostPlacementEngine(repository, new DockerContainerLauncher({ useMock: true }));
  return Object.assign(engine, overrides);
}

/**
 * Deja un solo host elegible para que las pruebas de capacidad sean deterministas.
 * Los hosts apartados se restauran al terminar.
 */
async function isolateFleet(repository, hostId) {
  const others = (await repository.listHosts({ status: 'HEALTHY' })).filter((host) => host.id !== hostId);
  for (const host of others) {
    await repository.updateHostLoad(host.id, 0, { status: 'DRAINING' });
  }
  return others;
}

async function restoreFleet(repository, hosts) {
  for (const host of hosts) {
    await repository.updateHostLoad(host.id, 0, { status: 'HEALTHY' });
  }
}

async function runLifecycleSuite(label, repository, hostId) {
  const createdWorlds = [];

  const registerTestHost = (portRange, maxWorlds) => repository.registerHost({
    id: hostId,
    name: `Host de reservas ${label}`,
    hostIp: '127.0.0.1',
    publicHost: 'localhost',
    publicWsProtocol: 'ws',
    dockerApiUrl: 'http://127.0.0.1:2375',
    portRange,
    maxWorlds,
    status: 'HEALTHY',
    isPermanent: true,
    hierarchy: 100,
  });

  const createWorld = async (name, seed) => {
    const id = `${name}_${suffix}`;
    await repository.createWorld({
      id,
      name,
      seed,
      status: 'INACTIVE',
      maxPlayers: 20,
      botCount: 0,
      isDefault: false,
    });
    createdWorlds.push(id);
    return id;
  };

  const apartedHosts = await isolateFleet(repository, hostId);

  try {
    // 1. Dos starts del mismo mundo generan un solo lanzamiento
    await registerTestHost({ min: 8901, max: 8910 }, 10);
    const engine = createEngine(repository);
    let launchCount = 0;
    const launchContainer = engine.dockerLauncher.launchWorldContainer.bind(engine.dockerLauncher);
    engine.dockerLauncher.launchWorldContainer = async (...args) => {
      launchCount++;
      return launchContainer(...args);
    };

    const sharedWorld = await createWorld('reservation-shared', 1001);
    const bothStarts = await Promise.allSettled([
      engine.startWorld(sharedWorld),
      engine.startWorld(sharedWorld),
    ]);
    const started = bothStarts.filter((result) => result.status === 'fulfilled');
    const refused = bothStarts.filter((result) => result.status === 'rejected');

    assert.equal(launchCount, 1, `${label}: dos starts simultaneos llegan a Docker una sola vez`);
    assert.equal(started.length, 1, `${label}: solo una de las dos solicitudes activa el mundo`);
    assert.equal(started[0].value.status, 'ACTIVE', `${label}: la solicitud ganadora deja el mundo ACTIVE`);
    assert.equal(refused[0].reason.code, 'WORLD_STARTING', `${label}: la perdedora recibe WORLD_STARTING`);

    assert.equal((await engine.stopWorld(sharedWorld)).status, 'INACTIVE', `${label}: el stop libera el mundo`);

    // 2. Dos mundos compitiendo por el ultimo puerto no se superponen
    await registerTestHost({ min: 8911, max: 8911 }, 10);
    const firstRival = await createWorld('reservation-port-a', 1002);
    const secondRival = await createWorld('reservation-port-b', 1003);
    const portRace = await Promise.allSettled([
      engine.startWorld(firstRival),
      engine.startWorld(secondRival),
    ]);

    const activeRivals = portRace.filter((result) => result.status === 'fulfilled');
    assert.equal(activeRivals.length, 1, `${label}: el unico puerto libre activa un solo mundo`);
    assert.equal(activeRivals[0].value.port, 8911, `${label}: el mundo ganador toma el puerto disponible`);
    assert.match(
      portRace.find((result) => result.status === 'rejected').reason.message,
      /Rango de puertos agotado|Capacidad agotada/,
      `${label}: el mundo perdedor no recibe un puerto ya tomado`
    );

    // 3. El ultimo slot del host lo toma un solo mundo
    await registerTestHost({ min: 8911, max: 8920 }, 2);
    const inactiveRival = activeRivals[0].value.id === firstRival ? secondRival : firstRival;
    assert.equal((await engine.startWorld(inactiveRival)).port, 8912, `${label}: el segundo mundo ocupa el slot libre`);

    const slotRival = await createWorld('reservation-slot', 1004);
    await assert.rejects(
      () => engine.startWorld(slotRival),
      /Capacidad agotada/,
      `${label}: el host lleno rechaza el mundo extra`
    );

    await engine.stopWorld(firstRival);
    await engine.stopWorld(secondRival);

    // 4. Un fallo de readiness libera el puerto reservado
    await registerTestHost({ min: 8911, max: 8911 }, 10);
    const failingEngine = createEngine(repository, {
      _waitForWorldReady: async () => {
        throw new Error('readiness simulado');
      },
    });
    const brokenWorld = await createWorld('reservation-broken', 1005);
    await assert.rejects(() => failingEngine.startWorld(brokenWorld), /readiness simulado/);

    const releasedWorld = await repository.getWorld(brokenWorld);
    assert.equal(releasedWorld.status, 'INACTIVE', `${label}: un fallo de readiness devuelve el mundo a INACTIVE`);
    assert.equal(releasedWorld.port, null, `${label}: un fallo de readiness libera el puerto`);

    const reusingWorld = await createWorld('reservation-reuse', 1006);
    assert.equal((await engine.startWorld(reusingWorld)).port, 8911, `${label}: el puerto liberado se puede reasignar`);
    await engine.stopWorld(reusingWorld);

    // 5. Un stop durante STARTING no termina en ACTIVE
    const stoppingEngine = createEngine(repository);
    const racedWorld = await createWorld('reservation-raced', 1007);
    const racingEngine = createEngine(repository, {
      _waitForWorldReady: async () => {
        await stoppingEngine.stopWorld(racedWorld);
        return true;
      },
    });

    await assert.rejects(
      () => racingEngine.startWorld(racedWorld),
      (err) => err.code === 'WORLD_STOPPING',
      `${label}: el worker que pierde la reserva no puede confirmarla`
    );
    const racedResult = await repository.getWorld(racedWorld);
    assert.equal(racedResult.status, 'INACTIVE', `${label}: un stop durante STARTING termina INACTIVE, no ACTIVE`);
    assert.equal(racedResult.port, null, `${label}: el stop durante STARTING libera el puerto`);

    // 6. Un token viejo no puede modificar una reserva nueva
    const tokenWorld = await createWorld('reservation-token', 1008);
    const staleReservation = await repository.reserveWorldStart(tokenWorld);
    await repository.failWorldStart(tokenWorld, staleReservation.token);
    const freshReservation = await repository.reserveWorldStart(tokenWorld);

    assert.notEqual(freshReservation.token, staleReservation.token, `${label}: cada reserva genera su propio token`);
    assert.equal(
      await repository.completeWorldStart(tokenWorld, staleReservation.token, { wsUrl: 'ws://usurpado', containerId: 'usurpado' }),
      null,
      `${label}: un token viejo no puede activar la reserva nueva`
    );
    assert.equal(
      await repository.failWorldStart(tokenWorld, staleReservation.token),
      null,
      `${label}: un token viejo no puede liberar la reserva nueva`
    );
    assert.equal((await repository.getWorld(tokenWorld)).status, 'STARTING', `${label}: la reserva nueva sobrevive al token viejo`);
    await repository.failWorldStart(tokenWorld, freshReservation.token);

    // 7. Una reserva vencida se recupera al reconciliar
    const originalLeaseMs = repository.config.worldStartLeaseMs;
    const expiredWorld = await createWorld('reservation-expired', 1009);

    // Un lease negativo nace vencido: simula al worker que murio sin confirmar
    repository.config.worldStartLeaseMs = -1000;
    const expiredReservation = await repository.reserveWorldStart(expiredWorld);
    repository.config.worldStartLeaseMs = originalLeaseMs;

    const expiredList = await repository.listExpiredWorldStarts();
    assert(
      expiredList.some((item) => item.world.id === expiredWorld),
      `${label}: la reserva vencida aparece en el barrido`
    );

    await createEngine(repository).recoverExpiredWorldStarts();
    const reclaimedWorld = await repository.getWorld(expiredWorld);
    assert.equal(reclaimedWorld.status, 'INACTIVE', `${label}: la reconciliacion devuelve el mundo a INACTIVE`);
    assert.equal(reclaimedWorld.port, null, `${label}: la reconciliacion libera el puerto`);
    assert.equal(
      await repository.completeWorldStart(expiredWorld, expiredReservation.token, { wsUrl: 'ws://tarde', containerId: 'tarde' }),
      null,
      `${label}: el token de una reserva vencida ya no puede activarla`
    );

    console.log(`PASS reservations-test (${label}): reservas, puertos, tokens y reconciliacion verificados.`);
  } finally {
    for (const worldId of createdWorlds) {
      await repository.deleteWorld(worldId).catch(() => {});
    }
    await restoreFleet(repository, apartedHosts).catch(() => {});
  }
}

const run = async () => {
  // 1. Backend local: el adaptador de desarrollo, con su mutex en memoria
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ewo-reservations-'));
  const localRepository = createWorldRepository({
    storageMode: 'local',
    dataDir,
    worldPortRange: { min: 8901, max: 8910 },
    worldStartLeaseMs: 60000,
  });

  try {
    await localRepository.init();
    await runLifecycleSuite('local', localRepository, 'host-primary-01');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  // 2. Backend RDS: el unico que serializa varios nodos del Lobby
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    console.log('SKIP reservations-test (rds): definir TEST_DATABASE_URL para ejecutar pruebas PostgreSQL.');
    return;
  }

  const hostId = `host_reservations_${suffix}`;
  const rdsRepository = createWorldRepository({
    storageMode: 'rds',
    db: { connectionString: databaseUrl },
    seedDefaultHost: false,
    worldPortRange: { min: 8901, max: 8910 },
    worldStartLeaseMs: 60000,
  });

  try {
    await rdsRepository.init();
    await runLifecycleSuite('rds', rdsRepository, hostId);
  } finally {
    await rdsRepository.pool.query('DELETE FROM hosts WHERE host_id = $1', [hostId]).catch(() => {});
    await rdsRepository.close();
  }
};

run().catch((err) => {
  console.error('FAIL reservations-test:', err);
  process.exit(1);
});
