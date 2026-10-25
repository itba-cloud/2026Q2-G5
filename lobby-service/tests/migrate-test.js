import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../src/store/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  console.log('SKIP migrate-test: definir TEST_DATABASE_URL para ejecutar pruebas PostgreSQL.');
  process.exit(0);
}

const run = async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const migrationsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ewo-migrations-'));
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdTables = [
    `migration_${suffix}_one`,
    `migration_${suffix}_two`,
    `migration_${suffix}_ten`,
    `migration_${suffix}_eleven`,
    `migration_${suffix}_invalid`,
  ];
  const files = [
    `001_${suffix}_one.sql`,
    `002_${suffix}_two.sql`,
    `010_${suffix}_ten.sql`,
  ];

  try {
    await fs.writeFile(path.join(migrationsDir, files[2]), `CREATE TABLE ${createdTables[2]} (id INTEGER);`);
    await fs.writeFile(path.join(migrationsDir, files[1]), `CREATE TABLE ${createdTables[1]} (id INTEGER);`);
    await fs.writeFile(path.join(migrationsDir, files[0]), `CREATE TABLE ${createdTables[0]} (id INTEGER);`);

    const firstRun = await runMigrations(pool, migrationsDir);
    assert.deepEqual(firstRun, files);

    const firstCount = await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM schema_migrations WHERE filename = ANY($1)',
      [files]
    );
    assert.equal(firstCount.rows[0].count, 3);

    const secondRun = await runMigrations(pool, migrationsDir);
    assert.deepEqual(secondRun, []);

    const thirdFile = `011_${suffix}_eleven.sql`;
    await fs.writeFile(path.join(migrationsDir, thirdFile), `CREATE TABLE ${createdTables[3]} (id INTEGER);`);
    assert.deepEqual(await runMigrations(pool, migrationsDir), [thirdFile]);

    const invalidFile = `012_${suffix}_invalid.sql`;
    await fs.writeFile(
      path.join(migrationsDir, invalidFile),
      `CREATE TABLE ${createdTables[4]} (id INTEGER);\nTHIS IS NOT VALID SQL;`
    );
    await assert.rejects(() => runMigrations(pool, migrationsDir));

    const invalidTable = await pool.query('SELECT to_regclass($1) AS table_name', [createdTables[4]]);
    assert.equal(invalidTable.rows[0].table_name, null);

    const invalidRecord = await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM schema_migrations WHERE filename = $1',
      [invalidFile]
    );
    assert.equal(invalidRecord.rows[0].count, 0);

    console.log('PASS migrate-test: orden, idempotencia y rollback verificados.');
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${createdTables.join(', ')}`);
    await pool.query('DELETE FROM schema_migrations WHERE filename LIKE $1', [`%_${suffix}_%.sql`]);
    await pool.end();
    await fs.rm(migrationsDir, { recursive: true, force: true });
  }
};

run().catch((err) => {
  console.error('FAIL migrate-test:', err);
  process.exit(1);
});
