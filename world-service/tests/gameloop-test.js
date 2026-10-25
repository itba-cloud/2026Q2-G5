import { World } from '../src/engine/World.js';
import { GameLoop } from '../src/engine/GameLoop.js';

/**
 * GameLoop timing tests.
 *
 * setInterval only promises "not before". A blocked event loop (GC pause, CPU contention,
 * disk I/O, a suspended host) delivers the tick arbitrarily late, and feeding that raw
 * elapsed time to the physics advances every moving entity by speed * elapsed in one step,
 * teleporting the whole world forward at once. These tests pin the clamp that prevents it.
 */
async function runGameLoopTests() {
  console.log('🧪 Starting GameLoop Timing & Stall Resilience Tests...\n');

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

  function makeWorld() {
    const world = new World({
      worldId: 'gameloop-test',
      seed: 48291,
      worldWidth: 1000,
      worldHeight: 1000,
      playerSpeed: 150,
      playerRadius: 16,
    });
    const player = world.addPlayer('p1', 'Tester');
    world.setPlayerMovement('p1', 1, 0);
    return { world, player };
  }

  /**
   * Runs the loop, blocking the event loop mid-flight, and reports the largest
   * distance any single tick moved the player.
   */
  function measureWorstTickStep({ stallMs, tickIntervalMs = 50, options = {} }) {
    return new Promise((resolve) => {
      const { world, player } = makeWorld();
      let worstStep = 0;
      let previous = { x: player.x, y: player.y };

      const loop = new GameLoop(
        world,
        () => {
          const step = Math.hypot(player.x - previous.x, player.y - previous.y);
          if (step > worstStep) worstStep = step;
          previous = { x: player.x, y: player.y };
        },
        tickIntervalMs,
        options
      );
      loop.start();

      setTimeout(() => {
        const start = Date.now();
        while (Date.now() - start < stallMs) {
          // Busy-wait: the event loop is completely blocked, exactly like a long GC pause
        }
      }, 300);

      setTimeout(() => {
        loop.stop();
        resolve({ worstStep, clampedTickCount: loop.clampedTickCount, worstStallMs: loop.worstStallMs });
      }, 300 + stallMs + 400);
    });
  }

  // ==========================================================================
  // TEST 1: Undisturbed loop advances at the nominal rate
  // ==========================================================================
  console.log('⏱️  [Test 1] Steady State Tick Rate');
  const steady = await measureWorstTickStep({ stallMs: 0 });
  // 150 units/s at 50ms = 7.5px, plus a little scheduler jitter
  assert(
    steady.worstStep > 5 && steady.worstStep < 12,
    `Undisturbed tick moves about one tick worth of distance (${steady.worstStep.toFixed(2)}px, nominal 7.50px)`
  );
  assert(steady.clampedTickCount === 0, 'No clamping happens on a healthy loop');

  // ==========================================================================
  // TEST 2: A stalled event loop must not teleport entities
  // ==========================================================================
  console.log('\n🧊 [Test 2] Blocked Event Loop Does Not Teleport Entities');
  const stalled = await measureWorstTickStep({ stallMs: 900 });
  // Default clamp is 2 tick intervals = 100ms = 15px. Unclamped this was ~140px.
  assert(
    stalled.worstStep <= 15.5,
    `A 900ms stall advances the player at most one clamped step (${stalled.worstStep.toFixed(2)}px, was ~140px unclamped)`
  );
  assert(stalled.clampedTickCount > 0, `The stall was detected and clamped (${stalled.clampedTickCount} tick(s))`);
  assert(
    stalled.worstStallMs >= 800,
    `The stall magnitude is recorded for diagnostics (${Math.round(stalled.worstStallMs)}ms)`
  );

  // ==========================================================================
  // TEST 3: The clamp window is configurable
  // ==========================================================================
  console.log('\n🎛️  [Test 3] Configurable Clamp Window');
  const tight = await measureWorstTickStep({ stallMs: 600, options: { maxDeltaTicks: 1 } });
  assert(
    tight.worstStep <= 8,
    `maxDeltaTicks=1 caps a stalled tick at a single interval (${tight.worstStep.toFixed(2)}px)`
  );

  // ==========================================================================
  // TEST 4: A clock jumping backwards never rewinds the simulation
  // ==========================================================================
  console.log('\n🕰️  [Test 4] Backwards Clock Safety');
  const { world } = makeWorld();
  const loop = new GameLoop(world, () => {}, 50);
  loop.isRunning = true;
  loop.lastTickTime = Date.now() + 5000; // clock jumped backwards by 5s
  const before = world.players.get('p1').x;
  loop.tick();
  const after = world.players.get('p1').x;
  assert(after >= before, `Player never moves backwards on a negative delta (${before} -> ${after})`);
  assert(
    after - before <= 8,
    `A negative delta falls back to one nominal tick (${(after - before).toFixed(2)}px)`
  );

  console.log(`\n📊 GameLoop Tests Summary: ${passed} Passed, ${failed} Failed\n`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 All GameLoop Tests Passed Successfully!');
    process.exit(0);
  }
}

runGameLoopTests().catch((err) => {
  console.error('💥 GameLoop test error:', err);
  process.exit(1);
});
