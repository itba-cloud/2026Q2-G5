import { Router } from 'express';
import { HealthController } from './health.controller.js';

/**
 * Creates and configures health routes.
 * @param {import('../../store/IWorldRepository.js').IWorldRepository} repository
 * @returns {Router}
 */
export function createHealthRoutes(repository) {
  const router = Router();
  const controller = new HealthController(repository);

  router.get('/health', controller.getHealth);

  return router;
}
