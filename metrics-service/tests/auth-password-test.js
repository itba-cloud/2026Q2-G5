import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAuthPassword } from '../src/config.js';

const SECRET_ID = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:ewo-metrics-password';

function fakeSecrets(result) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command.input.SecretId);
      if (result instanceof Error) throw result;
      return { SecretString: result };
    },
  };
}

test('without a secret the configured password is kept', async () => {
  delete process.env.METRICS_PASS_SECRET_ID;
  assert.equal(await resolveAuthPassword('local-pass', fakeSecrets('unused')), 'local-pass');
});

test('the secret value replaces the configured password', async (t) => {
  process.env.METRICS_PASS_SECRET_ID = SECRET_ID;
  t.after(() => delete process.env.METRICS_PASS_SECRET_ID);
  const client = fakeSecrets('generated-password\n');
  assert.equal(await resolveAuthPassword('cloud2026', client), 'generated-password');
  assert.deepEqual(client.calls, [SECRET_ID]);
});

test('a failed or empty read stops startup without exposing a value', async (t) => {
  process.env.METRICS_PASS_SECRET_ID = SECRET_ID;
  t.after(() => delete process.env.METRICS_PASS_SECRET_ID);
  const denied = new Error('User is not authorized to perform secretsmanager:GetSecretValue');
  await assert.rejects(resolveAuthPassword('cloud2026', fakeSecrets(denied)), /from secret arn:.*ewo-metrics-password: User is not authorized/);
  await assert.rejects(resolveAuthPassword('cloud2026', fakeSecrets('  ')), /the secret is empty/);
});
