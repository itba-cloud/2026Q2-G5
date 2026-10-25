import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { createWorldRepository } from './store/WorldRegistry.js';
import { DockerContainerLauncher } from './orchestrator/DockerContainerLauncher.js';
import { HostPlacementEngine } from './orchestrator/HostPlacementEngine.js';
import { AnnouncementPublisher } from './modules/messaging/AnnouncementPublisher.js';
import { LobbyHttpServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);

export class LobbyServiceApp {
  constructor(customConfig = {}) {
    this.config = { ...config, ...customConfig };
    this.repository = createWorldRepository(this.config);
    this.dockerLauncher = new DockerContainerLauncher({ useMock: this.config.useDockerMock });
    this.placementEngine = new HostPlacementEngine(this.repository, this.dockerLauncher, this.config);
    this.announcementPublisher = new AnnouncementPublisher({
      redisUrl: this.config.redisUrl,
      channel: this.config.globalChannel,
    });
    this.httpServer = new LobbyHttpServer(
      this.config,
      this.repository,
      this.placementEngine,
      this.announcementPublisher
    );
    this.isShuttingDown = false;
    this.reconciliationTimer = null;
  }

  async start() {
    console.log('====================================================');
    console.log(' Starting Lobby Service (Control Plane API - Stateless)');
    console.log(` Port: ${this.config.port} | Host: ${this.config.host}`);
    console.log(` Storage Mode: ${this.config.storageMode}`);
    console.log(` World Ports Range: ${this.config.worldPortRange.min}-${this.config.worldPortRange.max}`);
    console.log('====================================================');

    // 1. Initialize Persistence Repository
    await this.repository.init({ migrate: this.config.migrateOnStart });

    // 2. Reclaim reservations a previous Lobby process left behind
    if (this.config.reconcileEnabled) await this.placementEngine.recoverExpiredWorldStarts();

    // 3. Connect the announcement publisher (optional — never fatal)
    await this.announcementPublisher.connect();

    // 4. Start HTTP Server
    await this.httpServer.start();

    // 5. Start background periodic reconciliation loop (evaluates host heartbeats & container status)
    if (this.config.reconcileEnabled) this.reconciliationTimer = setInterval(() => {
      this.placementEngine.reconcileWorldStates({ force: true }).catch((err) => {
        console.warn('[LobbyApp] Background reconciliation warning:', err.message);
      });
    }, 5000);
    if (this.reconciliationTimer?.unref) {
      this.reconciliationTimer.unref();
    }

    // 6. Register OS Signals
    this._registerSignalHandlers();

    console.log(`[LobbyApp] Lobby Service is READY on http://${this.config.host}:${this.config.port}`);
  }

  _registerSignalHandlers() {
    const handleSignal = async (signal) => {
      console.log(`\n[LobbyApp] Received ${signal}. Shutting down gracefully...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGTERM', () => handleSignal('SIGTERM'));
  }

  async stop() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('[LobbyApp] Stopping Lobby Service...');
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    if (this.httpServer) {
      await this.httpServer.close();
    }
    if (this.announcementPublisher) {
      await this.announcementPublisher.close();
    }
    if (this.repository && typeof this.repository.close === 'function') {
      await this.repository.close();
    }
    console.log('[LobbyApp] Lobby Service stopped cleanly.');
  }
}

// Start application only if executed directly from the CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app = new LobbyServiceApp();
  app.start().catch((err) => {
    console.error('[LobbyApp] Fatal error during startup:', err);
    process.exit(1);
  });
}
