import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { World } from './engine/World.js';
import { GameLoop } from './engine/GameLoop.js';
import { WebSocketServer } from './network/WebSocketServer.js';
import { PersistenceManager } from './storage/PersistenceManager.js';
import { EventBus, BusMessageTypes } from './messaging/EventBus.js';
import { MessageTypes, createMessage } from './network/protocol.js';
import { KinesisTelemetryPublisher } from './telemetry/KinesisTelemetryPublisher.js';

class WorldServiceApp {
  constructor(customConfig = {}) {
    this.config = { ...config, ...customConfig };
    this.persistenceManager = new PersistenceManager(this.config);
    this.world = null;
    this.gameLoop = null;
    this.wsServer = null;
    this.eventBus = null;
    this.telemetry = null;

    this.saveInterval = null;
    this.idleTimer = null;
    this.isShuttingDown = false;
  }

  async start() {
    console.log('====================================================');
    console.log(` Starting World Service for: [${this.config.worldId}]`);
    console.log(` World Name: "${this.config.worldName}"`);
    console.log(` Seed: ${this.config.seed} | Size: ${this.config.worldWidth}x${this.config.worldHeight}`);
    console.log(` Storage Mode: ${this.config.storageMode}`);
    console.log('====================================================');

    // 1. Initialize Persistence Layer
    await this.persistenceManager.init();

    // 2. Hydrate from storage if snapshot exists
    const savedState = await this.persistenceManager.loadWorldState(this.config.worldId);

    // 3. Initialize Authoritative World
    this.world = new World({
      worldId: this.config.worldId,
      name: this.config.worldName,
      seed: this.config.seed,
      worldWidth: this.config.worldWidth,
      worldHeight: this.config.worldHeight,
      playerSpeed: this.config.playerSpeed,
      playerRadius: this.config.playerRadius,
      onEvent: (type, payload) => {
        if (this.wsServer) {
          this.wsServer.broadcast(createMessage(type, payload));
        }
      },
    });

    if (savedState) {
      this.world.hydrateFromSnapshot(savedState);
      console.log(`[App] Hydrated world state with ${this.world.harvestedResources.size} harvested deltas`);
    }

    // 4. Connect the cross-world message bus (optional — never fatal)
    this.eventBus = new EventBus({
      redisUrl: this.config.redisUrl,
      channel: this.config.globalChannel,
      worldId: this.config.worldId,
      worldName: this.config.worldName,
      onMessage: (message) => this._handleBusMessage(message),
    });
    await this.eventBus.connect();

    // 5. Initialize WebSocket Server
    this.wsServer = new WebSocketServer({
      port: this.config.port,
      world: this.world,
      onPlayerCountChange: (count) => this._handlePlayerCountChange(count),
      getMetrics: () => this._collectMetrics(),
      onChatMessage: (chat) => this.eventBus.publish(BusMessageTypes.CHAT, chat),
      chatMaxLength: this.config.chatMaxLength,
      chatCooldownMs: this.config.chatCooldownMs,
    });

    await this.wsServer.start();

    // 6. Initialize & Start Game Loop (20 Hz)
    this.gameLoop = new GameLoop(
      this.world,
      (syncState) => {
        // Only broadcast if there are connected players
        if (this.wsServer.getConnectedCount() > 0) {
          const syncPacket = createMessage(MessageTypes.STATE_SYNC, syncState);
          this.wsServer.broadcast(syncPacket);
        }
      },
      this.config.tickIntervalMs
    );

    this.gameLoop.start();

    // 7. Setup Periodic Auto-Save
    this._startPeriodicSave();

    // 8. Check Initial Idle State
    this._handlePlayerCountChange(0);

    // 9. Register OS Process Signals
    this._registerSignalHandlers();

    // 10. Let the other worlds know we are up
    this.eventBus.publish(BusMessageTypes.WORLD_ONLINE, {
      message: `El mundo "${this.config.worldName}" está online`,
    });

    // 11. Report telemetry to the pipeline (optional — never fatal)
    this._startTelemetry();

    console.log(`[App] World Service is READY and accepting connections on port ${this.config.port}`);
  }

