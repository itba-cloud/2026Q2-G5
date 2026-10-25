import { PredictionEngine } from '../js/prediction.js';
import { NetworkClient } from '../js/network.js';

async function runClientPredictionTests() {
  console.log('🧪 Starting Client-Side Prediction & Latency Simulation Tests...\n');

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

  // =========================================================================
  // TEST 1: Basic Movement Integration
  // =========================================================================
  console.log('🏃 [Test 1] Basic Movement & Delta Time Integration');
  const engine = new PredictionEngine({
    worldWidth: 1000,
    worldHeight: 1000,
    playerSpeed: 150,
    playerRadius: 16,
  });

  engine.init({
    worldWidth: 1000,
    worldHeight: 1000,
    playerId: 'test_player_1',
    player: { x: 200, y: 200, speed: 150, radius: 16 },
  });

  // Move right for 0.1s -> should advance 15px
  engine.setMovement(1, 0);
  engine.update(0.1, new Map(), new Map());
  let pos = engine.getRenderPosition();
  assert(Math.abs(pos.x - 215) < 0.01, `Player moved right 15px (X=${pos.x}, expected 215)`);
  assert(pos.y === 200, `Player Y remained constant (Y=${pos.y})`);

  // =========================================================================
  // TEST 2: World Boundaries Clamping
  // =========================================================================
  console.log('\n🗺️ [Test 2] World Boundaries Clamping');
  engine.predictedX = 20;
  engine.predictedY = 20;

  // Move left towards boundary 0
  engine.setMovement(-1, 0);
  for (let i = 0; i < 10; i++) {
    engine.update(0.05, new Map(), new Map());
  }
  pos = engine.getRenderPosition();
  assert(pos.x === 16, `Player clamped to left boundary radius (X=${pos.x}, expected 16)`);

  // =========================================================================
  // TEST 3: Solid Structure Collision (Muro de Madera - blocksMovement: true)
  // =========================================================================
  console.log('\n🧱 [Test 3] Solid Wall Obstacle Collision & Sliding');
  engine.predictedX = 100;
  engine.predictedY = 100;

  const structures = new Map();
  structures.set('wall_1', {
    id: 'wall_1',
    type: 'wall',
    x: 140,
    y: 100,
    radius: 18,
    blocksMovement: true,
  });

  // Walk directly into the wall
  engine.setMovement(1, 0);
  for (let i = 0; i < 10; i++) {
    engine.update(0.05, structures, new Map());
  }
  pos = engine.getRenderPosition();
  // Player (r=16) + Wall (r=18) -> min distance is 34. Wall at X=140 => max X is 106
  assert(pos.x <= 106.01, `Player blocked before penetrating wall (X=${Math.round(pos.x * 100) / 100} <= 106)`);

  // Diagonal sliding: move right & down (1, 1) -> X curves along circular obstacle, Y advances
  engine.setMovement(1, 1);
  for (let i = 0; i < 5; i++) {
    engine.update(0.05, structures, new Map());
  }
  pos = engine.getRenderPosition();
  const distToWall = Math.hypot(pos.x - 140, pos.y - 100);
  assert(distToWall >= 33.9, `Player did not penetrate wall collider while sliding (dist=${Math.round(distToWall * 100) / 100} >= 34)`);
  assert(pos.y > 100, `Player sliding: Y advances smoothly downwards (Y=${Math.round(pos.y * 100) / 100} > 100)`);

  // =========================================================================
  // TEST 4: Passable Structure (Fogata - blocksMovement: false)
  // =========================================================================
  console.log('\n🔥 [Test 4] Passable Structure (Campfire - blocksMovement: false)');
  structures.clear();
  structures.set('fire_1', {
    id: 'fire_1',
    type: 'campfire',
    x: 140,
    y: 100,
    radius: 16,
    blocksMovement: false, // Traspasable
  });

  engine.predictedX = 100;
  engine.predictedY = 100;
  engine.setMovement(1, 0);

  // Advance 0.5s (75px)
  for (let i = 0; i < 10; i++) {
    engine.update(0.05, structures, new Map());
  }
  pos = engine.getRenderPosition();
  assert(pos.x >= 170, `Player passed straight through campfire without obstruction (X=${Math.round(pos.x * 100) / 100} >= 170)`);

  // =========================================================================
  // TEST 5: Resource Collisions (Solid Trees vs Walkable Bushes)
  // =========================================================================
  console.log('\n🌲 [Test 5] Resource Collisions (Solid Trees vs Walkable Bushes)');
  const resources = new Map();
  resources.set('tree_1', {
    id: 'tree_1',
    type: 'tree',
    x: 200,
    y: 100,
    radius: 18,
    colliderRadius: 12,
    blocksMovement: true,
    hp: 3,
  });

  engine.predictedX = 150;
  engine.predictedY = 100;
  engine.setMovement(1, 0);

  // Walk into tree at X=200 (colliderRadius 12 + player 16 = 28 min dist => X <= 172)
  for (let i = 0; i < 10; i++) {
    engine.update(0.05, structures, resources);
  }
  pos = engine.getRenderPosition();
  assert(pos.x <= 172.01, `Player blocked by solid tree (X=${Math.round(pos.x * 100) / 100} <= 172)`);

  // Walk through a bush (blocksMovement: false)
  resources.clear();
  resources.set('bush_1', {
    id: 'bush_1',
    type: 'bush',
    x: 200,
    y: 100,
    radius: 12,
    colliderRadius: 0,
    blocksMovement: false,
    hp: 1,
  });

  engine.predictedX = 150;
  engine.predictedY = 100;
  engine.setMovement(1, 0);

  for (let i = 0; i < 10; i++) {
    engine.update(0.05, structures, resources);
  }
  pos = engine.getRenderPosition();
  assert(pos.x >= 220, `Player walked freely through bush without stopping (X=${Math.round(pos.x * 100) / 100} >= 220)`);

  // Walk into harvested tree stump (hp: 0, stage: 'stump', blocksMovement: true)
  resources.clear();
  resources.set('tree_stump', {
    id: 'tree_stump',
    type: 'tree',
    stage: 'stump',
    x: 200,
    y: 100,
    radius: 18,
    colliderRadius: 12,
    blocksMovement: true,
    hp: 0,
  });

  engine.predictedX = 150;
  engine.predictedY = 100;
  engine.setMovement(1, 0);

  for (let i = 0; i < 10; i++) {
    engine.update(0.05, structures, resources);
  }
  pos = engine.getRenderPosition();
  assert(pos.x <= 172.01, `Player blocked by harvested tree stump (X=${Math.round(pos.x * 100) / 100} <= 172)`);

  // =========================================================================
  // TEST 6: Predicted Projectiles Spawning & Obstacle Collision
  // =========================================================================
  console.log('\n🎯 [Test 6] Predicted Projectiles & Local Obstacle Impact');
  let impactTriggered = false;
  let impactX = 0;
  let impactY = 0;

  engine.onLocalImpact = (x, y, collider) => {
    impactTriggered = true;
    impactX = x;
    impactY = y;
  };

  // Clear structures and put a wall in front of shooter
  structures.clear();
  structures.set('wall_target', {
    id: 'wall_target',
    type: 'wall',
    x: 300,
    y: 100,
    radius: 18,
    blocksMovement: true,
  });

  // Shoot towards angle 0 (right towards wall at 300)
  const proj = engine.spawnPredictedProjectile('test_player_1', 200, 100, 0, { speed: 400 });
  assert(proj !== null, 'Spawned local predicted projectile');
  assert(engine.predictedProjectiles.length === 1, 'Predicted projectile in active pool');

  // The engine mirrors the authoritative CombatSystem cooldown (250ms), so a second
  // immediate click must NOT paint a ghost bullet the server never created.
  const rejected = engine.spawnPredictedProjectile('test_player_1', 200, 100, 0, { speed: 400 });
  assert(rejected === null, 'Rapid second shot rejected by mirrored server cooldown');
  assert(engine.predictedProjectiles.length === 1, 'No ghost bullet added while on cooldown');

  // Advance simulation until projectile hits wall (distance ~80px, speed 400 -> takes ~0.2s)
  for (let i = 0; i < 6; i++) {
    engine.update(0.05, structures, resources);
  }

  assert(impactTriggered, 'Local impact event triggered upon hitting wall');
  assert(engine.predictedProjectiles.length === 0, 'Predicted projectile removed on impact');
  assert(impactX > 200 && impactX <= 300, `Impact location recorded accurately (X=${Math.round(impactX)})`);

  // =========================================================================
  // TEST 7: Server Reconciliation (Soft Blend vs Hard Snap)
  // =========================================================================
  console.log('\n🔄 [Test 7] Server Reconciliation & Hard Snap Teleport');
  engine.predictedX = 500;
  engine.predictedY = 500;
  engine.dirX = 0;
  engine.dirY = 0;

  // Case A: Minor stationary drift (e.g. server reports 504, 500 -> 4px difference)
  engine.reconcile({ x: 504, y: 500, dirX: 0, dirY: 0, isDead: false }, []);
  assert(engine.predictedX > 500 && engine.predictedX <= 504, `Stationary reconciliation converged towards server (X=${Math.round(engine.predictedX * 100) / 100})`);

  // Case B: Large difference (e.g. Respawn at 100, 100 -> > 80px error)
  engine.reconcile({ x: 100, y: 100, dirX: 0, dirY: 0, isDead: false }, []);
  pos = engine.getRenderPosition();
  assert(pos.x === 100 && pos.y === 100, `Hard snap applied immediately on large teleport/respawn (X=${pos.x}, Y=${pos.y})`);

  // =========================================================================
  // TEST 8: Zero-Duplicate Projectile Fusing
  // =========================================================================
  console.log('\n🚫 [Test 8] Zero-Duplicate Projectile Fusing');
  engine.predictedProjectiles = [];
  engine.serverProjectiles = [];
  engine.lastShotAt = -Infinity; // Clear the cooldown left over from Test 6

  // Local player shoots
  engine.spawnPredictedProjectile('test_player_1', 100, 100, 0);
  assert(engine.predictedProjectiles.length === 1, 'Local predicted projectile active');

  // Server sends sync packet with both local player's confirmed bullet and a remote player's bullet
  const incomingServerProjectiles = [
    { id: 'sp_confirmed_local', shooterId: 'test_player_1', x: 100, y: 100 },
    { id: 'sp_remote_enemy', shooterId: 'enemy_player_99', x: 450, y: 300 },
    { id: 'sp_turret_bullet', shooterId: 'struct_turret_1', x: 600, y: 200 },
  ];

  engine.reconcile({ x: 100, y: 100, dirX: 0, dirY: 0, isDead: false }, incomingServerProjectiles);
  const renderList = engine.getProjectilesToRender();

  // renderList should have: 1 local predicted + 2 remote (enemy + turret) = exactly 3, NO duplicated local bullet!
  assert(renderList.length === 3, `Render list has exactly 3 bullets (rendered: ${renderList.length}, expected: 3)`);
  const localRendered = renderList.filter((p) => p.shooterId === 'test_player_1');
  assert(localRendered.length === 1, `Local player has exactly 1 rendered bullet (found: ${localRendered.length})`);

  // =========================================================================
  // TEST 9: Predicted Bullet vs Player Bodies (client-side hit prediction)
  // =========================================================================
  console.log('');
  console.log('[Test 9] Predicted Bullet Collision Against Players');
  engine.predictedProjectiles = [];
  engine.serverProjectiles = [];
  engine.lastShotAt = -Infinity;
  structures.clear();
  resources.clear();

  let bodyHitId = null;
  let bodyHitX = 0;
  let bodyHitY = 0;
  engine.onLocalImpact = (x, y, collider) => {
    if (collider.isPlayer) {
      bodyHitId = collider.id;
      bodyHitX = x;
      bodyHitY = y;
    }
  };

  const players = new Map();
  players.set('test_player_1', { id: 'test_player_1', x: 100, y: 100, hp: 100, isDead: false });
  players.set('enemy_1', { id: 'enemy_1', x: 240, y: 100, hp: 100, isDead: false });

  // Shoot right from (100,100) towards the enemy standing at (240,100)
  engine.spawnPredictedProjectile('test_player_1', 100, 100, 0, { speed: 400 });
  for (let i = 0; i < 20; i++) {
    engine.update(0.02, structures, resources, players);
  }

  assert(bodyHitId === 'enemy_1', `Predicted bullet stopped on the enemy body (hit: ${bodyHitId})`);
  assert(engine.predictedProjectiles.length === 0, 'Bullet consumed on body impact instead of passing through');
  assert(
    bodyHitX === 240 && bodyHitY === 100,
    `Impact FX placed at the body centre like the server PLAYER_HIT event (${bodyHitX}, ${bodyHitY})`
  );

  // The shooter must never be hit by their own bullet
  bodyHitId = null;
  engine.lastShotAt = -Infinity;
  engine.spawnPredictedProjectile('test_player_1', 100, 100, Math.PI, { speed: 400 });
  engine.update(0.02, structures, resources, players);
  assert(bodyHitId === null, 'Shooter is immune to their own predicted bullet');

  // Dead players are transparent to bullets, exactly as on the server
  engine.predictedProjectiles = [];
  bodyHitId = null;
  engine.lastShotAt = -Infinity;
  players.set('enemy_1', { id: 'enemy_1', x: 240, y: 100, hp: 0, isDead: true });
  engine.spawnPredictedProjectile('test_player_1', 100, 100, 0, { speed: 400 });
  for (let i = 0; i < 20; i++) {
    engine.update(0.02, structures, resources, players);
  }
  assert(bodyHitId === null, 'Bullets pass through dead players');

  // A wall in front of the body absorbs the shot first (server checks obstacles first)
  engine.predictedProjectiles = [];
  bodyHitId = null;
  let obstacleHit = false;
  engine.lastShotAt = -Infinity;
  engine.onLocalImpact = (x, y, collider) => {
    if (collider.isPlayer) bodyHitId = collider.id;
    else obstacleHit = true;
  };
  players.set('enemy_1', { id: 'enemy_1', x: 240, y: 100, hp: 100, isDead: false });
  structures.set('shield', { id: 'shield', type: 'wall', x: 180, y: 100, radius: 18, blocksMovement: true });
  engine.spawnPredictedProjectile('test_player_1', 100, 100, 0, { speed: 400 });
  for (let i = 0; i < 20; i++) {
    engine.update(0.02, structures, resources, players);
  }
  assert(obstacleHit && bodyHitId === null, 'Wall in front of the target absorbs the bullet before the body');

  // =========================================================================
  // TEST 10: Simulated Latency in NetworkClient
  // =========================================================================
  console.log('\n🌐 [Test 10] Simulated Latency Pipeline');
  const net = new NetworkClient();
  assert(net.simulatedLatencyMs === 0, 'Default simulated latency is 0ms');

  net.setSimulatedLatency(150);
  assert(net.simulatedLatencyMs === 150, 'Simulated latency set to 150ms');

  net.setSimulatedLatency(0);
  assert(net.simulatedLatencyMs === 0, 'Simulated latency reset to 0ms');

  // Summary
  console.log('\n=============================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('=============================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runClientPredictionTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
