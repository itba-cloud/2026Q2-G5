import { GetObjectCommand, PutObjectCommand, RestoreObjectCommand, S3Client } from '@aws-sdk/client-s3';

// Days the restored copy of an archived snapshot stays readable. The first save
// after booting rewrites the object in Standard, so a short window is enough.
const RESTORED_COPY_DAYS = 7;

function isObjectMissing(err) {
  return err?.name === 'NoSuchKey'
    || err?.Code === 'NoSuchKey'
    || err?.$metadata?.httpStatusCode === 404;
}

// The bucket lifecycle no longer moves snapshots to Deep Archive, but objects
// archived under the previous policy fail GetObject until they are restored.
function isObjectArchived(err) {
  return err?.name === 'InvalidObjectState' || err?.Code === 'InvalidObjectState';
}

function isRestoreInProgress(err) {
  return err?.name === 'RestoreAlreadyInProgress' || err?.Code === 'RestoreAlreadyInProgress';
}

/**
 * S3Adapter: Persists the latest full snapshot for each world in S3.
 * AWS credentials are resolved by the SDK, normally from the World Host IAM role.
 */
export class S3Adapter {
  constructor({ bucketName, region, prefix = 'worlds', client } = {}) {
    if (!bucketName) {
      throw new Error('S3_BUCKET_NAME is required when STORAGE_MODE=s3.');
    }

    this.bucketName = bucketName;
    this.prefix = prefix.replace(/^\/+|\/+$/g, '') || 'worlds';
    this.client = client || new S3Client({ region });
  }

  _getObjectKey(worldId) {
    return `${this.prefix}/${worldId}/snapshot.json`;
  }

  async loadWorldState(worldId) {
    const key = this._getObjectKey(worldId);
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }));
      if (!response.Body || typeof response.Body.transformToString !== 'function') {
        throw new Error('S3 returned an empty snapshot body.');
      }

      const serialized = await response.Body.transformToString();
      const snapshot = JSON.parse(serialized);
      console.log(`[S3Adapter] Loaded state for world "${worldId}" from s3://${this.bucketName}/${key}`);
      return snapshot;
    } catch (err) {
      if (isObjectMissing(err)) {
        console.log(`[S3Adapter] No existing state found for world "${worldId}". Initializing fresh world.`);
        return null;
      }
      if (isObjectArchived(err)) {
        await this._requestRestore(key);
        throw new Error(
          `Snapshot for world "${worldId}" is archived in S3 Glacier. A restore was requested and can take about 12 hours; start the world again after that.`,
          { cause: err }
        );
      }
      throw new Error(`Failed to load snapshot for world "${worldId}" from S3.`, { cause: err });
    }
  }

  async _requestRestore(key) {
    try {
      await this.client.send(new RestoreObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        RestoreRequest: {
          Days: RESTORED_COPY_DAYS,
          GlacierJobParameters: { Tier: 'Standard' },
        },
      }));
      console.log(`[S3Adapter] Requested restore of archived snapshot s3://${this.bucketName}/${key}`);
    } catch (err) {
      if (isRestoreInProgress(err)) {
        console.log(`[S3Adapter] Restore already in progress for s3://${this.bucketName}/${key}`);
        return;
      }
      throw new Error(`Failed to request restore of archived snapshot s3://${this.bucketName}/${key}.`, { cause: err });
    }
  }

  async saveWorldState(worldId, snapshot) {
    const key = this._getObjectKey(worldId);
    const serialized = JSON.stringify(snapshot);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: serialized,
        ContentType: 'application/json',
      }));
      console.log(`[S3Adapter] Saved state for world "${worldId}" (${serialized.length} bytes) to s3://${this.bucketName}/${key}`);
      return true;
    } catch (err) {
      throw new Error(`Failed to save snapshot for world "${worldId}" to S3.`, { cause: err });
    }
  }

  async close() {
    this.client.destroy?.();
  }
}
