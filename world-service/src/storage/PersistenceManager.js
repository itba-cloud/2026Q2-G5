import { LocalJsonAdapter } from './adapters/LocalJsonAdapter.js';
import { S3Adapter } from './adapters/S3Adapter.js';

/**
 * PersistenceManager: Unified persistence layer using the Adapter Pattern.
 * Decouples game logic from specific storage implementations (Local JSON, RDS, DynamoDB).
 */
export class PersistenceManager {
  /**
   * @param {object} config Configuration object
   */
  constructor(config) {
    this.config = config;
    this.adapter = this._createAdapter();
  }

  _createAdapter() {
    switch (this.config.storageMode) {
      case 'local':
        return new LocalJsonAdapter(this.config.dataDir);
      case 's3':
        return new S3Adapter({
          bucketName: this.config.s3BucketName,
          region: this.config.s3Region,
          prefix: this.config.s3Prefix,
        });
      default:
        throw new Error(`Unsupported storage mode "${this.config.storageMode}". Use "local" or "s3".`);
    }
  }

  async init() {
    if (typeof this.adapter.init === 'function') {
      await this.adapter.init();
    }
  }

  /**
   * Loads world state by ID.
   * @param {string} worldId
   * @returns {Promise<object|null>}
   */
  async loadWorldState(worldId) {
    return this.adapter.loadWorldState(worldId);
  }

  /**
   * Saves world state snapshot.
   * @param {string} worldId
   * @param {object} snapshot
   * @returns {Promise<boolean>}
   */
  async saveWorldState(worldId, snapshot) {
    return this.adapter.saveWorldState(worldId, snapshot);
  }

  /**
   * Closes storage connections.
   */
  async close() {
    if (typeof this.adapter.close === 'function') {
      await this.adapter.close();
    }
  }
}
