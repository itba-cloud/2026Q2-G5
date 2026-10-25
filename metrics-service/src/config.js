import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env reliably regardless of execution working directory
try {
  const dotenv = await import('dotenv');
  if (dotenv && dotenv.default && typeof dotenv.default.config === 'function') {
    // 1. Root .env
    const rootEnv = path.resolve(__dirname, '../../.env');
    if (fs.existsSync(rootEnv)) {
      dotenv.default.config({ path: rootEnv });
    }
    // 2. Module specific metrics-service/.env (overrides root)
    const moduleEnv = path.resolve(__dirname, '../.env');
    if (fs.existsSync(moduleEnv)) {
      dotenv.default.config({ path: moduleEnv, override: true });
    }
    // 3. Fallback to cwd
    dotenv.default.config();
  }
} catch {
  // Runs seamlessly if dotenv is not installed
}

export const config = Object.freeze({
  port: parseInt(process.env.METRICS_PORT || '3100', 10),
  host: process.env.METRICS_HOST || '0.0.0.0',

  // Lobby Service REST API: source of the world and host registry
  lobbyUrl: process.env.LOBBY_URL || 'http://127.0.0.1:3000',
  lobbyTimeoutMs: parseInt(process.env.LOBBY_TIMEOUT_MS || '2000', 10),

  // NPC Bot Service Endpoint
  npcServiceUrl: process.env.NPC_SERVICE_URL || 'http://127.0.0.1:5001',

  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),

  // Authentication for dashboard and metrics API
  auth: {
    enabled: process.env.METRICS_AUTH_ENABLED !== 'false',
    user: process.env.METRICS_USER || 'admin',
    password: process.env.METRICS_PASS || 'cloud2026',
    realm: process.env.METRICS_REALM || 'Elastic Worlds Metrics',
  },


  // Where telemetry comes from (see .docs/telemetry-pipeline.md):
  // 'pull'     this process scrapes worlds and the NPC (local development)
  // 'dynamodb' the Flink pipeline writes DynamoDB; this process only reads (AWS)
  telemetry: {
    mode: (process.env.TELEMETRY_MODE || 'pull').toLowerCase(),
    tableName: process.env.TELEMETRY_TABLE_NAME || '',
    region: process.env.AWS_REGION || 'us-east-1',
    staleAfterSeconds: parseInt(process.env.METRICS_STALE_AFTER_SECONDS || '15', 10),
    fleetWindowSeconds: parseInt(process.env.METRICS_FLEET_WINDOW_SECONDS || '10', 10),
  },

  // Collector cadence and retention (pull mode; intervalMs also labels the producer
  // cadence in dynamodb mode)
  metrics: {
    intervalMs: parseInt(process.env.METRICS_INTERVAL_MS || '5000', 10),
    historyPoints: parseInt(process.env.METRICS_HISTORY_POINTS || '180', 10),
    scrapeTimeoutMs: parseInt(process.env.METRICS_SCRAPE_TIMEOUT_MS || '1500', 10),
  },

  // Cost model used to attribute infrastructure spend to individual worlds
  pricing: {
    defaultInstanceType: process.env.PRICING_INSTANCE_TYPE || 't3.medium',
    ebsGbPerHost: parseInt(process.env.PRICING_EBS_GB || '30', 10),
    ebsGbMonthUsd: parseFloat(process.env.PRICING_EBS_GB_MONTH_USD || '0.08'),
    oversizedThreshold: parseFloat(process.env.PRICING_OVERSIZED_THRESHOLD || '0.25'),
    undersizedThreshold: parseFloat(process.env.PRICING_UNDERSIZED_THRESHOLD || '0.85'),
    targetUtilization: parseFloat(process.env.PRICING_TARGET_UTILIZATION || '0.6'),
    maxSlotGrowthFactor: parseFloat(process.env.PRICING_MAX_SLOT_GROWTH || '4'),
  },
});

/**
 * Resolves the Basic Auth password at startup. Fargate has no user-data to inject
 * METRICS_PASS, so when METRICS_PASS_SECRET_ID is set the Secrets Manager value
 * overrides it. Throws when the read fails so the service never starts with the
 * default password. Errors name the secret, never its value.
 */
export async function resolveAuthPassword(fallback = config.auth.password, client = null) {
  const secretId = process.env.METRICS_PASS_SECRET_ID;
  if (!secretId) return fallback;
  const secrets = client || new SecretsManagerClient({ maxAttempts: 2 });
  try {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }), {
      abortSignal: AbortSignal.timeout(3000),
    });
    const password = (response.SecretString || '').trim();
    if (!password) throw new Error('the secret is empty');
    return password;
  } catch (err) {
    throw new Error(`Could not read METRICS_PASS from secret ${secretId}: ${err.message}`);
  } finally {
    if (!client) secrets.destroy();
  }
}
