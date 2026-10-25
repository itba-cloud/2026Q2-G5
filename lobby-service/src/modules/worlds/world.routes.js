import { Router } from 'express';
import { WorldController } from './world.controller.js';

/**
 * Creates and configures routes for the World entity.
 * @param {import('../../store/IWorldRepository.js').IWorldRepository} repository
 * @param {import('../../orchestrator/HostPlacementEngine.js').HostPlacementEngine} placementEngine
 * @returns {Router}
 */
export function createWorldRoutes(repository, placementEngine) {
  const router = Router();
  const controller = new WorldController(repository, placementEngine);

  // 1. List Worlds
  router.get('/worlds', controller.listWorlds);
  router.get('/api/worlds', controller.listWorlds);

  // 2. Create World
  router.post('/worlds', controller.createWorld);
  router.post('/api/worlds', controller.createWorld);

  // 3. Get World Details
  router.get('/worlds/:id', controller.getWorld);
  router.get('/api/worlds/:id', controller.getWorld);

  // 4. On-Demand Start / Spin-up World Container
  router.post('/worlds/:id/start', controller.startWorld);
  router.post('/api/worlds/:id/start', controller.startWorld);

  // 5. Stop World Container
  router.post('/worlds/:id/stop', controller.stopWorld);
  router.post('/api/worlds/:id/stop', controller.stopWorld);

  // 6. Update World Status / Metrics
  router.post('/worlds/:id/status', controller.updateWorldStatus);
  router.put('/worlds/:id/status', controller.updateWorldStatus);
  router.post('/api/worlds/:id/status', controller.updateWorldStatus);

  // 7. World Self-Shutdown Notification (Despawn)
  router.post('/worlds/:id/shutdown', controller.shutdownWorld);
  router.post('/api/worlds/:id/shutdown', controller.shutdownWorld);

  // 8. Delete World
  router.delete('/worlds/:id', controller.deleteWorld);
  router.delete('/api/worlds/:id', controller.deleteWorld);

  return router;
}
