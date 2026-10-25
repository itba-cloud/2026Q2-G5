import { World } from '../src/engine/World.js';

async function runTurretAndCombatTests() {
  console.log('🧪 Starting Turret Combat & Spatial Hash Collision Tests...\n');

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
    worldId: 'turret-test-world',
    seed: 54321,
    worldWidth: 1000,
    worldHeight: 1000,
  });

  // ==========================================
  // TEST 1: Turret Construction and Specs
  // ==========================================
  console.log('🏗️ [Test 1] Turret Construction & Specs');
  const owner = world.addPlayer('p_owner', 'EngineerBob');
  owner.x = 200;
  owner.y = 200;
  owner.inventory.wood = 50;
  owner.inventory.stone = 50;

  const buildRes = world.buildStructure(owner.id, 'turret', 230, 200);
  assert(buildRes.success, 'Turret built successfully');
  const turret = buildRes.structure;
  assert(turret.type === 'turret', 'Structure type is turret');
  assert(turret.range === 220, `Turret range configured to 220 (got: ${turret.range})`);
  assert(turret.damage === 20, `Turret damage configured to 20 (got: ${turret.damage})`);
  assert(turret.fireRate === 1.0, `Turret fireRate configured to 1.0s (got: ${turret.fireRate})`);
  assert(turret.bulletSpeed === 380, `Turret bulletSpeed configured to 380 (got: ${turret.bulletSpeed})`);
  assert(turret.ownerId === owner.id, `Turret owner is correctly assigned to player ${owner.id}`);

  // ==========================================
  // TEST 2: Friendly Immunity (Owner Protection)
  // ==========================================
  console.log('\n🛡️ [Test 2] Friendly Immunity (Turret does not shoot owner)');
  // Advance simulation 1.5 seconds with only owner near turret
  for (let i = 0; i < 30; i++) {
    world.tick(0.05);
  }
  assert(turret.targetId === null, 'Turret has no target when only owner is nearby');
  assert(world.combatSystem.projectiles.size === 0, 'No projectiles spawned against owner');
  assert(owner.hp === 100, 'Owner HP remains untouched at 100');

  // ==========================================
  // TEST 3: Out-of-Range Enemy Ignored
  // ==========================================
  console.log('\n🔭 [Test 3] Out-of-Range Enemy Ignored');
  const farEnemy = world.addPlayer('p_far', 'FarEnemy');
  farEnemy.x = turret.x + 350; // Distance 350 > range 220
  farEnemy.y = turret.y;

  world.tick(0.05);
  assert(turret.targetId === null, 'Turret ignores enemy that is 350px away (> 220 range)');
  assert(world.combatSystem.projectiles.size === 0, 'No projectiles fired at out-of-range enemy');

  // ==========================================
  // TEST 4: Enemy In-Range Target Acquisition & Shooting
  // ==========================================
  console.log('\n🎯 [Test 4] In-Range Enemy Targeting and Firing');
  const enemy = world.addPlayer('p_enemy', 'IntruderAlice');
  enemy.x = turret.x + 100; // 100px away (within range 220)
  enemy.y = turret.y;
  enemy.hp = 100;

  // Reset lastShootTime to allow immediate shot
  turret.lastShootTime = 0;

  let shotEventFired = false;
  const originalOnEvent = world.onEvent;
  world.onEvent = (type, payload) => {
    if (type === 'TURRET_SHOT') {
      shotEventFired = true;
    }
    if (typeof originalOnEvent === 'function') originalOnEvent(type, payload);
  };

  world.tick(0.05);

  assert(turret.targetId === enemy.id, `Turret acquired target: ${enemy.id}`);
  assert(shotEventFired, 'TURRET_SHOT event broadcasted');
  assert(world.combatSystem.projectiles.size === 1, 'Turret projectile spawned in CombatSystem');

  const proj = Array.from(world.combatSystem.projectiles.values())[0];
  assert(proj.shooterId === turret.id, `Projectile shooterId matches turret (${proj.shooterId})`);
  assert(proj.shooterOwnerId === owner.id, `Projectile shooterOwnerId matches owner (${proj.shooterOwnerId})`);
  assert(proj.damage === 20, `Projectile damage is 20 (got: ${proj.damage})`);

  // Advance simulation to let projectile reach enemy (100px / 380px/s ≈ 0.26s -> 6 ticks)
  for (let i = 0; i < 8; i++) {
    world.tick(0.05);
  }

  assert(enemy.hp === 80, `Enemy took 20 damage from turret projectile (current HP: ${enemy.hp})`);

  // ==========================================
  // TEST 5: Turret Self-Collision Immunity
  // ==========================================
  console.log('\n🔒 [Test 5] Turret Self-Collision Immunity');
  assert(turret.hp === 80, `Turret took 0 self-damage when firing (HP: ${turret.hp})`);

  // ==========================================
  // TEST 6: Turret Kill Attribution to Owner
  // ==========================================
  console.log('\n💀 [Test 6] Kill Attribution to Turret Owner');
  enemy.hp = 15; // Set low so 1 shot of 20 dmg kills
  turret.lastShootTime = 0; // Ready to shoot
  const ownerKillsBefore = owner.kills || 0;

  world.tick(0.05); // Turret shoots
  for (let i = 0; i < 8; i++) {
    world.tick(0.05);
  }

  assert(enemy.isDead === true, 'Enemy was killed by turret projectile');
  assert(owner.kills === ownerKillsBefore + 1, `Owner received +1 kill score (current kills: ${owner.kills})`);

  // ==========================================
  // TEST 7: Spatial Hash Grid Structure Collisions
  // ==========================================
  console.log('\n🧱 [Test 7] Projectile Structure Collisions via Spatial Hash Grid');
  // Position owner close to (500, 700) and provide wood
  owner.x = 460;
  owner.y = 700;
  owner.inventory.wood = 50;

  // Build a defensive wall between owner and a target spot
  const wallBuild = world.buildStructure(owner.id, 'wall', 500, 700);
  assert(wallBuild.success, 'Test wall built at (500, 700)');
  const wall = wallBuild.structure;
  const initialWallHp = wall.hp;

  // Build several dummy structures far away to verify spatial partitioning
  for (let i = 1; i <= 20; i++) {
    const dummy = {
      id: `dummy_struct_${i}`,
      type: 'wall',
      x: 800 + i * 5,
      y: 800 + i * 5,
      hp: 100,
      radius: 18,
      blocksProjectiles: true,
      blocksMovement: true,
    };
    world.structures.set(dummy.id, dummy);
    world.collisionSystem.insert(dummy);
  }

  // Shooter at (420, 700) shoots right directly at wall at (500, 700)
  owner.x = 420;
  owner.y = 700;
  world.combatSystem.lastShootTimes.clear();
  const playerProj = world.shoot(owner.id, 0); // Angle 0 -> right towards (500, 700)
  assert(playerProj !== null, 'Player projectile fired towards wall');

  // Advance simulation to impact wall (80px / 400px/s = 0.2s -> 4 ticks)
  for (let i = 0; i < 6; i++) {
    world.tick(0.05);
  }

  assert(wall.hp === initialWallHp - 25, `Wall collided and absorbed 25 damage (HP: ${wall.hp})`);

  // Destroy wall completely
  wall.hp = 20;
  world.combatSystem.lastShootTimes.clear();
  world.shoot(owner.id, 0);
  for (let i = 0; i < 6; i++) {
    world.tick(0.05);
  }

  assert(!world.structures.has(wall.id), 'Wall destroyed and removed from world structures Map');
  const nearbyAfterDestroy = world.collisionSystem.getNearbyColliders(500, 700, 30, world);
  assert(
    !nearbyAfterDestroy.some((c) => c.id === wall.id),
    'Wall removed from Spatial Hash Grid upon destruction'
  );

  // ==========================================
  // TEST 8: Sync State Serialization
  // ==========================================
  console.log('\n📡 [Test 8] Sync State Structure Serialization');
  turret.angle = 1.57;
  turret.targetId = 'p_dummy_sync';
  const syncState = world.getSyncState();
  const syncedTurret = syncState.structures.find((s) => s.id === turret.id);
  assert(syncedTurret !== undefined, 'Turret present in STATE_SYNC structures list');
  assert(syncedTurret.angle === 1.57, `Turret angle synced correctly (${syncedTurret.angle})`);
  assert(syncedTurret.targetId === 'p_dummy_sync', `Turret targetId synced correctly (${syncedTurret.targetId})`);

  // ==========================================
  // TEST 9: Projectile Resource Obstacle Collisions (0 Damage, Projectile Dies)
  // ==========================================
  console.log('\n🌲 [Test 9] Projectile Solid Resource Collisions (Trees & Rocks)');
  const testTree = {
    id: 'test_obstacle_tree',
    type: 'tree',
    x: 600,
    y: 600,
    hp: 3,
    maxHp: 3,
    radius: 18,
    colliderRadius: 14,
    blocksMovement: true,
    blocksProjectiles: true,
  };
  world.resources.set(testTree.id, testTree);
  world.collisionSystem.insert(testTree);

  let resourceHitEvent = null;
  world.onEvent = (type, payload) => {
    if (type === 'PLAYER_HIT' && payload.type === 'RESOURCE') {
      resourceHitEvent = payload;
    }
  };

  // Shoot directly at tree at (600, 600) from (540, 600)
  owner.x = 540;
  owner.y = 600;
  world.combatSystem.lastShootTimes.clear();
  const treeProj = world.shoot(owner.id, 0); // Angle 0 -> right towards (600, 600)
  assert(treeProj !== null, 'Projectile fired towards tree obstacle');

  for (let i = 0; i < 6; i++) {
    world.tick(0.05);
  }

  assert(world.combatSystem.projectiles.size === 0, 'Projectile died upon colliding with tree');
  assert(testTree.hp === 3, `Tree HP was NOT damaged by projectile (HP remains ${testTree.hp}/3)`);
  assert(resourceHitEvent !== null, 'RESOURCE hit event emitted for client particle animation');
  assert(resourceHitEvent?.targetId === testTree.id, `Hit event points to tree (${resourceHitEvent?.targetId})`);
  assert(resourceHitEvent?.damage === 0, 'Hit event specifies 0 damage');

  console.log(`\n📊 Turret Combat Tests Summary: ${passed} Passed, ${failed} Failed\n`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 All Turret Combat & Spatial Hash Collision Tests Passed Successfully!');
    process.exit(0);
  }
}

runTurretAndCombatTests().catch((err) => {
  console.error('💥 Turret test fatal error:', err);
  process.exit(1);
});
