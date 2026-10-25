import express from 'express';
import cors from 'cors';
import { createHealthRoutes } from './modules/health/health.routes.js';
import { createWorldRoutes } from './modules/worlds/world.routes.js';
import { createHostRoutes } from './modules/hosts/host.routes.js';
import { createMessagingRoutes } from './modules/messaging/messaging.routes.js';
import { createAsyncWorldRoutes } from './modules/worlds/async-world.routes.js';
import { WorldLifecycleError } from './store/worldLifecycle.js';

/**
 * LobbyHttpServer: Stateless Express HTTP server mounting modular entity routers.
 */
export class LobbyHttpServer {
  /**
   * @param {object} config
   * @param {import('./store/IWorldRepository.js').IWorldRepository} repository
   * @param {import('./orchestrator/HostPlacementEngine.js').HostPlacementEngine} placementEngine
   * @param {import('./modules/messaging/AnnouncementPublisher.js').AnnouncementPublisher} announcementPublisher
   */
  constructor(config, repository, placementEngine, announcementPublisher) {
    this.config = config;
    this.repository = repository;
    this.placementEngine = placementEngine;
    this.announcementPublisher = announcementPublisher;
    this.app = createLobbyHttpApp(config, repository, placementEngine, announcementPublisher);
    this.server = null;
  }

  start(maxRetries = 10) {
    return new Promise((resolve, reject) => {
      let currentPort = this.config.port;
      let retriesLeft = maxRetries;

      const tryListen = () => {
        this.server = this.app.listen(currentPort, this.config.host, () => {
          this.config = { ...this.config, port: currentPort };
          console.log(`[LobbyServer] Express REST API listening on http://${this.config.host}:${currentPort}`);
          resolve();
        });

        this.server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
            console.warn(`[LobbyServer] Port ${currentPort} in use. Retrying on port ${currentPort + 1}...`);
            retriesLeft--;
            currentPort++;
            tryListen();
          } else {
            reject(err);
          }
        });
      };

      tryListen();
    });
  }

  async close() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('[LobbyServer] Express HTTP server closed.');
        resolve();
      });
    });
  }
}

/** Construct HTTP handlers without sockets, timers, migrations or process signals. */
export function createLobbyHttpApp(config, repository, placementEngine, announcementPublisher, options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Idempotency-Key'],
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(createHealthRoutes(repository));
  app.use(options.operationService
    ? createAsyncWorldRoutes(repository, options.operationService, options)
    : createWorldRoutes(repository, placementEngine, options));
  if (options.profile !== 'public') {
    app.use(createHostRoutes(repository, options.operationService ? null : placementEngine));
    app.use(createMessagingRoutes(announcementPublisher, config));
  }
  app.use((req, res) => res.status(404).json({ success: false, error: 'Ruta no encontrada' }));
  app.use((err, req, res, next) => {
    const databaseInputError = ['22P02', '22003', '23502', '23503', '23514'].includes(err.code);
    const status = err.statusCode || (err instanceof WorldLifecycleError || err.code === '23505' ? 409
      : err.code && !databaseInputError ? 503 : 400);
    console.warn(`[LobbyHTTP] ${req.method} ${req.path}: ${err.code || err.name}`);
    res.status(status).json({
      success: false,
      error: status >= 500 ? 'Servicio temporalmente no disponible' : err.message,
      ...(err.code && { code: err.code }),
      ...(err.operationId && { operationId: err.operationId }),
    });
  });
  return app;
}
