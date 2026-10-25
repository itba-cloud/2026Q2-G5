import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { RdsWorldRepository } from '../../src/store/RdsWorldRepository.js';
import { RdsOperationRepository } from '../../src/store/RdsOperationRepository.js';

export async function databaseFixture(overrides = {}) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; serverless integration tests must not silently skip');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config = {
    storageMode: 'rds', seedDefaultHost: false, dbPoolMax: 6,
    db: { connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` },
    worldPortRange: { min: 18001, max: 18004 },
    startWorkflowArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:test-start:1',
    stopWorkflowArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:test-stop:1',
    ...overrides,
  };
  const worlds = new RdsWorldRepository(config);
  await worlds.init();
  const operations = new RdsOperationRepository(worlds, config);
  return { config, worlds, operations, async close() {
    await worlds.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  } };
}
