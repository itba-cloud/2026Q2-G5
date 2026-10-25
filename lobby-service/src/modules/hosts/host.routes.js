import { Router } from 'express';
import { HostController } from './host.controller.js';

/**
 * Creates and configures routes for the Host entity.
 * @param {import('../../store/IWorldRepository.js').IWorldRepository} repository
 * @returns {Router}
 */
export function createHostRoutes(repository, placementEngine = null) {
  const router = Router();
  const controller = new HostController(repository, placementEngine);

  // 1. List Hosts
  router.get('/hosts', controller.listHosts);
  router.get('/api/hosts', controller.listHosts);

  // 2. Host Heartbeat / Registration
  router.post('/hosts/heartbeat', controller.registerHostHeartbeat);
  router.post('/api/hosts/heartbeat', controller.registerHostHeartbeat);

  return router;
}
