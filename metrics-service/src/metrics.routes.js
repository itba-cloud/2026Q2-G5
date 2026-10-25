import { Router } from 'express';
import { MetricsController } from './metrics.controller.js';

/**
 * Creates and configures routes for the monitoring and cost dashboard.
 * @param {{ getSnapshot(): Promise<object>, getHistory(limit?: number): Promise<object[]> }} telemetry
 * @returns {Router}
 */
export function createMetricsRoutes(telemetry) {
  const router = Router();
  const controller = new MetricsController(telemetry);

  // 1. Full dashboard snapshot (fleet, hosts, worlds, cost, recommendations)
  router.get('/metrics', controller.getSnapshot);
  router.get('/api/metrics', controller.getSnapshot);

  // 2. Fleet time series
  router.get('/metrics/history', controller.getHistory);
  router.get('/api/metrics/history', controller.getHistory);

  // 3. Cost breakdown and right-sizing recommendations
  router.get('/metrics/costs', controller.getCosts);
  router.get('/api/metrics/costs', controller.getCosts);

  // 4. Per-world detail
  router.get('/metrics/worlds/:id', controller.getWorldMetrics);
  router.get('/api/metrics/worlds/:id', controller.getWorldMetrics);

  return router;
}
