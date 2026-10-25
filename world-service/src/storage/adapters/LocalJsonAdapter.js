import fs from 'fs/promises';
import path from 'path';

/**
 * LocalJsonAdapter: Implements local filesystem persistence for development.
 * Compatible with the snapshot schema used in S3.
 */
export class LocalJsonAdapter {
  /**
   * @param {string} dataDir
   */
  constructor(dataDir = './.data') {
    this.dataDir = path.resolve(dataDir);
  }

  async init() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (err) {
      console.error(`[LocalJsonAdapter] Failed to create data dir ${this.dataDir}:`, err);
    }
  }

  _getFilePath(worldId) {
    return path.join(this.dataDir, `${worldId}.json`);
  }

  /**
   * Loads world snapshot by world ID.
   * @param {string} worldId
   * @returns {Promise<object|null>}
   */
  async loadWorldState(worldId) {
    const filePath = this._getFilePath(worldId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      console.log(`[LocalJsonAdapter] Loaded state for world "${worldId}" from ${filePath}`);
      return data;
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(`[LocalJsonAdapter] No existing state found for world "${worldId}". Initializing fresh world.`);
        return null;
      }
      console.error(`[LocalJsonAdapter] Error loading state from ${filePath}:`, err);
      return null;
    }
  }

  /**
   * Saves world snapshot.
   * @param {string} worldId
   * @param {object} snapshot
   * @returns {Promise<boolean>}
   */
  async saveWorldState(worldId, snapshot) {
    const filePath = this._getFilePath(worldId);
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const serialized = JSON.stringify(snapshot, null, 2);
      await fs.writeFile(filePath, serialized, 'utf-8');
      console.log(`[LocalJsonAdapter] Saved state for world "${worldId}" (${serialized.length} bytes) to ${filePath}`);
      return true;
    } catch (err) {
      console.error(`[LocalJsonAdapter] Failed to save state to ${filePath}:`, err);
      return false;
    }
  }

  async close() {
    // No persistent connection to close for local files
  }
}
