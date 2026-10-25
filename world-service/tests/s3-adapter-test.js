import assert from 'assert';
import { GetObjectCommand, PutObjectCommand, RestoreObjectCommand } from '@aws-sdk/client-s3';
import { S3Adapter } from '../src/storage/adapters/S3Adapter.js';
import { PersistenceManager } from '../src/storage/PersistenceManager.js';

class FakeS3Client {
  constructor(sendHandler) {
    this.sendHandler = sendHandler;
    this.commands = [];
    this.destroyed = false;
  }

  async send(command) {
    this.commands.push(command);
    return this.sendHandler(command);
  }

  destroy() {
    this.destroyed = true;
  }
}

async function run() {
  console.log('\n[S3Adapter] Running unit tests...\n');

  const snapshot = {
    version: 1,
    players_data: { p1: { name: 'Alice' } },
    harvested_resources: ['tree-1'],
  };

  const loadClient = new FakeS3Client(async () => ({
    Body: { transformToString: async () => JSON.stringify(snapshot) },
  }));
  const adapter = new S3Adapter({
    bucketName: 'test-snapshots',
    region: 'us-east-1',
    prefix: '/worlds/',
    client: loadClient,
  });

  const loaded = await adapter.loadWorldState('world-01');
  assert.deepStrictEqual(loaded, snapshot, 'loads and parses a stored snapshot');
  assert(loadClient.commands[0] instanceof GetObjectCommand, 'loads through GetObjectCommand');
  assert.deepStrictEqual(loadClient.commands[0].input, {
    Bucket: 'test-snapshots',
    Key: 'worlds/world-01/snapshot.json',
  }, 'loads the documented world snapshot key');

  const writeClient = new FakeS3Client(async () => ({}));
  const writeAdapter = new S3Adapter({
    bucketName: 'test-snapshots',
    region: 'us-east-1',
    client: writeClient,
  });
  assert.strictEqual(await writeAdapter.saveWorldState('world-02', snapshot), true, 'reports successful writes');
  assert(writeClient.commands[0] instanceof PutObjectCommand, 'writes through PutObjectCommand');
  assert.deepStrictEqual(writeClient.commands[0].input, {
    Bucket: 'test-snapshots',
    Key: 'worlds/world-02/snapshot.json',
    Body: JSON.stringify(snapshot),
    ContentType: 'application/json',
  }, 'writes JSON to the documented world snapshot key');

  const missingClient = new FakeS3Client(async () => {
    const err = new Error('not found');
    err.name = 'NoSuchKey';
    throw err;
  });
  const missingAdapter = new S3Adapter({ bucketName: 'test-snapshots', client: missingClient });
  assert.strictEqual(await missingAdapter.loadWorldState('new-world'), null, 'treats only a missing object as a fresh world');

  const deniedClient = new FakeS3Client(async () => {
    const err = new Error('access denied');
    err.name = 'AccessDenied';
    err.$metadata = { httpStatusCode: 403 };
    throw err;
  });
  const deniedAdapter = new S3Adapter({ bucketName: 'test-snapshots', client: deniedClient });
  await assert.rejects(
    () => deniedAdapter.loadWorldState('world-01'),
    /Failed to load snapshot/,
    'does not silently replace an inaccessible snapshot with a fresh world'
  );

  const archivedError = () => {
    const err = new Error('The operation is not valid for the object\'s storage class');
    err.name = 'InvalidObjectState';
    err.$metadata = { httpStatusCode: 403 };
    return err;
  };
  const archivedClient = new FakeS3Client(async (command) => {
    if (command instanceof GetObjectCommand) throw archivedError();
    return {};
  });
  const archivedAdapter = new S3Adapter({ bucketName: 'test-snapshots', client: archivedClient });
  await assert.rejects(
    () => archivedAdapter.loadWorldState('old-world'),
    /archived in S3 Glacier/,
    'reports an archived snapshot instead of starting a fresh world'
  );
  assert(archivedClient.commands[1] instanceof RestoreObjectCommand, 'requests a restore for an archived snapshot');
  assert.deepStrictEqual(archivedClient.commands[1].input, {
    Bucket: 'test-snapshots',
    Key: 'worlds/old-world/snapshot.json',
    RestoreRequest: { Days: 7, GlacierJobParameters: { Tier: 'Standard' } },
  }, 'restores the archived world snapshot key');

  const restoringClient = new FakeS3Client(async (command) => {
    if (command instanceof GetObjectCommand) throw archivedError();
    const err = new Error('restore in progress');
    err.name = 'RestoreAlreadyInProgress';
    throw err;
  });
  const restoringAdapter = new S3Adapter({ bucketName: 'test-snapshots', client: restoringClient });
  await assert.rejects(
    () => restoringAdapter.loadWorldState('old-world'),
    /archived in S3 Glacier/,
    'keeps reporting the archive while a restore is already in progress'
  );
  assert(restoringClient.commands[1] instanceof RestoreObjectCommand, 'still asks for the restore while one is in progress');

  assert.throws(
    () => new S3Adapter(),
    /S3_BUCKET_NAME is required/,
    'requires a bucket in S3 mode'
  );
  assert.throws(
    () => new PersistenceManager({ storageMode: 'rds' }),
    /Unsupported storage mode/,
    'rejects unsupported persistence modes instead of falling back to local files'
  );

  const manager = new PersistenceManager({
    storageMode: 's3',
    s3BucketName: 'test-snapshots',
    s3Region: 'us-east-1',
    s3Prefix: 'worlds',
  });
  assert(manager.adapter instanceof S3Adapter, 'selects S3Adapter when storage mode is s3');
  await manager.close();

  await adapter.close();
  await writeAdapter.close();
  await missingAdapter.close();
  await deniedAdapter.close();
  await archivedAdapter.close();
  await restoringAdapter.close();
  assert(loadClient.destroyed && writeClient.destroyed, 'closes injected S3 clients');

  console.log('\n[S3Adapter] All tests passed.\n');
}

run().catch((err) => {
  console.error('\n[S3Adapter] TEST FAILED:', err.message);
  process.exit(1);
});
