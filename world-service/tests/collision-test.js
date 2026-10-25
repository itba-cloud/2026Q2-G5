import { World } from '../src/engine/World.js';

async function runCollisionUnitTests() {
  console.log('🧪 Starting Modular Collision System Tests...\n');

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

  const world = new World({
    worldId: 'collision-test-world',
    seed: 99999,
    worldWidth: 1000,
    worldHeight: 1000,
  });

  // TEST 1: Wall Solid Collision (Cannot Walk Through)
  console.log('🧱 [Test 1] Wall Obstacle Collision');
  const p1 = world.addPlayer('p_col_1', 'BlockTester');
  p1.x = 100;
  p1.y = 100;

  // Give resources and build wall at (140, 100)
  p1.inventory.wood = 20;
  const wallRes = world.buildStructure(p1.id, 'wall', 140, 100);
  assert(wallRes.success, 'Wall built at X=140, Y=100');
  assert(wallRes.structure.blocksMovement === true, 'Wall has blocksMovement = true');

  // Player attempts to walk directly right through the wall
  world.setPlayerMovement(p1.id, 1, 0);

  // Advance 10 ticks (0.5 sec -> 75 pixels attempted movement)
  for (let i = 0; i < 10; i++) {
    world.tick(0.05);
  }

  // With wall radius 18 and player radius 16, max X must be <= 140 - 34 = 106
  assert(p1.x <= 106.1, `Player stopped before penetrating wall: X=${Math.round(p1.x * 100) / 100} (<= 106)`);

  // TEST 2: Diagonal Sliding Along Wall Surface
  console.log('\n⛷️ [Test 2] Diagonal Sliding on Wall Surface');
  p1.x = 105;
  p1.y = 100;
  // Move diagonally (Right and Down)
  world.setPlayerMovement(p1.id, 1, 1);

  for (let i = 0; i < 10; i++) {
    world.tick(0.05);
  }

  // X should still be blocked/sliding along wall, but Y must advance smoothly downwards
  assert(p1.x <= 140, `Player X remained constrained by wall surface (X=${Math.round(p1.x)})`);
  assert(p1.y > 115, `Player slid smoothly downwards along Y axis (Y=${Math.round(p1.y)} > 115)`);

  // TEST 3: Walkthrough Non-blocking Structure (Campfire)
  console.log('\n🔥 [Test 3] Walkthrough Non-blocking Structure (Campfire)');
  p1.inventory.wood = 20;
  p1.inventory.stone = 20;
  p1.x = 200;
  p1.y = 300;
  // Clear any procedural resource at test zone
  world.resources.delete('tree_1');
  world.resources.delete('tree_2');
  const fireRes = world.buildStructure(p1.id, 'campfire', p1.x + 35, p1.y);
  if (!fireRes.success) {
    console.error('  Campfire build failed with reason:', fireRes.reason);
  }
  assert(fireRes.success && fireRes.structure?.blocksMovement === false, 'Campfire has blocksMovement = false');

  world.setPlayerMovement(p1.id, 1, 0); // Walk right across campfire

  for (let i = 0; i < 10; i++) {
    world.tick(0.05);
  }

  assert(p1.x > 250, `Player successfully walked across campfire without being blocked (X=${Math.round(p1.x)} > 250)`);

  // TEST 4: Solid Resource Collisions (Trees & Rocks)
  console.log('\n🪨 [Test 4] Solid Resource (Rock) Collision');
  // Manually add a solid rock and index it
  const rockObj = {
    id: 'test_rock',
    type: 'rock',
    x: 500,
    y: 500,
    radius: 15,
    colliderRadius: 15,
    blocksMovement: true,
  };
  world.resources.set('test_rock', rockObj);
  world.collisionSystem.insert(rockObj);

  p1.x = 460;
  p1.y = 500;
  world.setPlayerMovement(p1.id, 1, 0); // Walk towards rock

  for (let i = 0; i < 10; i++) {
    world.tick(0.05);
  }

  // Distance: 500 - (16 + 15) = 469
  assert(p1.x <= 469.1, `Player stopped before penetrating solid rock: X=${Math.round(p1.x * 100) / 100} (<= 469)`);

  // TEST 5: World Boundaries
  console.log('\n🗺️ [Test 5] World Boundaries');
  p1.x = 20;
  p1.y = 20;
  world.setPlayerMovement(p1.id, -1, -1); // Walk towards top-left corner

  for (let i = 0; i < 10; i++) {
    world.tick(0.05);
  }

  assert(p1.x >= 16 && p1.y >= 16, `Player constrained to world boundaries: X=${p1.x}, Y=${p1.y} (>= 16)`);

  // TEST 6: Automatic Depenetration (Idle player inside obstacle is pushed out)
  console.log('\n🧲 [Test 6] Automatic Depenetration for Idle Player');
  const p2 = world.addPlayer('p_col_2', 'DepenetrationTester');
  // Place rock at (600, 600) with radius 15
  const rock2 = {
    id: 'test_rock_2',
    type: 'rock',
    x: 600,
    y: 600,
    radius: 15,
    colliderRadius: 15,
    blocksMovement: true,
  };
  world.resources.set('test_rock_2', rock2);
  world.collisionSystem.insert(rock2);

  // Place idle player directly overlapping inside the rock (dist = 5, minDist = 31)
  p2.x = 605;
  p2.y = 600;
  world.setPlayerMovement(p2.id, 0, 0);

  // Single tick should push player out of the rock
  world.tick(0.05);
  const distAfterTick = Math.hypot(p2.x - rock2.x, p2.y - rock2.y);
  assert(
    distAfterTick >= 30.9,
    `Idle player automatically pushed out of rock: dist=${Math.round(distAfterTick * 10) / 10} (minDist=31)`
  );

  // TEST 7: Escape from overlapping obstacle by moving
  console.log('\n🏃 [Test 7] Moving Player Escaping from Overlap');
  p2.x = 605;
  p2.y = 600;
  // Move to the right (away from rock at 600, 600)
  world.setPlayerMovement(p2.id, 1, 0);
  world.tick(0.05);

  const distMoving = Math.hypot(p2.x - rock2.x, p2.y - rock2.y);
  const isStillOverlapping = world.collisionSystem.isOverlapping(p2.x, p2.y, p2.radius, world);
  assert(
    !isStillOverlapping && distMoving >= 30.9,
    `Player moving away successfully escaped obstacle: dist=${Math.round(distMoving * 10) / 10} (minDist=31, overlapping=${isStillOverlapping})`
  );

  // TEST 8: Structure Built on Player Automatically Pushes Player Out
  console.log('\n🏗️ [Test 8] Structure Built Over Player Pushes Player Out');
  const p3 = world.addPlayer('p_col_3', 'BuilderVictim');
  p3.x = 700;
  p3.y = 700;
  p3.inventory.wood = 20;

  // Build wall right at (705, 700) overlapping player (minDist = 16 + 18 = 34)
  const wallOverPlayer = world.buildStructure(p3.id, 'wall', 705, 700);
  assert(wallOverPlayer.success, 'Wall successfully built near/over player');

  const distToWall = Math.hypot(p3.x - wallOverPlayer.structure.x, p3.y - wallOverPlayer.structure.y);
  assert(
    distToWall >= 33.9,
    `Player immediately pushed out of newly built wall: dist=${Math.round(distToWall * 10) / 10} (minDist=34)`
  );

  // TEST 9: Safe Random Spawn & Respawn (0 Overlaps and Distributed Across Map)
  console.log('\n🎲 [Test 9] Safe Random Spawn & Respawn');
  let spawnOverlaps = 0;
  const spawnedXList = [];
  const spawnedYList = [];

  for (let i = 0; i < 30; i++) {
    const safePos = world.getSafeSpawnPosition(null, null, 16);
    if (world.collisionSystem.isOverlapping(safePos.x, safePos.y, 16, world)) {
      spawnOverlaps++;
    }
    spawnedXList.push(safePos.x);
    spawnedYList.push(safePos.y);
  }

  assert(spawnOverlaps === 0, `30 random spawn points tested: 0 collisions/overlaps found`);

  // Check that spawns are distributed across the map and not all concentrated in center
  const minSpawnX = Math.min(...spawnedXList);
  const maxSpawnX = Math.max(...spawnedXList);
  const minSpawnY = Math.min(...spawnedYList);
  const maxSpawnY = Math.max(...spawnedYList);
  const spawnSpreadX = maxSpawnX - minSpawnX;
  const spawnSpreadY = maxSpawnY - minSpawnY;

  assert(
    spawnSpreadX > 300 && spawnSpreadY > 300,
    `Spawns are distributed randomly across map: spreadX=${spawnSpreadX}, spreadY=${spawnSpreadY} (> 300)`
  );

  // Respawn dead player
  p3.isDead = true;
  world.respawnPlayer(p3);
  assert(!p3.isDead && p3.hp === p3.maxHp, 'Player respawned successfully with full health');
  assert(
    !world.collisionSystem.isOverlapping(p3.x, p3.y, p3.radius, world),
    `Respawned player location (X=${p3.x}, Y=${p3.y}) is free of obstacles`
  );

  console.log(`\n📊 Collision Tests Summary: ${passed} Passed, ${failed} Failed\n`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 All Collision Tests Passed Successfully!');
    process.exit(0);
  }
}

runCollisionUnitTests().catch((err) => {
  console.error('💥 Collision test error:', err);
  process.exit(1);
});
