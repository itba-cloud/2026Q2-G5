import express from 'express';
import cors from 'cors';
import { createMetricsRoutes } from './metrics.routes.js';

/**
 * MetricsHttpServer: Express server exposing the dashboard snapshots produced by
 * the telemetry store (MetricsCollector in pull mode, DynamoDbTelemetryStore in AWS).
 */
export class MetricsHttpServer {
  /**
   * @param {object} config
   * @param {{ getSnapshot(): Promise<object>, getHistory(limit?: number): Promise<object[]>, describe(): object }} telemetry
   * @param {import('./store/LobbyApiRepository.js').LobbyApiRepository} repository
   */
  constructor(config, telemetry, repository) {
    this.config = config;
    this.telemetry = telemetry;
    this.repository = repository;
    this.app = express();
    this.server = null;

    this._setupMiddlewares();
    this._setupRoutes();
    this._setupErrorHandlers();
  }

  _setupMiddlewares() {
    // The browser calls this service straight from the S3-hosted dashboard (through
    // the ALB path rule in AWS, or on :3100 locally), so it needs its own CORS policy.
    this.app.use(cors({
      origin: this.config.corsOrigins.includes('*') ? '*' : this.config.corsOrigins,
      methods: ['GET', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
    }));

    if (this.config.auth?.enabled) {
      this.app.use((req, res, next) => {
        // Health check endpoint must NEVER require authentication (used by ALB Target Group)
        if (req.path === '/health') return next();

        // Preflight requests should bypass authentication
        if (req.method === 'OPTIONS') return next();

        const authHeader = req.headers.authorization;
        const realm = this.config.auth.realm || 'Elastic Worlds Metrics';

        if (!authHeader || !authHeader.startsWith('Basic ')) {
          res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
          return res.status(401).json({
            success: false,
            error: 'Autenticación requerida para acceder al servicio de métricas',
          });
        }

        const base64Credentials = authHeader.slice(6).trim();
        let credentials = '';
        try {
          credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
        } catch {
          res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
          return res.status(401).json({
            success: false,
            error: 'Credenciales inválidas',
          });
        }

        const colonIndex = credentials.indexOf(':');
        if (colonIndex === -1) {
          res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
          return res.status(401).json({
            success: false,
            error: 'Formato de credenciales inválido (esperado usuario:contraseña)',
          });
        }

        const user = credentials.substring(0, colonIndex);
        const pass = credentials.substring(colonIndex + 1);

        if (user === this.config.auth.user && pass === this.config.auth.password) {
          return next();
        }

        res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
        return res.status(401).json({
          success: false,
          error: 'Credenciales inválidas',
        });
      });
    }
  }


  _setupRoutes() {
    this.app.get('/health', (req, res) => {
      const telemetry = this.telemetry.describe();
      res.json({
        status: 'ok',
        service: 'metrics-service',
        timestamp: new Date().toISOString(),
        telemetry,
        // Kept for callers that predate the pipeline.
        collectorRunning: telemetry.running,
        scrapeCount: telemetry.scrapeCount ?? telemetry.readCount ?? 0,
        lobbyUrl: this.config.lobbyUrl,
        lobbyReachable: this.repository.lobbyReachable,
      });
    });

    this.app.use(createMetricsRoutes(this.telemetry));
  }

  _setupErrorHandlers() {
    this.app.use((req, res) => {
      res.status(404).json({
        success: false,
        error: `Ruta ${req.method} ${req.originalUrl} no encontrada`,
      });
    });

    // eslint-disable-next-line no-unused-vars
    this.app.use((err, req, res, next) => {
      console.error(`[MetricsServer] Error processing ${req.method} ${req.originalUrl}:`, err.message);
      res.status(500).json({
        success: false,
        error: err.message || 'Error interno del servidor',
      });
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.port, this.config.host, () => {
        console.log(`[MetricsServer] Express REST API listening on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  async close() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('[MetricsServer] Express HTTP server closed.');
        resolve();
      });
    });
  }
}
