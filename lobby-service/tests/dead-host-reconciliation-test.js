import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalJsonWorldRepository } from '../src/store/LocalJsonWorldRepository.js';
import { HostPlacementEngine } from '../src/orchestrator/HostPlacementEngine.js';
import { DockerContainerLauncher } from '../src/orchestrator/DockerContainerLauncher.js';

async function runDeadHostTests() {
  console.log('🧪 Starting Dead Host & World Disassociation Test Suite...\n');

  const testDir = path.resolve('./.test_dead_host_data');
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});

  const repository = new LocalJsonWorldRepository({
    dataDir: testDir,
  });
  await repository.init();

  const mockLauncher = new DockerContainerLauncher({ useMock: true });
  const engine = new HostPlacementEngine(repository, mockLauncher);

  try {
    // -------------------------------------------------------------
    // Test 1: Host with an ACTIVE world becomes unreachable
    // -------------------------------------------------------------
    console.log('Test 1: World on an unreachable host is disassociated and reset to INACTIVE...');
    const hostId1 = 'host-worker-dead-01';
    await repository.registerHost({
      id: hostId1,
      name: 'Worker 01',
      hostIp: '10.0.0.99',
      publicHost: '10.0.0.99',
      dockerApiUrl: 'http://10.0.0.99:2375',
      status: 'HEALTHY',
      isPermanent: false,
      hierarchy: 200,
      maxWorlds: 5,
    });

    const world1 = await repository.createWorld({
      id: 'world-active-dead-host',
      name: 'Mundo Activo en Host Muerto',
      status: 'INACTIVE',
      seed: 12345,
      isDefault: false,
    });

    // Start world on this host
    await engine.startWorld(world1.id);
    let currentWorld = await repository.getWorld(world1.id);
    assert.equal(currentWorld.status, 'ACTIVE');
    assert.equal(currentWorld.hostId, hostId1);

    // Simulate host becoming completely unreachable in Docker launcher
    mockLauncher.getContainerStatus = async () => ({
      exists: false,
      running: false,
      status: 'unreachable',
      hostUnreachable: true,
    });

    // Run reconciliation (forced to bypass 3s throttle in test)
    await engine.reconcileWorldStates({ force: true });

    currentWorld = await repository.getWorld(world1.id);
    assert.equal(currentWorld.status, 'ACTIVE', 'A partition cannot release unverified capacity');
    assert.equal(currentWorld.hostId, hostId1);
    assert.ok(currentWorld.port);
    assert.ok(currentWorld.wsUrl);

    const updatedHost1 = await repository.getHost(hostId1);
    assert.equal(updatedHost1.status, 'DOWN', 'Host must be marked DOWN');
    assert.equal(updatedHost1.activeWorlds, 1);
    console.log('  ✅ PASS: Partition retains placement and marks host DOWN.\n');

    // -------------------------------------------------------------
    // Test 2: Host heartbeat expiration (> 90s) frees worlds
    // -------------------------------------------------------------
    console.log('Test 2: Expired host heartbeat marks host DOWN and frees worlds...');
    const hostId2 = 'host-worker-expired-02';
    const staleTime = new Date(Date.now() - 120000).toISOString(); // 120 seconds ago

    await repository.registerHost({
      id: hostId2,
      name: 'Worker Expired',
      hostIp: '10.0.0.98',
      publicHost: '10.0.0.98',
      dockerApiUrl: 'http://10.0.0.98:2375',
      status: 'HEALTHY',
      isPermanent: false,
      maxWorlds: 5,
    });
    // Manually force an old heartbeat
    await repository.updateHostLoad(hostId2, 0, { lastHeartbeat: staleTime });

    // Put a world on this host in STARTING status
    const world2 = await repository.createWorld({
      id: 'world-starting-expired-host',
      name: 'Mundo Starting en Host Expirado',
      status: 'STARTING',
      hostId: hostId2,
      port: 8005,
      seed: 54321,
      isDefault: false,
    });

    // Run host fleet reconciliation with 90s threshold
    await engine.reconcileHostFleet(90000);

    const host2Record = await repository.getHost(hostId2);
    assert.equal(host2Record.status, 'DOWN', 'Host with expired heartbeat must be DOWN');

    const world2Record = await repository.getWorld(world2.id);
    assert.equal(world2Record.status, 'STARTING');
    assert.equal(world2Record.hostId, hostId2);
    console.log('  ✅ PASS: Expired heartbeat retains occupied placement.\n');

    // -------------------------------------------------------------
    // Test 3: stopWorld on an unreachable host completes cleanly
    // -------------------------------------------------------------
    console.log('Test 3: stopWorld on unreachable host does not hang or get stuck in STOPPING...');
    const hostId3 = 'host-worker-stop-03';
    await repository.registerHost({
      id: hostId3,
      name: 'Worker Stop Test',
      hostIp: '10.0.0.97',
      publicHost: '10.0.0.97',
      dockerApiUrl: 'http://10.0.0.97:2375',
      status: 'DOWN',
      isPermanent: false,
      maxWorlds: 5,
    });

    const world3 = await repository.createWorld({
      id: 'world-stop-unreachable',
      name: 'Mundo Stop Unreachable',
      status: 'ACTIVE',
      hostId: hostId3,
      port: 8006,
      wsUrl: 'ws://10.0.0.97:8006',
      containerId: 'dckr_dead_host_container',
      seed: 99999,
      isDefault: false,
    });

    mockLauncher.stopWorldContainer = async () => false; // Docker call fails to reach host

    const stoppedWorld = await engine.stopWorld(world3.id);
    assert.equal(stoppedWorld.status, 'STOPPING');
    assert.equal(stoppedWorld.hostId, hostId3);
    console.log('  ✅ PASS: Failed retirement keeps STOPPING.\n');

    // -------------------------------------------------------------
    // Test 4: Pruning long-dead ephemeral hosts (> 5 min)
    // -------------------------------------------------------------
    console.log('Test 4: Pruning long-dead ephemeral hosts...');
    const hostId4 = 'i-0abcdef1234567890'; // EC2 instance ID format
    await repository.registerHost({
      id: hostId4,
      name: 'Terminated ASG Instance',
      hostIp: '10.0.0.96',
      publicHost: '10.0.0.96',
      status: 'DOWN',
      isPermanent: false,
      maxWorlds: 5,
    });
    // Set heartbeat 6 minutes ago
    await repository.updateHostLoad(hostId4, 0, { lastHeartbeat: new Date(Date.now() - 360000).toISOString() });

    await engine.reconcileHostFleet(90000, 300000);

    const prunedHost = await repository.getHost(hostId4);
    assert.equal(prunedHost, null, 'Dead ephemeral EC2 host must be pruned after 5m');

    // -------------------------------------------------------------
    // Test 5: recoverExpiredWorldStarts reclaims reservation on dead host
    // -------------------------------------------------------------
    console.log('Test 5: recoverExpiredWorldStarts reclaims reservation even when host is dead...');
    const hostId5 = 'host-worker-dead-res-05';
    await repository.registerHost({
      id: hostId5,
      name: 'Dead Host Reservation Test',
      hostIp: '10.0.0.95',
      publicHost: '10.0.0.95',
      dockerApiUrl: 'http://10.0.0.95:2375',
      status: 'DOWN',
      isPermanent: false,
      maxWorlds: 5,
    });

    const token5 = 'test-token-dead-555';
    const world5 = await repository.createWorld({
      id: 'world-expired-starting-dead-host',
      name: 'Mundo Starting Expirado en Host Muerto',
      status: 'STARTING',
      hostId: hostId5,
      port: 8009,
      reservationToken: token5,
      reservationExpiresAt: new Date(Date.now() - 10000).toISOString(), // expired 10s ago
      seed: 88888,
      isDefault: false,
    });

    mockLauncher.stopWorldContainer = async () => false; // Docker call fails to reach dead host

    const reclaimedCount = await engine.recoverExpiredWorldStarts();
    assert.equal(reclaimedCount, 0);

    const world5Record = await repository.getWorld(world5.id);
    assert.equal(world5Record.status, 'STARTING');
    assert.equal(world5Record.hostId, hostId5);
    assert.equal(world5Record.port, 8009);
    console.log('  ✅ PASS: Unverified reservation retains its capacity.\n');

    // -------------------------------------------------------------
    // Test 6: reserveWorldStart skips hosts with stale heartbeats (> 90s)
    // -------------------------------------------------------------
    console.log('Test 6: reserveWorldStart ignores stale hosts even if marked HEALTHY...');
    const hostStale = 'host-worker-stale-06';
    await repository.registerHost({
      id: hostStale,
      name: 'Worker Stale Heartbeat',
      hostIp: '10.0.0.94',
      publicHost: '10.0.0.94',
      dockerApiUrl: 'http://10.0.0.94:2375',
      status: 'HEALTHY',
      isPermanent: false,
      maxWorlds: 5,
    });
    // Heartbeat from 100 seconds ago (> 90s threshold)
    await repository.updateHostLoad(hostStale, 0, {
      lastHeartbeat: new Date(Date.now() - 100000).toISOString(),
    });

    const world6 = await repository.createWorld({
      id: 'world-reserve-stale-test',
      name: 'Mundo Stale Test',
      status: 'INACTIVE',
      seed: 77777,
      isDefault: false,
    });

    // Mark any pre-existing default hosts as DOWN for this test
    await repository.updateHostStatus('host-primary-01', 'DOWN');

    // Should fail with capacity/no hosts available because the only host with status HEALTHY is stale
    await assert.rejects(
      async () => {
        await repository.reserveWorldStart(world6.id);
      },
      /No hay nodos host disponibles en la flota/
    );

    // Now register a fresh host
    const hostFresh = 'host-worker-fresh-07';
    await repository.registerHost({
      id: hostFresh,
      name: 'Worker Fresh Heartbeat',
      hostIp: '10.0.0.93',
      publicHost: '10.0.0.93',
      dockerApiUrl: 'http://10.0.0.93:2375',
      status: 'HEALTHY',
      isPermanent: false,
      maxWorlds: 5,
    });

    // Now reservation must succeed and pick the fresh host
    const res6 = await repository.reserveWorldStart(world6.id);
    assert.equal(res6.host.id, hostFresh, 'Must select fresh host, skipping stale host');
    console.log('  ✅ PASS: Stale host skipped and fresh host selected for reservation.\n');

    console.log('🎉 All Dead Host Reconciliation tests passed successfully!');
  } finally {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
}

runDeadHostTests().catch((err) => {
  console.error('💥 Test failure:', err);
  process.exit(1);
});
