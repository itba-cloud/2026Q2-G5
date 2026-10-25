import fs from 'fs/promises';
import path from 'path';
import { LobbyServiceApp } from '../src/index.js';

async function runLobbyTests() {
  console.log('🧪 Starting Stateless Lobby Service & Placement Test Suite...\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  const testPort = 3099;
  const testDataDir = path.resolve('./.test_lobby_data');

  // 1. Start Lobby App
  const app = new LobbyServiceApp({
    port: testPort,
    host: '127.0.0.1',
    publicHost: 'localhost',
    dataDir: testDataDir,
    storageMode: 'local',
    useDockerMock: true,
  });

  await app.start();
  assert(true, `Lobby Service started on http://127.0.0.1:${testPort}`);

  const baseUrl = `http://127.0.0.1:${testPort}`;

  try {
    // 2. Test GET /health
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthData = await healthRes.json();
    assert(healthRes.status === 200, 'GET /health returns HTTP 200');
    assert(healthData.status === 'ok' && healthData.service === 'lobby-service', 'Health check returns status ok');
    assert(healthData.activeHostsCount >= 1, `Health check reports ${healthData.activeHostsCount} active host(s)`);

    // 2b. Metrics live in their own service, reached through the ALB, never through
    // the Lobby: the control plane holds no metrics state and serves no metrics route.
    assert(app.metricsCollector === undefined, 'The Lobby does not run an in-process metrics collector');
    assert(app.config.metricsServiceUrl === undefined, 'The Lobby has no metrics service address to proxy to');

    const metricsRes = await fetch(`${baseUrl}/api/metrics`);
    assert(metricsRes.status === 404, 'GET /api/metrics is not a Lobby route (the ALB sends it to the metrics service)');

    // 3. Test GET /worlds (initial catalog has default world in INACTIVE state without assigned port/wsUrl)
    const listRes = await fetch(`${baseUrl}/worlds`);
    const listData = await listRes.json();
    assert(listRes.status === 200, 'GET /worlds returns HTTP 200');
    assert(Array.isArray(listData.worlds) && listData.worlds.length >= 1, `GET /worlds contains ${listData.worlds?.length} default world(s)`);
    assert(listData.worlds[0].id === 'world-01', 'Default world id is "world-01"');
    assert(listData.worlds[0].status === 'INACTIVE', 'Default world initially starts with status INACTIVE');
    assert(listData.worlds[0].port === null && listData.worlds[0].wsUrl === null, 'Inactive world has no assigned port or wsUrl');

    // 4. Test GET /hosts (Fleet monitoring)
    const hostsRes = await fetch(`${baseUrl}/hosts`);
    const hostsData = await hostsRes.json();
    assert(hostsRes.status === 200, 'GET /hosts returns HTTP 200');
    assert(Array.isArray(hostsData.hosts) && hostsData.hosts.length >= 1, 'Hosts fleet contains primary host');
    assert(hostsData.hosts[0].isPermanent === true, 'Primary host is flagged as isPermanent = true');
    assert(hostsData.hosts[0].activeWorlds === 0, 'Primary host starts with activeWorlds = 0');

    // 5. Test On-Demand Start (POST /worlds/world-01/start)
    const startDefaultRes = await fetch(`${baseUrl}/worlds/world-01/start`, { method: 'POST' });
    const startDefaultData = await startDefaultRes.json();
    assert(startDefaultRes.status === 200 && startDefaultData.success === true, 'POST /worlds/world-01/start starts default world');
    assert(startDefaultData.world.status === 'ACTIVE', 'Started world has status ACTIVE');
    assert(startDefaultData.world.port === 8001, 'Started world is assigned port 8001 on host-primary-01');
    assert(typeof startDefaultData.wsUrl === 'string' && startDefaultData.wsUrl.includes(':8001'), 'Assigned valid wsUrl');

    // 6. Verify primary host load incremented
    const hostsAfterStartRes = await fetch(`${baseUrl}/hosts`);
    const hostsAfterStartData = await hostsAfterStartRes.json();
    const primaryHost = hostsAfterStartData.hosts.find((h) => h.id === 'host-primary-01');
    assert(primaryHost?.activeWorlds === 1, `host-primary-01 activeWorlds incremented to 1 (current: ${primaryHost?.activeWorlds})`);

    // 7. Register a secondary dynamic host node (0 active worlds)
    const regHostRes = await fetch(`${baseUrl}/hosts/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'host-worker-02',
        name: 'Secondary Dynamic Worker Node',
        hostIp: '127.0.0.1',
        publicHost: '127.0.0.1',
        dockerApiUrl: 'http://127.0.0.1:2375',
        activeWorlds: 0,
        maxWorlds: 10,
        portRange: { min: 8001, max: 8050 },
        status: 'HEALTHY',
        isPermanent: false,
      }),
    });
    const regHostData = await regHostRes.json();
    assert(regHostRes.status === 200 && regHostData.success === true, 'Registered secondary host node');

    // 8. Test POST /worlds (Least-Loaded Placement should choose host-worker-02 because load 0/10 < 1/10)
    const createRes = await fetch(`${baseUrl}/worlds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Desierto Misterioso',
        seed: 99482,
        biome: 'desert',
      }),
    });
    const createData = await createRes.json();
    assert(createRes.status === 201, 'POST /worlds returns HTTP 201 Created');
    assert(createData.success === true, 'Response contains success: true');
    assert(createData.world?.hostId === 'host-worker-02', `World placed on least-loaded host (hostId: ${createData.world?.hostId})`);
    assert(createData.world?.port >= 8001, `Assigned available port on selected host (port: ${createData.world?.port})`);
    assert(createData.world?.wsUrl?.includes(`:${createData.world?.port}`), `wsUrl points to selected host endpoint (${createData.world?.wsUrl})`);
    assert(typeof createData.world?.containerId === 'string', `Container ID generated (${createData.world?.containerId})`);

    const createdWorldId = createData.world.id;

    // 9. Verify host load updated in fleet
    const checkHostsRes = await fetch(`${baseUrl}/hosts`);
    const checkHostsData = await checkHostsRes.json();
    const workerHost = checkHostsData.hosts.find((h) => h.id === 'host-worker-02');
    assert(workerHost?.activeWorlds === 1, `host-worker-02 activeWorlds incremented to 1 (current: ${workerHost?.activeWorlds})`);

    // 10. Test GET /worlds/:id
    const getRes = await fetch(`${baseUrl}/worlds/${createdWorldId}`);
    const getData = await getRes.json();
    assert(getRes.status === 200, `GET /worlds/${createdWorldId} returns HTTP 200`);
    assert(getData.world?.name === 'Desierto Misterioso', 'Fetched world details match created world');

    // 11. Test POST /worlds/:id/shutdown (Despawn / Idle Shutdown)
    const shutdownRes = await fetch(`${baseUrl}/worlds/${createdWorldId}/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtimeId: getData.world.runtimeId }),
    });
    const shutdownData = await shutdownRes.json();
    assert(shutdownRes.status === 200 && shutdownData.success === true, 'POST /worlds/:id/shutdown cleanly stops world on idle');
    assert(shutdownData.world?.status === 'INACTIVE', 'Shutdown world returns to status INACTIVE');
    assert(shutdownData.world?.port === null && shutdownData.world?.wsUrl === null, 'Shutdown world frees port and wsUrl');

    // 12. Verify world remains in catalog with status INACTIVE and host load was decremented
    const verifyGetRes = await fetch(`${baseUrl}/worlds/${createdWorldId}`);
    const verifyGetData = await verifyGetRes.json();
    assert(verifyGetRes.status === 200 && verifyGetData.world?.status === 'INACTIVE', 'World preserved in catalog as INACTIVE');

    const verifyHostRes = await fetch(`${baseUrl}/hosts`);
    const verifyHostData = await verifyHostRes.json();
    const workerHostAfter = verifyHostData.hosts.find((h) => h.id === 'host-worker-02');
    assert(workerHostAfter?.activeWorlds === 0, `host-worker-02 activeWorlds decremented back to 0 (current: ${workerHostAfter?.activeWorlds})`);

    // 12b. Explicit DELETE removes dynamic world from catalog
    const deleteDynamicRes = await fetch(`${baseUrl}/worlds/${createdWorldId}`, { method: 'DELETE' });
    assert(deleteDynamicRes.status === 200, 'DELETE /worlds/:id removes dynamic world from catalog');
    const verifyDeletedRes = await fetch(`${baseUrl}/worlds/${createdWorldId}`);
    assert(verifyDeletedRes.status === 404, 'GET on deleted world returns HTTP 404 Not Found');

    // 13. Test Stop World Container (POST /worlds/world-01/stop)
    const stopDefaultRes = await fetch(`${baseUrl}/worlds/world-01/stop`, { method: 'POST' });
    const stopDefaultData = await stopDefaultRes.json();
    assert(stopDefaultRes.status === 200 && stopDefaultData.success === true, 'POST /worlds/world-01/stop stops default world');
    assert(stopDefaultData.world.status === 'INACTIVE', 'Stopped default world returns to status INACTIVE');
    assert(stopDefaultData.world.port === null && stopDefaultData.world.wsUrl === null, 'Stopped world frees port and wsUrl');

    const hostsFinalRes = await fetch(`${baseUrl}/hosts`);
    const hostsFinalData = await hostsFinalRes.json();
    const primaryFinal = hostsFinalData.hosts.find((h) => h.id === 'host-primary-01');
    assert(primaryFinal?.activeWorlds === 0, `host-primary-01 activeWorlds decremented back to 0 (current: ${primaryFinal?.activeWorlds})`);

    // 14. Verify protected default world cannot be deleted
    const deleteDefaultRes = await fetch(`${baseUrl}/worlds/world-01`, {
      method: 'DELETE',
    });
    assert(deleteDefaultRes.status === 400 || deleteDefaultRes.status === 404, 'Default world is protected from deletion');
  } finally {
    // Cleanup
    await app.stop();
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n📊 Summary: ${passed} Passed, ${failed} Failed\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 All Stateless Lobby tests passed successfully!');
    process.exit(0);
  }
}

runLobbyTests().catch((err) => {
  console.error('💥 Lobby test fatal error:', err);
  process.exit(1);
});
