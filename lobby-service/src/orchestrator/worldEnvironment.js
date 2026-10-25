/**
 * Environment every world runtime receives, whichever launcher starts it.
 * @param {object} worldConfig World id, name, seed, token and runtimeId
 * @param {{ port: number, lobbyUrl: string, redisUrl: string }} endpoints As seen from the world
 * @returns {Array<[string, string]>} Ordered name/value pairs
 */
export function worldEnvironment(worldConfig, { port, lobbyUrl, redisUrl }) {
  const storageMode = (process.env.WORLD_STORAGE_MODE || 's3').toLowerCase();
  const env = [
    ['WORLD_ID', worldConfig.id],
    ['WORLD_RUNTIME_ID', worldConfig.runtimeId || worldConfig.token || ''],
    ['WORLD_NAME', worldConfig.name],
    ['SEED', worldConfig.seed],
    ['PORT', port],
    ['STORAGE_MODE', storageMode],
    ['LOBBY_API_URL', lobbyUrl],
    ['REDIS_URL', redisUrl],
    ['GLOBAL_CHANNEL', process.env.GLOBAL_CHANNEL || 'world-events'],
  ];

  if (storageMode === 's3') {
    env.push(['S3_BUCKET_NAME', process.env.S3_BUCKET_NAME || 'elastic-worlds-snapshots'],
      ['S3_PREFIX', process.env.S3_PREFIX || 'worlds']);
  }

  // The world reports its own telemetry to the Kinesis pipeline; the metrics
  // service no longer scrapes it (see .docs/telemetry-pipeline.md).
  const telemetryMode = (process.env.WORLD_TELEMETRY_MODE || 'none').toLowerCase();
  env.push(['TELEMETRY_MODE', telemetryMode]);
  if (telemetryMode === 'kinesis') env.push(['TELEMETRY_STREAM_NAME', process.env.TELEMETRY_STREAM_NAME || '']);

  if (storageMode === 's3' || telemetryMode === 'kinesis') {
    env.push(['AWS_REGION', process.env.AWS_REGION || 'us-east-1']);
  }
  return env.map(([name, value]) => [name, String(value)]);
}
