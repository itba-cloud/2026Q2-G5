import { config as defaults } from '../config.js';
import { createSecretPassword } from './secretPassword.js';

/** Runtime initialization never changes schema or starts HTTP/timers. */
export async function loadRuntimeConfig(overrides = {}) {
  const config = { ...defaults, dbPoolMax: Number(process.env.DB_POOL_MAX || 1), ...overrides };
  if (config.storageMode !== 'rds') throw new Error('Lambda/worker require STORAGE_MODE=rds');
  if (process.env.DB_SECRET_ARN) {
    const password = createSecretPassword({ secretId: process.env.DB_SECRET_ARN });
    // Fail at startup, not at the first query, when the secret is unreachable.
    await password();
    config.db = { ...config.db, password };
  }
  return config;
}
