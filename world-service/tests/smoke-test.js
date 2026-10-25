import { WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';

// Override env for isolated testing
process.env.PORT = '8002';
process.env.WORLD_ID = 'test-world-01';
process.env.STORAGE_MODE = 'local';
process.env.DATA_DIR = './.test_data';
process.env.IDLE_TIMEOUT = '0'; // disable auto shutdown during test

import { WorldServiceApp } from '../src/index.js';
import { MessageTypes, createMessage, parseIncomingMessage } from '../src/network/protocol.js';

async function runSmokeTest() {
  console.log('🧪 Starting World Service Smoke Test...\n');

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

  // 1. Start Server Instance on isolated port
  const app = new WorldServiceApp({
    port: 8002,
    worldId: 'test-world-01',
    storageMode: 'local',
    dataDir: './.test_data',
    idleTimeoutSeconds: 0,
  });
  await app.start();
  assert(true, 'Server started successfully on port 8002');

  // 2. Connect Client
  const wsUrl = 'ws://localhost:8002';
  const ws = new WebSocket(wsUrl);

  let playerId = null;
  let initialX = null;
  let updatedX = null;
  let initReceived = false;
  let syncCount = 0;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Test timed out after 5000ms'));
    }, 5000);

    ws.on('open', () => {
      console.log('  🔌 Test client connected to WebSocket server');
      // Send JOIN
      ws.send(createMessage(MessageTypes.JOIN, { playerName: 'AliceExplorer' }));
    });

    ws.on('message', (rawData) => {
      const parsed = parseIncomingMessage(rawData);
      if (!parsed) return;

      const { type, payload } = parsed;

      if (type === MessageTypes.INIT) {
        initReceived = true;
        playerId = payload.playerId;
        initialX = payload.player.x;

        assert(payload.worldId === 'test-world-01', `INIT contains correct worldId (${payload.worldId})`);
        assert(typeof playerId === 'string' && playerId.startsWith('p_'), `INIT contains valid playerId (${playerId})`);
        assert(Array.isArray(payload.resources) && payload.resources.length > 0, `INIT contains ${payload.resources?.length} generated map resources`);
        assert(payload.player.name === 'AliceExplorer', `INIT has correct player name (${payload.player?.name})`);

        // Send MOVE command to the right: { x: 1, y: 0 }
        ws.send(createMessage(MessageTypes.MOVE, { direction: { x: 1, y: 0 } }));
      }

      if (type === MessageTypes.STATE_SYNC) {
        syncCount++;
        const playerInSync = payload.players?.find((p) => p.id === playerId);
        if (playerInSync) {
          updatedX = playerInSync.x;
        }

        // After collecting a few sync frames with movement
        if (syncCount >= 4) {
          clearTimeout(timeout);
          resolve();
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  assert(initReceived, 'Received INIT packet from server');
  assert(syncCount >= 4, `Received ${syncCount} STATE_SYNC packets at 20 Hz`);
  assert(updatedX !== null && updatedX > initialX, `Player position advanced from X=${initialX} to X=${updatedX} via MOVE command`);

  // 3. Disconnect Client
  ws.close();
  await new Promise((r) => setTimeout(r, 200));

  // 4. Shutdown Server
  await app.stop(false);
  assert(true, 'Server stopped cleanly without crashing');

  // 5. Verify Persisted File
  const persistedPath = path.resolve('./.test_data/test-world-01.json');
  try {
    const raw = await fs.readFile(persistedPath, 'utf-8');
    const snapshot = JSON.parse(raw);
    const savedPlayerData = snapshot.players_data['AliceExplorer'] || snapshot.players_data[playerId];
    assert(savedPlayerData?.name === 'AliceExplorer', 'Persisted snapshot preserved player name and progress');
    // Cleanup test data
    await fs.rm(path.resolve('./.test_data'), { recursive: true, force: true });
  } catch (err) {
    assert(false, `Persisted file check failed: ${err.message}`);
  }

  console.log(`\n📊 Summary: ${passed} Passed, ${failed} Failed\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 All tests passed successfully!');
    process.exit(0);
  }
}

runSmokeTest().catch((err) => {
  console.error('💥 Smoke test fatal error:', err);
  process.exit(1);
});