  /**
   * Relays a message published by another world down to our own players.
   *
   * Chat arrives as CHAT_MESSAGE so the client can render it in the chat log;
   * lifecycle notices arrive as WORLD_NOTICE and surface as a transient banner.
   * @param {object} message Envelope produced by EventBus.publish
   */
  _handleBusMessage(message) {
    if (!this.wsServer || this.wsServer.getConnectedCount() === 0) return;

    switch (message.type) {
      case BusMessageTypes.CHAT:
        this.wsServer.broadcast(createMessage(MessageTypes.CHAT_MESSAGE, {
          playerName: message.playerName,
          text: message.text,
          worldName: message.worldName,
          timestamp: message.timestamp,
          isRemote: true,
        }));
        break;

      case BusMessageTypes.WORLD_ONLINE:
      case BusMessageTypes.WORLD_OFFLINE:
      case BusMessageTypes.ANNOUNCEMENT:
        this.wsServer.broadcast(createMessage(MessageTypes.WORLD_NOTICE, {
          kind: message.type,
          message: message.message,
          worldName: message.worldName,
          timestamp: message.timestamp,
        }));
        break;

      default:
        console.warn(`[App] Ignoring unknown bus message type: ${message.type}`);
        break;
    }
  }

  /**
   * Builds the telemetry payload served on GET /metrics.
   *
   * Every value is read from live objects at call time: the world keeps no metrics
   * state of its own, so scraping is free when nobody is looking.
   * @returns {object}
   */
  _collectMetrics() {
    const memory = process.memoryUsage();
    const toMb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
    const humans = this.wsServer ? this.wsServer.getHumanPlayerCount() : 0;
    const total = this.wsServer ? this.wsServer.getConnectedCount() : 0;

    return {
      worldId: this.config.worldId,
      worldName: this.config.worldName,
      timestamp: new Date().toISOString(),
      players: {
        total,
        humans,
        bots: Math.max(0, total - humans),
      },
      memory: {
        rssMb: toMb(memory.rss),
        heapUsedMb: toMb(memory.heapUsed),
        heapTotalMb: toMb(memory.heapTotal),
        externalMb: toMb(memory.external),
        heapUtilizationPct: memory.heapTotal > 0
          ? Math.round((memory.heapUsed / memory.heapTotal) * 1000) / 10
          : 0,
      },
      gameLoop: this.gameLoop ? this.gameLoop.getStats() : null,
      entities: {
        players: this.world ? this.world.players.size : 0,
        structures: this.world ? this.world.structures.size : 0,
        resources: this.world ? this.world.resources.size : 0,
        harvestedResources: this.world ? this.world.harvestedResources.size : 0,
        projectiles: this.world?.combatSystem ? this.world.combatSystem.projectiles.size : 0,
      },
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        pid: process.pid,
        nodeVersion: process.version,
      },
      config: {
        idleTimeoutSeconds: this.config.idleTimeoutSeconds,
        saveIntervalSeconds: this.config.saveIntervalSeconds,
        port: this.config.port,
      },
    };
  }

  /**
   * Starts the Kinesis publisher when TELEMETRY_MODE=kinesis. A misconfiguration is
   * logged and ignored: the world must keep serving players without telemetry.
   */
  _startTelemetry() {
    if (this.config.telemetryMode !== 'kinesis') return;
    try {
      this.telemetry = new KinesisTelemetryPublisher({
        streamName: this.config.telemetryStreamName,
        worldId: this.config.worldId,
        region: this.config.s3Region,
        intervalMs: this.config.telemetryIntervalMs,
        containerId: this.config.containerId || undefined,
        getPayload: () => this._collectMetrics(),
      });
      this.telemetry.start();
    } catch (err) {
      console.warn(`[App] Telemetry disabled: ${err.message}`);
      this.telemetry = null;
    }
  }

  _startPeriodicSave() {
    if (this.config.saveIntervalSeconds <= 0) return;

    this.saveInterval = setInterval(async () => {
      if (this.world && !this.isShuttingDown) {
        try {
          const snapshot = this.world.getSnapshot();
          await this.persistenceManager.saveWorldState(this.config.worldId, snapshot);
        } catch (err) {
          console.error('[App] Error during periodic save:', err);
        }
      }
    }, this.config.saveIntervalSeconds * 1000);
  }

  _handlePlayerCountChange(humanCount, totalCount = 0) {
    if (humanCount > 0) {
      if (this.idleTimer) {
        console.log(`[App] Human player connected (${humanCount} active). Cancelling idle shutdown timer.`);
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    } else {
      if (!this.idleTimer && this.config.idleTimeoutSeconds > 0) {
        const botCount = Math.max(0, totalCount - humanCount);
        console.log(`[App] World has 0 human players connected (${botCount} bot(s) running). Starting idle countdown (${this.config.idleTimeoutSeconds}s) before elastic shutdown...`);
        this.idleTimer = setTimeout(() => {
          console.log('[App] Idle timeout reached with 0 human players. Initiating elastic shutdown.');
          this.stop(0);
        }, this.config.idleTimeoutSeconds * 1000);
      }
    }
  }

  _registerSignalHandlers() {
    const handleSignal = (signal) => {
      console.log(`\n[App] Received ${signal}. Shutting down gracefully...`);
      this.stop(0);
    };

    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGTERM', () => handleSignal('SIGTERM'));
  }

  async stop(exitCode = 0) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('[App] Stopping World Service...');

    // Clear timers
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Stop game loop
    if (this.gameLoop) {
      this.gameLoop.stop();
    }

    // Stop reporting telemetry; the pipeline marks the world stale on its own.
    if (this.telemetry) {
      await this.telemetry.close();
      this.telemetry = null;
    }

    // Save final snapshot
    if (this.world && this.persistenceManager) {
      try {
        console.log('[App] Persisting final world snapshot...');
        const finalSnapshot = this.world.getSnapshot();
        await this.persistenceManager.saveWorldState(this.config.worldId, finalSnapshot);
      } catch (err) {
        console.error('[App] Failed to save final snapshot:', err);
      }
    }

    // Close WebSocket server
    if (this.wsServer) {
      await this.wsServer.close();
    }

    // Tell the other worlds we are going to sleep, then drop the bus. The
    // publish is awaited so it flushes before the connection closes.
    if (this.eventBus) {
      await this.eventBus.publish(BusMessageTypes.WORLD_OFFLINE, {
        message: `El mundo "${this.config.worldName}" se durmió por inactividad`,
      });
      await this.eventBus.close();
    }

    // Close storage connections
    // Notify Lobby Service about world shutdown
    if (this.config.lobbyApiUrl) {
      await this.notifyLobbyShutdown();
    }

    console.log('[App] World Service stopped cleanly.');
    if (typeof exitCode === 'number') {
      process.exit(exitCode);
    }
  }

  /**
   * Tells the Lobby this runtime is going away. A cold Lobby Lambda can take
   * about 3s to answer, so each attempt waits longer and a failed one is
   * retried. The idempotency key makes the retry join the same operation.
   */
  async notifyLobbyShutdown({ attempts = 2, timeoutMs = 10000, retryDelayMs = 1000 } = {}) {
    const url = `${this.config.lobbyApiUrl}/worlds/${this.config.worldId}/shutdown`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.runtimeId) headers['Idempotency-Key'] = `shutdown:${this.config.runtimeId}`;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        console.log(`[App] Notifying Lobby Service at ${url} (attempt ${attempt}/${attempts})...`);
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ runtimeId: this.config.runtimeId || null }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          console.log('[App] Successfully notified Lobby Service of shutdown.');
          return true;
        }
        console.warn(`[App] Lobby Service returned HTTP ${res.status} on shutdown notification.`);
        // A 4xx (e.g. a stale runtime) will not change on retry.
        if (res.status < 500) return false;
      } catch (err) {
        console.warn(`[App] Could not notify Lobby Service of shutdown (${err.message}).`);
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    return false;
  }
}

// Start application only if executed directly from the CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app = new WorldServiceApp();
  app.start().catch((err) => {
    console.error('[App] Fatal error during startup:', err);
    process.exit(1);
  });
}

export { WorldServiceApp };
