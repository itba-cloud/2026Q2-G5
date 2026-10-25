import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env without overriding already injected environment variables (like Docker -e PORT=8002)
try {
  const dotenv = await import('dotenv');
  if (dotenv && dotenv.default && typeof dotenv.default.config === 'function') {
    // 1. Root .env
    const rootEnv = path.resolve(__dirname, '../../.env');
    if (fs.existsSync(rootEnv)) {
      dotenv.default.config({ path: rootEnv });
    }
    // 2. Module specific world-service/.env
    const moduleEnv = path.resolve(__dirname, '../.env');
    if (fs.existsSync(moduleEnv)) {
      dotenv.default.config({ path: moduleEnv });
    }
    // 3. Fallback to cwd
    dotenv.default.config();
  }
} catch {
  // Runs seamlessly if dotenv is not installed
}

/**
 * Reads an integer env var where 0 is a meaningful value.
 *
 * `parseInt(x, 10) || fallback` silently swaps 0 for the fallback, which would
 * make "0 = disabled" unreachable for the timers below.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function intOrDefault(raw, fallback) {
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const config = Object.freeze({
  worldId: process.env.WORLD_ID || 'world-01',
  worldName: process.env.WORLD_NAME || 'Bosque Inicial',
  port: parseInt(process.env.PORT, 10) || 8001,
  seed: intOrDefault(process.env.SEED, 48291), // 0 is a valid seed

  worldWidth: parseInt(process.env.WORLD_WIDTH, 10) || 1000,
  worldHeight: parseInt(process.env.WORLD_HEIGHT, 10) || 1000,

  // Tick rate: 20 Hz = 50ms per tick
  tickRateHz: 20,
  tickIntervalMs: 50,

  // Player physics
  playerSpeed: 150, // units per second
  playerRadius: 16, // collision/bounding radius

  // Persistence
  storageMode: (process.env.STORAGE_MODE || 'local').toLowerCase(),
  dataDir: process.env.DATA_DIR || './.data',
  s3BucketName: process.env.S3_BUCKET_NAME || '',
  s3Region: process.env.AWS_REGION || 'us-east-1',
  s3Prefix: process.env.S3_PREFIX || 'worlds',
  // Both accept 0 to turn the behaviour off (see _startPeriodicSave and
  // _handlePlayerCountChange), so they must not go through `|| fallback`.
  saveIntervalSeconds: intOrDefault(process.env.SAVE_INTERVAL_SECONDS, 30),
  idleTimeoutSeconds: intOrDefault(process.env.IDLE_TIMEOUT, 60),

  // RDS / Database settings (future)
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: parseInt(process.env.DB_PORT, 10) || 5432,
  dbName: process.env.DB_NAME || 'cloudgame',
  dbUser: process.env.DB_USER || 'dbadmin',
  dbPassword: process.env.DB_PASSWORD || '',

  // AI Service settings (future)
  aiServiceHost: process.env.AI_SERVICE_HOST || '127.0.0.1',
  aiServicePort: parseInt(process.env.AI_SERVICE_PORT, 10) || 5000,

  // Cross-world messaging (Redis Pub/Sub).
  // Unset falls back to a local Redis so `docker run redis` is all local dev needs;
  // set-but-empty means "no bus here" — that is what the Lobby passes to a world
  // container when it has no Redis of its own, and it must not be read as the default.
  redisUrl: process.env.REDIS_URL === undefined ? 'redis://127.0.0.1:6379' : process.env.REDIS_URL,
  globalChannel: process.env.GLOBAL_CHANNEL || 'world-events',
  chatMaxLength: parseInt(process.env.CHAT_MAX_LENGTH, 10) || 120,
  chatCooldownMs: parseInt(process.env.CHAT_COOLDOWN_MS, 10) || 1000,

  // Lobby Service API
  runtimeId: process.env.WORLD_RUNTIME_ID || null,
  lobbyApiUrl: process.env.LOBBY_API_URL || 'http://127.0.0.1:3000',

  // Telemetry push to the Kinesis pipeline (see .docs/telemetry-pipeline.md).
  // 'none' keeps the world silent; GET /metrics stays available for local scraping.
  telemetryMode: (process.env.TELEMETRY_MODE || 'none').toLowerCase(),
  telemetryStreamName: process.env.TELEMETRY_STREAM_NAME || '',
  telemetryIntervalMs: parseInt(process.env.TELEMETRY_INTERVAL_MS, 10) || 5000,
  // Session id for the billing ledger. Unset means the hostname, which Docker sets
  // to the container id.
  containerId: process.env.CONTAINER_ID || '',
});
