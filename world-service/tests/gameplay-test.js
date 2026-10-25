import { World } from '../src/engine/World.js';

async function runGameplayUnitTests() {
  console.log('🧪 Starting Gameplay Unit & Integration Tests...\n');

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

  // TEST 1: Resource Harvesting
  console.log('🌲 [Test 1] Resource Harvesting');
  const world = new World({
    worldId: 'unit-test-world',
    seed: 12345,
    worldWidth: 1000,
    worldHeight: 1000,
  });

  const p1 = world.addPlayer('p_1', 'SurvivorBob');
  // Find a tree
  const tree = Array.from(world.resources.values()).find((r) => r.type === 'tree');
  assert(tree !== undefined, 'Tree resource exists on map');

  // Move player near the tree
  p1.x = tree.x;
  p1.y = tree.y;

  const initialWood = p1.inventory.wood || 0;
  assert(initialWood === 0, 'Initial player wood is 0');

  // Harvest hit 1
  const h1 = world.harvest(p1.id, tree.id);
  assert(h1.success && !h1.harvested && h1.hp === 2, 'Hit 1 damages tree to 2 HP');

  // Harvest hit 2
  const h2 = world.harvest(p1.id, tree.id);
  assert(h2.success && !h2.harvested && h2.hp === 1, 'Hit 2 damages tree to 1 HP');

  // Harvest hit 3 (depletion)
  const harvestTime = Date.now();
  const h3 = world.harvest(p1.id, tree.id, harvestTime);
  assert(h3.success && h3.harvested, 'Hit 3 depletes tree completely');
  assert(world.resources.has(tree.id), 'Tree remains in active resources');
  assert(tree.stage === 'stump', 'Tree stage is stump');
  assert(tree.hp === 0, 'Tree HP is 0');
  assert(world.collisionSystem.collidersById.has(tree.id), 'Tree stump still has collision hitbox');
  assert(p1.inventory.wood === 3, `Player received 3 wood (current: ${p1.inventory.wood})`);

  // Attempt harvest on stump fails
  const hStump = world.harvest(p1.id, tree.id, harvestTime);
  assert(!hStump.success, 'Tree cannot be harvested while stump');

  // Advance time +30 seconds -> stage: 'branches'
  world.tick(0.05, harvestTime + 30000);
  assert(tree.stage === 'branches', `Tree stage advanced to branches at 30s (current: ${tree.stage})`);
  assert(tree.hp === 0, 'Tree HP remains 0 while branches are growing');

  // Advance time +60 seconds -> stage: 'full'
  world.tick(0.05, harvestTime + 60000);
  assert(tree.stage === 'full', `Tree stage returned to full at 60s (current: ${tree.stage})`);
  assert(tree.hp === 3, `Tree HP fully restored to 3 (current: ${tree.hp})`);

  // Test Bush Harvesting & 30s Regeneration
  const bush = Array.from(world.resources.values()).find((r) => r.type === 'bush');
  assert(bush !== undefined, 'Bush resource exists on map');
  const prevX = p1.x;
  const prevY = p1.y;
  p1.x = bush.x;
  p1.y = bush.y;
  const bushHarvestTime = harvestTime + 61000;
  const hBush = world.harvest(p1.id, bush.id, bushHarvestTime);
  assert(hBush.success && hBush.harvested, 'Bush harvested');
  assert(bush.stage === 'empty', 'Bush stage is empty');
  assert(p1.inventory.food === 1, 'Player received 1 food');

  // Advance time +30s for bush -> stage: 'full'
  world.tick(0.05, bushHarvestTime + 30000);
  assert(bush.stage === 'full', 'Bush returned to full stage at 30s');
  assert(bush.hp === 1, 'Bush HP restored to 1');

  // Move player to clear area for structure building test
  p1.x = 400;
  p1.y = 400;

  // TEST 2: Structure Building
  console.log('\n🏗️ [Test 2] Structure Building');
  // Try building wall without enough wood (needs 5, has 3)
  const bFail = world.buildStructure(p1.id, 'wall', p1.x + 30, p1.y);
  assert(!bFail.success && bFail.reason.includes('insuficientes'), 'Cannot build wall with only 3 wood');

  // Give player 10 wood & 10 stone
  p1.inventory.wood += 10; // now 13
  p1.inventory.stone += 10;

  const bWall = world.buildStructure(p1.id, 'wall', p1.x + 40, p1.y);
  assert(bWall.success && bWall.structure !== undefined, 'Wall built successfully');
  assert(p1.inventory.wood === 8, `5 wood deducted (remaining: ${p1.inventory.wood})`);
  assert(world.structures.has(bWall.structure.id), 'Wall added to world structures');

  // Build Campfire at (p1.x, p1.y - 40)
  const bFire = world.buildStructure(p1.id, 'campfire', p1.x, p1.y - 40);
  assert(bFire.success && bFire.structure.type === 'campfire', 'Campfire built successfully');
  assert(p1.inventory.wood === 5 && p1.inventory.stone === 8, 'Campfire costs deducted (3 wood, 2 stone)');

  // TEST 3: Combat and Wall Collisions
  console.log('\n🛡️ [Test 3] Projectile Blocking by Walls');
  // p1 shoots at the wall to the right (angle 0)
  const wallHpBefore = bWall.structure.hp;
  world.shoot(p1.id, 0);
  for (let i = 0; i < 5; i++) world.tick(0.05);
  assert(bWall.structure.hp === wallHpBefore - 25, `Wall absorbed projectile and took 25 damage (HP: ${bWall.structure.hp})`);

  // TEST 4: Combat and Player Hits
  console.log('\n🏹 [Test 4] Projectile Hits Player (PvP)');
  const p2 = world.addPlayer('p_2', 'TargetDummy');
  // Place p2 directly below p1 (unblocked)
  p2.x = p1.x;
  p2.y = p1.y + 100;
  p2.hp = 100;

  // Reset shoot cooldown for immediate synchronous test
  world.combatSystem.lastShootTimes.clear();

  // p1 shoots downwards at p2 (angle Math.PI / 2)
  const proj2 = world.shoot(p1.id, Math.PI / 2);
  assert(proj2 !== null, 'Downwards projectile created');
  for (let i = 0; i < 6; i++) {
    world.tick(0.05);
  }
  assert(p2.hp === 75, `Target dummy took 25 damage from projectile (current HP: ${p2.hp})`);

  // TEST 5: Campfire Healing
  console.log('\n🔥 [Test 5] Campfire Passive Healing');
  // Place wounded p2 near campfire
  p2.x = bFire.structure.x + 20;
  p2.y = bFire.structure.y;
  const hpBeforeHeal = p2.hp;

  // Advance 2 seconds near campfire
  for (let i = 0; i < 40; i++) {
    world.tick(0.05);
  }
  assert(p2.hp > hpBeforeHeal, `Campfire healed player from ${hpBeforeHeal} to ${Math.round(p2.hp)} HP`);

  // TEST 6: Food Consumption
  console.log('\n🍎 [Test 6] Food Consumption');
  p2.inventory.food = 2;
  p2.hp = 50;
  const foodRes = world.consumeFood(p2.id);
  assert(foodRes.success && p2.hp === 70 && p2.inventory.food === 1, 'Eating food restored +20 HP and consumed 1 food');

  // TEST 7: Player Death and Respawn
  console.log('\n☠️ [Test 7] Player Death & Respawn');
  p2.hp = 10;
  world.killPlayer(p2.id, p1.id);
  assert(p2.isDead === true && p2.hp === 0, 'Player killed and flagged as dead');
  assert(p1.kills === 1, 'Killer recorded +1 kill (kills: 1)');
  assert(p2.deaths === 1, 'Victim recorded +1 death (deaths: 1)');

  // Fast-forward past respawn delay
  p2.respawnAt = Date.now() - 100;
  world.tick(0.05);
  assert(p2.isDead === false && p2.hp === 100, 'Player respawned at full HP');

  // TEST 8: Bot Distinction & Human Player Counting
  console.log('\n🤖 [Test 8] Bot Distinction & Counting');
  import('../src/network/WebSocketServer.js').then(({ WebSocketServer }) => {
    const wsServer = new WebSocketServer({ port: 8999, world });
    // Mock clients
    wsServer.clients.set('p_human_1', { ws: {}, playerId: 'p_human_1', playerName: 'HumanAlice', isBot: false });
    wsServer.clients.set('p_bot_1', { ws: {}, playerId: 'p_bot_1', playerName: '[NPC] Guardian 1', isBot: true });
    wsServer.clients.set('p_bot_2', { ws: {}, playerId: 'p_bot_2', playerName: '[NPC] Guardian 2', isBot: true });

    assert(wsServer.getConnectedCount() === 3, 'Total connected clients is 3 (1 human + 2 bots)');
    assert(wsServer.getHumanPlayerCount() === 1, 'Human player count is exactly 1');

    // Disconnect human
    wsServer.clients.delete('p_human_1');
    assert(wsServer.getConnectedCount() === 2, 'Total connected clients is 2 (only bots)');
    assert(wsServer.getHumanPlayerCount() === 0, 'Human player count drops to 0 triggering idle countdown');

    console.log(`\n📊 Gameplay Tests Summary: ${passed} Passed, ${failed} Failed\n`);
    if (failed > 0) {
      process.exit(1);
    } else {
      console.log('🎉 All Gameplay Tests Passed Successfully!');
      process.exit(0);
    }
  });
}

runGameplayUnitTests().catch((err) => {
  console.error('💥 Gameplay test error:', err);
  process.exit(1);
});
