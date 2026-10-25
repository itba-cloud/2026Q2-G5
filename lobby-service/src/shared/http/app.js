import express from 'express';
import cors from 'cors';
import { createHealthRoutes } from '../../modules/health/health.routes.js';
import { WorldLifecycleError } from '../../store/worldLifecycle.js';

export function createBaseApp(config, repository) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Idempotency-Key'],
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(createHealthRoutes(repository));
  return app;
}

export function finishApp(app) {
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
