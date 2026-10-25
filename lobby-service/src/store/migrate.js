import fs from 'fs/promises';
import path from 'path';

const MIGRATION_LOCK_ID = 982451653;

/**
 * Aplica migraciones SQL pendientes en orden lexicografico.
 * Cada archivo se ejecuta y registra dentro de la misma transaccion.
 *
 * @param {import('pg').Pool} pool
 * @param {string} migrationsDir
 * @returns {Promise<string[]>} Nombres de las migraciones aplicadas
 */
export async function runMigrations(pool, migrationsDir) {
  const client = await pool.connect();
  let lockHeld = false;

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
    lockHeld = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(appliedResult.rows.map((row) => row.filename));
    console.log(`[Migrations] Currently applied: [${Array.from(applied).join(', ')}]`);

    const migrationFiles = (await fs.readdir(migrationsDir))
      .filter((filename) => filename.endsWith('.sql'))
      .sort();
    const completed = [];

    for (const filename of migrationFiles) {
      if (applied.has(filename)) continue;

      console.log(`[Migrations] Applying pending migration: "${filename}"...`);
      const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        completed.push(filename);
        console.log(`[Migrations] Successfully applied migration: "${filename}".`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[Migrations] Failed to apply migration "${filename}":`, err.message);
        throw err;
      }
    }

    if (completed.length === 0) {
      console.log('[Migrations] Schema is up to date (no pending migrations).');
    }

    return completed;
  } finally {
    if (lockHeld) {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
    }
    client.release();
  }
}
