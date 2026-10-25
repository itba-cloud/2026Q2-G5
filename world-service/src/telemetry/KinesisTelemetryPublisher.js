import os from 'os';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';

/** Log every Nth consecutive failure so a dead stream does not flood the logs. */
const FAILURE_LOG_EVERY = 12;

/**
 * KinesisTelemetryPublisher: Pushes this world's metrics sample to the telemetry
 * stream every few seconds (see .docs/telemetry-pipeline.md, record `type: "world"`).
 *
 * The world used to be scraped; now it reports itself, so the metrics service can be
 * stateless and run in both Availability Zones. Publishing is best-effort: a failure is
 * logged and the next tick retries. It never affects gameplay.
 */
export class KinesisTelemetryPublisher {
  /**
   * @param {object} params
   * @param {string} params.streamName Kinesis Data Stream name
   * @param {string} params.worldId Partition key and world identity
   * @param {() => object} params.getPayload Builds the metrics payload (same as GET /metrics)
   * @param {string} [params.region]
   * @param {number} [params.intervalMs]
   * @param {string} [params.containerId] Session id; defaults to the hostname Docker assigns
   * @param {{ send(cmd: object): Promise<object> }} [params.client] Injected for tests
   */
  constructor({ streamName, worldId, getPayload, region, intervalMs = 5000, containerId, client } = {}) {
    if (!streamName) {
      throw new Error('TELEMETRY_STREAM_NAME is required when TELEMETRY_MODE=kinesis.');
    }
    if (typeof getPayload !== 'function') {
      throw new Error('KinesisTelemetryPublisher needs a getPayload() function.');
    }

    this.streamName = streamName;
    this.worldId = worldId;
    this.getPayload = getPayload;
    this.intervalMs = intervalMs;
    this.containerId = containerId || os.hostname();
    this.client = client || new KinesisClient({ region });

    this.timer = null;
    this.consecutiveFailures = 0;
    this.publishedCount = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.publish().catch(() => {});
    }, this.intervalMs);
    // Telemetry must never keep the process alive on its own.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    console.log(`[Telemetry] Publishing to Kinesis stream "${this.streamName}" every ${this.intervalMs}ms as container ${this.containerId}.`);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Builds the `world` record from the current metrics payload.
   * @returns {object}
   */
  buildRecord() {
    const payload = this.getPayload() || {};
    return {
      type: 'world',
      schemaVersion: 1,
      worldId: this.worldId,
      containerId: this.containerId,
      timestamp: payload.timestamp || new Date().toISOString(),
      worldName: payload.worldName,
      players: payload.players,
      memory: payload.memory,
      gameLoop: payload.gameLoop,
      entities: payload.entities,
      process: payload.process,
      config: payload.config,
    };
  }

  /**
   * Sends one record. Resolves to true on success and false on failure; never throws.
   * @returns {Promise<boolean>}
   */
  async publish() {
    let record;
    try {
      record = this.buildRecord();
      await this.client.send(new PutRecordCommand({
        StreamName: this.streamName,
        PartitionKey: this.worldId,
        Data: Buffer.from(JSON.stringify(record), 'utf8'),
      }));
      if (this.consecutiveFailures >= FAILURE_LOG_EVERY) {
        console.log(`[Telemetry] Kinesis stream "${this.streamName}" reachable again after ${this.consecutiveFailures} failed attempts.`);
      }
      this.consecutiveFailures = 0;
      this.publishedCount++;
      return true;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % FAILURE_LOG_EVERY === 0) {
        console.warn(`[Telemetry] Failed to publish to Kinesis stream "${this.streamName}" (${this.consecutiveFailures} in a row): ${err.message}`);
      }
      return false;
    }
  }

  async close() {
    this.stop();
    this.client.destroy?.();
  }
}
