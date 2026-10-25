import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CostEstimator } from '../CostEstimator.js';
import { buildSnapshot } from '../SnapshotBuilder.js';

const DEFAULT_STALE_AFTER_SECONDS = 15;
const DEFAULT_FLEET_WINDOW_SECONDS = 10;
const DEFAULT_PRODUCER_INTERVAL_MS = 5000;
/** BatchGetItem accepts at most 100 keys per call. */
const BATCH_GET_LIMIT = 100;
/** A sample older than this many stale windows is dropped from the row altogether. */
const DROP_AFTER_STALE_FACTOR = 4;

const WORLD_PREFIX = 'WORLD#';
const FLEET_PK = 'FLEET';
// One item per NPC replica (sk TASK#<instanceId>); the snapshot sums the fresh ones.
const NPC_SERVICE_PK = 'SERVICE#npc';

/**
 * DynamoDbTelemetryStore: Push-mode telemetry store (TELEMETRY_MODE=dynamodb).
 *
 * Holds nothing between requests. Every snapshot is the Lobby registry joined with
 * the rows the Flink job keeps in DynamoDB (see .docs/telemetry-pipeline.md), which is
 * what lets several replicas of this service answer identically from any AZ.
 */
export class DynamoDbTelemetryStore {
  /**
   * @param {object} params
   * @param {{ listWorlds(): Promise<object[]>, listHosts(): Promise<object[]> }} params.repository
   * @param {object} params.config Metrics service configuration
   * @param {{ send(cmd: object): Promise<object> }} [params.client] Injected for tests
   */
  constructor({ repository, config, client }) {
    const telemetry = config?.telemetry || {};
    if (!telemetry.tableName && !client) {
      throw new Error('TELEMETRY_TABLE_NAME is required when TELEMETRY_MODE=dynamodb.');
    }

    this.repository = repository;
    this.tableName = telemetry.tableName || 'elastic-worlds-telemetry';
    this.staleAfterSeconds = telemetry.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
    this.fleetWindowSeconds = telemetry.fleetWindowSeconds ?? DEFAULT_FLEET_WINDOW_SECONDS;
    this.producerIntervalMs = config?.metrics?.intervalMs ?? DEFAULT_PRODUCER_INTERVAL_MS;
    this.costEstimator = new CostEstimator(config?.pricing);

    this.client = client || DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: telemetry.region }),
      { marshallOptions: { removeUndefinedValues: true } }
    );

    this.isRunning = false;
    this.lastReadDurationMs = 0;
    this.readCount = 0;
    this.tableReachable = false;
  }

  start() {
    this.isRunning = true;
    console.log(`[DynamoDbTelemetryStore] Serving telemetry from table "${this.tableName}" (stale after ${this.staleAfterSeconds}s).`);
  }

  stop() {
    this.isRunning = false;
  }

  /**
   * Builds a fresh snapshot: registry from the Lobby, telemetry from DynamoDB.
   * @returns {Promise<object>}
   */
  async getSnapshot() {
    const started = Date.now();
    const [worlds, hosts] = await Promise.all([
      this.repository.listWorlds(),
      this.repository.listHosts(),
    ]);

    const [worldItems, npcItems] = await Promise.all([
      this._getWorldItems(worlds.map((w) => w.id)),
      this._getNpcServiceItems(),
    ]);

    const now = Date.now();
    const worldTelemetry = new Map();
    let earliestFirstSeen = null;

    for (const world of worlds) {
      const item = worldItems.get(world.id);
      if (!item) continue;

      const telemetry = this._toWorldTelemetry(item, now);
      worldTelemetry.set(world.id, telemetry);

      const firstSeen = Number(item.billing?.firstSeenAt);
      if (Number.isFinite(firstSeen) && firstSeen > 0) {
        earliestFirstSeen = earliestFirstSeen === null ? firstSeen : Math.min(earliestFirstSeen, firstSeen);
      }
    }

    // A replica that scaled in or died stops reporting: only fresh heartbeats count.
    const npcReplicas = npcItems.filter((item) => {
      const age = ageSeconds(item.sampledAt, now);
      return age !== null && age <= this.staleAfterSeconds;
    });
    const npcServiceReachable = npcReplicas.length > 0;

    this.lastReadDurationMs = Date.now() - started;
    this.readCount++;

    return buildSnapshot({
      worlds,
      hosts,
      worldTelemetry,
      fleetObservationSeconds: earliestFirstSeen ? (now - earliestFirstSeen) / 1000 : 0,
      totalBots: npcReplicas.reduce((sum, item) => sum + (Number(item.totalBots) || 0), 0),
      npcServiceReachable,
      collector: {
        mode: 'dynamodb',
        running: this.isRunning,
        intervalMs: this.fleetWindowSeconds * 1000,
        producerIntervalMs: this.producerIntervalMs,
        staleAfterSeconds: this.staleAfterSeconds,
        reportingWorlds: [...worldTelemetry.values()].filter((t) => t.failedScrapes === 0).length,
        npcReplicas: npcReplicas.length,
        lastReadDurationMs: this.lastReadDurationMs,
        observationSeconds: earliestFirstSeen ? Math.round((now - earliestFirstSeen) / 1000) : 0,
      },
    }, this.costEstimator, now);
  }

  /**
   * Most recent fleet points, oldest first, as the dashboard charts expect.
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async getHistory(limit) {
    const res = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': FLEET_PK },
      ScanIndexForward: false,
      Limit: limit && limit > 0 ? limit : undefined,
    }));
    this.tableReachable = true;

    // Pricing is applied at read time: the pipeline stores counts only, and the slot
    // price is a property of this service's configuration, not of the data.
    const slotHourlyUsd = this.costEstimator.getSlotHourlyUsd({});
    return (res.Items || []).reverse().map((item) => {
      const activeWorlds = Number(item.activeWorlds) || 0;
      return {
        timestamp: item.timestamp,
        activeWorlds,
        totalPlayers: Number(item.totalPlayers) || 0,
        humanPlayers: Number(item.humanPlayers) || 0,
        botPlayers: Number(item.botPlayers) || 0,
        totalMemoryMb: Number(item.totalMemoryMb) || 0,
        avgTickHz: numberOrNull(item.avgTickHz),
        avgAiLatencyMs: numberOrNull(item.avgAiLatencyMs),
        hourlyUsd: Math.round(activeWorlds * slotHourlyUsd * 1e6) / 1e6,
      };
    });
  }

  /**
   * Status block for /health.
   * @returns {object}
   */
  describe() {
    return {
      mode: 'dynamodb',
      running: this.isRunning,
      tableName: this.tableName,
      tableReachable: this.tableReachable,
      readCount: this.readCount,
    };
  }

  /**
   * Fetches the WORLD#<id>/LATEST items for the given ids, in batches of 100.
   * @param {string[]} worldIds
   * @returns {Promise<Map<string, object>>}
   */
  async _getWorldItems(worldIds) {
    const found = new Map();
    for (let i = 0; i < worldIds.length; i += BATCH_GET_LIMIT) {
      let keys = worldIds.slice(i, i + BATCH_GET_LIMIT).map((id) => ({ pk: `${WORLD_PREFIX}${id}`, sk: 'LATEST' }));

      // Unprocessed keys come back under throttling; retry them a few times rather
      // than report those worlds as silent.
      for (let attempt = 0; keys.length > 0 && attempt < 3; attempt++) {
        const res = await this.client.send(new BatchGetCommand({
          RequestItems: { [this.tableName]: { Keys: keys } },
        }));
        this.tableReachable = true;
        for (const item of res.Responses?.[this.tableName] || []) {
          if (item.worldId) found.set(item.worldId, item);
        }
        keys = res.UnprocessedKeys?.[this.tableName]?.Keys || [];
      }
    }
    return found;
  }

  async _getNpcServiceItems() {
    const res = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': NPC_SERVICE_PK },
    }));
    this.tableReachable = true;
    return res.Items || [];
  }

  /**
   * Normalises a DynamoDB world item into the SnapshotBuilder view.
   * @param {object} item
   * @param {number} now
   * @returns {import('../SnapshotBuilder.js').WorldTelemetry}
   */
  _toWorldTelemetry(item, now) {
    const age = ageSeconds(item.sampledAt, now);
    const fresh = age !== null && age <= this.staleAfterSeconds;
    // A world that stopped reporting is shown with its last reading and its age for a
    // while, then with no reading at all, mirroring what the pull collector does when
    // a container dies.
    const keepSample = age !== null && age <= this.staleAfterSeconds * DROP_AFTER_STALE_FACTOR;
    const failedScrapes = fresh || age === null ? 0 : Math.max(1, Math.ceil(age / (this.producerIntervalMs / 1000)));

    const sample = keepSample && item.sample
      ? { ...item.sample, rolling: item.rolling ?? null }
      : null;

    const ai = item.ai
      ? {
        botCount: Number(item.ai.botCount) || 0,
        avgMs: numberOrNull(item.ai.avgMs),
        p95Ms: numberOrNull(item.ai.p95Ms),
        maxMs: numberOrNull(item.ai.maxMs),
        decisions: Number(item.ai.decisions) || 0,
      }
      : null;

    const firstSeen = Number(item.billing?.firstSeenAt);
    return {
      sample,
      sampledAt: item.sampledAt ?? null,
      failedScrapes,
      ai,
      cumulativeActiveSeconds: Number(item.billing?.cumulativeActiveSeconds) || 0,
      observationSeconds: Number.isFinite(firstSeen) && firstSeen > 0 ? (now - firstSeen) / 1000 : 0,
    };
  }
}

function ageSeconds(isoTimestamp, now) {
  if (!isoTimestamp) return null;
  const t = new Date(isoTimestamp).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / 1000);
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}
