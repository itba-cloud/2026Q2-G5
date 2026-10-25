import assert from 'node:assert/strict';
import test from 'node:test';
import { createSecretPassword } from '../src/shared/runtime/secretPassword.js';
import { RdsWorldRepository } from '../src/store/RdsWorldRepository.js';

const SECRET_ID = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-test';

function fakeSecrets(values) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command.input.SecretId);
      const next = values.shift();
      if (next instanceof Error) throw next;
      return { SecretString: JSON.stringify(next) };
    },
  };
}

test('reads the password from the RDS secret and caches it', async () => {
  const client = fakeSecrets([{ username: 'dbadmin', password: 'first' }]);
  const password = createSecretPassword({ secretId: SECRET_ID, client });
  assert.equal(await password(), 'first');
  assert.equal(await password(), 'first');
  assert.deepEqual(client.calls, [SECRET_ID]);
});

test('concurrent connections share one request', async () => {
  const client = fakeSecrets([{ password: 'first' }]);
  const password = createSecretPassword({ secretId: SECRET_ID, client });
  assert.deepEqual(await Promise.all([password(), password(), password()]), ['first', 'first', 'first']);
  assert.equal(client.calls.length, 1);
});

test('invalidate and expiry fetch the current value again', async () => {
  let clock = 0;
  const client = fakeSecrets([{ password: 'first' }, { password: 'rotated' }, { password: 'expired' }]);
  const password = createSecretPassword({ secretId: SECRET_ID, client, ttlMs: 1000, now: () => clock });
  assert.equal(await password(), 'first');
  password.invalidate();
  assert.equal(await password(), 'rotated');
  clock = 1000;
  assert.equal(await password(), 'expired');
});

test('errors name the secret but never leak a value', async () => {
  const denied = Object.assign(new Error('User is not authorized to perform secretsmanager:GetSecretValue'), { name: 'AccessDeniedException' });
  const password = createSecretPassword({ secretId: SECRET_ID, client: fakeSecrets([denied]) });
  await assert.rejects(password(), (err) => {
    assert.match(err.message, /secret arn:aws:secretsmanager:.*rds!db-test: AccessDeniedException/);
    return true;
  });

  const empty = createSecretPassword({ secretId: SECRET_ID, client: fakeSecrets([{ username: 'dbadmin', password: '' }]) });
  await assert.rejects(empty(), /the secret has no password field/);
});

test('a failed read is retried on the next connection', async () => {
  const client = fakeSecrets([new Error('timeout'), { password: 'first' }]);
  const password = createSecretPassword({ secretId: SECRET_ID, client });
  await assert.rejects(password());
  assert.equal(await password(), 'first');
});

test('the repository retries once with a fresh password after a rotation', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' }, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  const current = decodeURIComponent(url.password);
  // The first value is the password before the rotation; PostgreSQL rejects it.
  const client = fakeSecrets([{ password: `${current}-before-rotation` }, { password: current }]);
  const password = createSecretPassword({ secretId: SECRET_ID, client });
  const repository = new RdsWorldRepository({
    db: {
      host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
      user: decodeURIComponent(url.username), password,
    },
    dbPoolMax: 1,
  });
  try {
    const result = await repository.pool.query('SELECT 1 AS ok');
    assert.equal(result.rows[0].ok, 1);
    assert.equal(client.calls.length, 2);

    const connection = await repository.pool.connect();
    connection.release();
    assert.equal(client.calls.length, 2, 'the fresh value stays cached');
  } finally {
    await repository.pool.end();
  }
});
