/**
 * Closed-loop smoothness test for the client-side prediction engine.
 *
 * Drives a real PredictionEngine against the real authoritative CollisionSystem across a
 * simulated laggy link (60 FPS client, 20 Hz server, configurable RTT).
 *
 * Measuring raw frame steps would conflate reconciliation artifacts with legitimate physics
 * (stopping at a wall is a real velocity discontinuity, not a bug). So the session also runs
 * a second, never-reconciled engine on the exact same inputs and world: the "ghost" is the
 * perfect zero-latency local simulation. The difference between the rendered avatar and the
 * ghost is, by construction, exactly what reconciliation injected.
 *
 *   correction step = |deviation[i] - deviation[i-1]|
 *
 * That is the "tiron": how far the server correction yanks the avatar in a single frame,
 * on top of whatever the player asked for. A correct predictor keeps it under a small
 * fraction of the walking budget; a broken one teleports.
 *
 * Usage: node client/tests/prediction-smoothness-test.js [pathToPredictionModule]
 */
import { CollisionSystem } from '../../world-service/src/engine/CollisionSystem.js';

const MODULE_PATH = process.argv[2] || '../js/prediction.js';

const PLAYER_SPEED = 150;
const PLAYER_RADIUS = 16;
const FRAME_MS = 1000 / 60;
const SERVER_TICK_MS = 50;

/** Movement a player legitimately covers in one frame. */
const FRAME_BUDGET = (PLAYER_SPEED * FRAME_MS) / 1000;
/** Reconciliation may add at most this fraction of the walking budget per frame. */
const CORRECTION_ALLOWANCE = 0.45;

// Virtual clock shared by the harness and by the engine under test.
let virtualNow = 0;
const realDateNow = Date.now;
Date.now = () => virtualNow;
globalThis.performance = { now: () => virtualNow };

const { PredictionEngine } = await import(MODULE_PATH);

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

/** Builds the shared world; client and server see exactly the same obstacles. */
function buildWorld() {
  const structures = new Map();
  structures.set('wall_1', {
    id: 'wall_1',
    type: 'wall',
    x: 400,
    y: 300,
    radius: 18,
    blocksMovement: true,
    blocksProjectiles: true,
  });

  const resources = new Map();
  resources.set('tree_1', {
    id: 'tree_1',
    type: 'tree',
    x: 520,
    y: 300,
    radius: 18,
    colliderRadius: 12,
    blocksMovement: true,
    hp: 3,
  });

  return { worldWidth: 1000, worldHeight: 1000, structures, resources };
}

function makeEngine(world) {
  const engine = new PredictionEngine({
    worldWidth: world.worldWidth,
    worldHeight: world.worldHeight,
    playerSpeed: PLAYER_SPEED,
    playerRadius: PLAYER_RADIUS,
  });
  engine.init({
    worldWidth: world.worldWidth,
    worldHeight: world.worldHeight,
    playerId: 'p1',
    player: { x: 200, y: 300, speed: PLAYER_SPEED, radius: PLAYER_RADIUS },
  });
  return engine;
}

/**
 * Runs one closed-loop session.
 * @param {object} opts
 * @param {number} opts.rttMs Simulated round trip time
 * @param {number} opts.durationMs Wall clock length of the session
 * @param {Array<{ at: number, x: number, y: number }>} opts.inputScript Direction changes
 * @returns {object} Metrics
 */
