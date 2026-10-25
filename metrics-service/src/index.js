import path from 'path';
import { fileURLToPath } from 'url';
import { config, resolveAuthPassword } from './config.js';
import { LobbyApiRepository } from './store/LobbyApiRepository.js';
import { DynamoDbTelemetryStore } from './store/DynamoDbTelemetryStore.js';
import { MetricsCollector } from './MetricsCollector.js';
import { MetricsHttpServer } from './server.js';

/**
 * MetricsServiceApp: Standalone process that serves the monitoring and cost dashboard.
 *
 * Where the telemetry comes from depends on TELEMETRY_MODE:
 * - 'pull': this process scrapes the fleet and keeps the series in memory. One
 *   replica only; meant for local development.
 * - 'dynamodb': worlds and the NPC push samples to Kinesis, a Flink job computes
 *   the ledger and the series, and this process just reads DynamoDB per request.
 *   Holding no state, it runs as several replicas across Availability Zones.
 */
export class MetricsServiceApp {
  constructor(customConfig = {}) {
    this.config = {
      ...config,
      ...customConfig,
      telemetry: { ...config.telemetry, ...(customConfig.telemetry || {}) },
    };
    this.repository = new LobbyApiRepository({
      lobbyUrl: this.config.lobbyUrl,
      timeoutMs: this.config.lobbyTimeoutMs,
    });

    const mode = this.config.telemetry.mode;
    if (mode === 'dynamodb') {
      this.telemetry = new DynamoDbTelemetryStore({ repository: this.repository, config: this.config });
      this.metricsCollector = null;
    } else if (mode === 'pull') {
      this.metricsCollector = new MetricsCollector({ repository: this.repository, config: this.config });
      this.telemetry = this.metricsCollector;
    } else {
      throw new Error(`Unknown TELEMETRY_MODE "${mode}" (expected "pull" or "dynamodb").`);
    }

    this.httpServer = new MetricsHttpServer(this.config, this.telemetry, this.repository);
    this.isShuttingDown = false;
  }

  async start() {
    console.log('====================================================');
    console.log(' Starting Metrics Service (Monitoring & Cost Dashboard)');
    console.log(` Port: ${this.config.port} | Host: ${this.config.host}`);
    console.log(` Lobby: ${this.config.lobbyUrl} | Telemetry: ${this.config.telemetry.mode}`);
    console.log('====================================================');

    this.config.auth = { ...this.config.auth, password: await resolveAuthPassword(this.config.auth.password) };
    await this.repository.init();
    await this.httpServer.start();
    this.telemetry.start();
    this._registerSignalHandlers();

    console.log(`[MetricsApp] Metrics Service is READY on http://${this.config.host}:${this.config.port}`);
  }

  _registerSignalHandlers() {
    const handleSignal = async (signal) => {
      console.log(`\n[MetricsApp] Received ${signal}. Shutting down gracefully...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGTERM', () => handleSignal('SIGTERM'));
  }

  async stop() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('[MetricsApp] Stopping Metrics Service...');
    this.telemetry.stop();
    if (this.httpServer) {
      await this.httpServer.close();
    }
    console.log('[MetricsApp] Metrics Service stopped cleanly.');
  }
}

// Start application only if executed directly from the CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app = new MetricsServiceApp();
  app.start().catch((err) => {
    console.error('[MetricsApp] Fatal error during startup:', err);
    process.exit(1);
  });
}
