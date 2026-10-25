import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Database password read from the Secrets Manager secret RDS manages.
 *
 * Returns an async function: pg calls it for every new connection, so after a
 * rotation the next connection uses the current value without a restart. The
 * value is cached for ttlMs; invalidate() drops it when PostgreSQL rejects it.
 * Errors name the secret, never its value.
 */
export function createSecretPassword({ secretId, client = null, ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
  let cached = null;
  let expiresAt = 0;
  let pending = null;

  async function fetchPassword() {
    const secrets = client || new SecretsManagerClient({ maxAttempts: 2 });
    try {
      const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }), {
        abortSignal: AbortSignal.timeout(3000),
      });
      const password = JSON.parse(response.SecretString || '{}').password;
      if (typeof password !== 'string' || password === '') {
        throw new Error('the secret has no password field');
      }
      return password;
    } catch (err) {
      throw new Error(`Could not read the database password from secret ${secretId}: ${err.name || 'Error'}: ${err.message}`);
    } finally {
      if (!client) secrets.destroy();
    }
  }

  async function password() {
    if (cached !== null && now() < expiresAt) return cached;
    // Concurrent connections share one request instead of each calling Secrets Manager.
    pending ??= fetchPassword().then((value) => {
      cached = value;
      expiresAt = now() + ttlMs;
      return value;
    }).finally(() => { pending = null; });
    return pending;
  }

  password.invalidate = () => {
    cached = null;
    expiresAt = 0;
  };

  return password;
}