function runSession({ rttMs, durationMs, inputScript }) {
  virtualNow = 0;

  const world = buildWorld();
  const collisionSystem = new CollisionSystem();
  collisionSystem.syncWorld(world);

  const engine = makeEngine(world);
  // Reference: identical engine, same inputs, never told about the server.
  const ghost = makeEngine(world);

  const serverPlayer = { id: 'p1', x: 200, y: 300, dirX: 0, dirY: 0, isDead: false };

  const upLink = []; // client -> server MOVE packets
  const downLink = []; // server -> client STATE_SYNC snapshots
  const oneWay = rttMs / 2;

  let nextFrameAt = 0;
  let nextTickAt = SERVER_TICK_MS;
  let scriptIndex = 0;

  let prevDeviationX = null;
  let prevDeviationY = null;
  let maxCorrectionStep = 0;
  let overBudgetFrames = 0;
  let maxFrameStep = 0;
  let prevRenderX = null;
  let prevRenderY = null;
  let maxServerError = 0;
  let frames = 0;

  const correctionBudget = FRAME_BUDGET * CORRECTION_ALLOWANCE;

  while (virtualNow <= durationMs) {
    const isFrame = nextFrameAt <= nextTickAt;
    virtualNow = isFrame ? nextFrameAt : nextTickAt;

    if (isFrame) {
      nextFrameAt += FRAME_MS;

      // 1. Deliver snapshots that finished their downstream trip
      while (downLink.length > 0 && downLink[0].arriveAt <= virtualNow) {
        engine.reconcile(downLink.shift().player, [], rttMs);
      }

      // 2. Apply scripted input changes to both engines
      while (scriptIndex < inputScript.length && inputScript[scriptIndex].at <= virtualNow) {
        const input = inputScript[scriptIndex];
        scriptIndex++;
        engine.setMovement({ x: input.x, y: input.y });
        ghost.setMovement({ x: input.x, y: input.y });
        upLink.push({ arriveAt: virtualNow + oneWay, x: engine.dirX, y: engine.dirY });
      }

      // 3. Advance both local simulations
      engine.update(FRAME_MS / 1000, world.structures, world.resources);
      ghost.update(FRAME_MS / 1000, world.structures, world.resources);

      // 4. Measure
      const render = engine.getRenderPosition();
      const ideal = ghost.getRenderPosition();
      const deviationX = render.x - ideal.x;
      const deviationY = render.y - ideal.y;

      if (prevDeviationX !== null) {
        const correctionStep = Math.hypot(deviationX - prevDeviationX, deviationY - prevDeviationY);
        if (correctionStep > maxCorrectionStep) maxCorrectionStep = correctionStep;
        if (correctionStep > correctionBudget) overBudgetFrames++;

        const step = Math.hypot(render.x - prevRenderX, render.y - prevRenderY);
        if (step > maxFrameStep) maxFrameStep = step;
        frames++;
      }
      prevDeviationX = deviationX;
      prevDeviationY = deviationY;
      prevRenderX = render.x;
      prevRenderY = render.y;

      const drift = Math.hypot(render.x - serverPlayer.x, render.y - serverPlayer.y);
      if (drift > maxServerError) maxServerError = drift;
    } else {
      nextTickAt += SERVER_TICK_MS;

      // Server: consume arrived inputs, then integrate authoritatively
      while (upLink.length > 0 && upLink[0].arriveAt <= virtualNow) {
        const packet = upLink.shift();
        serverPlayer.dirX = packet.x;
        serverPlayer.dirY = packet.y;
      }

      const resolved = collisionSystem.resolveMovement(
        serverPlayer.x,
        serverPlayer.y,
        serverPlayer.dirX,
        serverPlayer.dirY,
        PLAYER_SPEED,
        SERVER_TICK_MS / 1000,
        PLAYER_RADIUS,
        world,
        serverPlayer.id
      );
      serverPlayer.x = resolved.x;
      serverPlayer.y = resolved.y;

      // Snapshot quantisation matches World.getSyncState()
      downLink.push({
        arriveAt: virtualNow + oneWay,
        player: {
          id: serverPlayer.id,
          x: Math.round(serverPlayer.x * 100) / 100,
          y: Math.round(serverPlayer.y * 100) / 100,
          dirX: Math.round(serverPlayer.dirX * 100) / 100,
          dirY: Math.round(serverPlayer.dirY * 100) / 100,
          isDead: false,
        },
      });
    }
  }

  const render = engine.getRenderPosition();
  return {
    frames,
    maxCorrectionStep,
    overBudgetFrames,
    maxFrameStep,
    maxServerError,
    finalGap: Math.hypot(render.x - serverPlayer.x, render.y - serverPlayer.y),
    correctionBudget,
  };
}

// Exercises everything that used to break: straight running, diagonal changes,
// reversals, stopping dead, and grinding along a solid obstacle.
const INPUT_SCRIPT = [
  { at: 100, x: 1, y: 0 },
  { at: 900, x: 1, y: 1 },
  { at: 1500, x: 0, y: 1 },
  { at: 2100, x: -1, y: 0 },
  { at: 2700, x: 0, y: 0 }, // full stop
  { at: 3300, x: 1, y: 0 }, // run straight into the wall at x=400
  { at: 5000, x: 1, y: -1 }, // slide along it
  { at: 5800, x: 0, y: 0 },
];

console.log(`🧪 Prediction smoothness under latency (module: ${MODULE_PATH})\n`);

for (const rttMs of [0, 150, 300]) {
  const m = runSession({ rttMs, durationMs: 6500, inputScript: INPUT_SCRIPT });
  console.log(`🌐 RTT ${rttMs}ms  (${m.frames} frames)`);
  console.log(
    `   worst correction ${m.maxCorrectionStep.toFixed(2)}px/frame ` +
      `(budget ${m.correctionBudget.toFixed(2)}) | over budget ${m.overBudgetFrames} frames | ` +
      `max frame step ${m.maxFrameStep.toFixed(2)}px | max drift ${m.maxServerError.toFixed(2)}px | ` +
      `final gap ${m.finalGap.toFixed(2)}px`
  );

  assert(
    m.maxCorrectionStep <= m.correctionBudget,
    `RTT ${rttMs}ms: reconciliation never yanks the avatar more than ` +
      `${m.correctionBudget.toFixed(2)}px in a frame (worst ${m.maxCorrectionStep.toFixed(2)}px)`
  );
  assert(
    m.overBudgetFrames === 0,
    `RTT ${rttMs}ms: no frame exceeds the correction budget (${m.overBudgetFrames} frames)`
  );
  assert(
    m.maxFrameStep <= FRAME_BUDGET * (1 + CORRECTION_ALLOWANCE) + 0.01,
    `RTT ${rttMs}ms: rendered speed stays near walking speed (${m.maxFrameStep.toFixed(2)}px/frame)`
  );
  // The client legitimately runs ahead of the server by roughly one round trip.
  const allowedDrift = (PLAYER_SPEED * rttMs) / 1000 + 25;
  assert(
    m.maxServerError <= allowedDrift,
    `RTT ${rttMs}ms: prediction stays within one round trip of authority ` +
      `(${m.maxServerError.toFixed(2)}px <= ${allowedDrift.toFixed(2)}px)`
  );
  assert(
    m.finalGap < 3,
    `RTT ${rttMs}ms: converges onto the server once idle (${m.finalGap.toFixed(2)}px)`
  );
  console.log('');
}

Date.now = realDateNow;

console.log('=============================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('=============================================\n');

if (failed > 0) {
  process.exit(1);
}
