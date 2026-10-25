import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMigrationHandler } from '../src/lambda/migrate.js';

test('Deployment migration initializes an empty database schema and can safely run again', async t => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const config = { storageMode: 'rds', seedDefaultHost: false, dbPoolMax: 1,
    db: { connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` } };
  const handler = createMigrationHandler(async () => config);
  assert.deepEqual(await handler(), { success: true });
  assert.deepEqual(await handler(), { success: true });
  const result = await admin.query(`SELECT world_id,status FROM ${schema}.worlds`);
  assert.deepEqual(result.rows, [{ world_id: 'world-01', status: 'INACTIVE' }]);
  assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ${schema}.schema_migrations`)).rows[0].count, 7);
});
