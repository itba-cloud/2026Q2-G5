// Los campos de placement pertenecen a la reserva: un mundo o el cliente solo
// pueden reportar metricas por /worlds/:id/status, nunca reescribir estado, host,
// puerto, endpoint, contenedor ni token.
const EXTERNAL_WORLD_FIELDS = ['name', 'biome', 'playersCount', 'maxPlayers', 'botCount'];

/**
 * WorldController: Handles HTTP requests for world listing, on-demand starting, status updates, and shutdown.
 */
export class WorldController {
  /**
   * @param {import('../../store/IWorldRepository.js').IWorldRepository} repository
   * @param {import('../../orchestrator/HostPlacementEngine.js').HostPlacementEngine} placementEngine
   */
  constructor(repository, placementEngine) {
    this.repository = repository;
    this.placementEngine = placementEngine;
  }

  listWorlds = async (req, res, next) => {
    try {
      await this.placementEngine.reconcileWorldStates();
      const worlds = await this.repository.listWorlds();
      res.json({
        success: true,
        count: worlds.length,
        worlds,
      });
    } catch (err) {
      next(err);
    }
  };

  getWorld = async (req, res, next) => {
    try {
      await this.placementEngine.reconcileWorldStates();
      const world = await this.repository.getWorld(req.params.id);
      if (!world) {
        return res.status(404).json({ success: false, error: 'Mundo no encontrado' });
      }
      res.json({ success: true, world });
    } catch (err) {
      next(err);
    }
  };

  createWorld = async (req, res, next) => {
    try {
      const newWorld = await this.placementEngine.createAndDeployWorld(req.body);
      res.status(201).json({
        success: true,
        world: newWorld,
        worldId: newWorld.id,
        wsUrl: newWorld.wsUrl,
      });
    } catch (err) {
      next(err);
    }
  };

  startWorld = async (req, res, next) => {
    try {
      const worldId = req.params.id;
      const botCount = req.body?.botCount !== undefined ? Number(req.body.botCount) : null;
      const startedWorld = await this.placementEngine.startWorld(worldId, botCount);
      res.json({
        success: true,
        world: startedWorld,
        worldId: startedWorld.id,
        wsUrl: startedWorld.wsUrl,
      });
    } catch (err) {
      next(err);
    }
  };

  stopWorld = async (req, res, next) => {
    try {
      const worldId = req.params.id;
      const stoppedWorld = await this.placementEngine.stopWorld(worldId);
      if (!stoppedWorld) {
        return res.status(404).json({ success: false, error: 'Mundo no encontrado' });
      }
      res.json({
        success: true,
        world: stoppedWorld,
      });
    } catch (err) {
      next(err);
    }
  };

  updateWorldStatus = async (req, res, next) => {
    try {
      const worldId = req.params.id;
      const requestedStatus = req.body?.status;

      // If client or service asks to switch to ACTIVE, start container if not already active
      if (requestedStatus === 'ACTIVE') {
        const started = await this.placementEngine.startWorld(worldId);
        return res.json({ success: true, world: started });
      }

      if (requestedStatus === 'INACTIVE') {
        const stopped = await this.placementEngine.stopWorld(worldId);
        return res.json({ success: true, world: stopped });
      }

      if (requestedStatus === 'STARTING' || requestedStatus === 'STOPPING') {
        return res.status(400).json({
          success: false,
          error: 'Los estados de transicion los asigna el Lobby y no pueden fijarse desde afuera.',
        });
      }

      const updates = {};
      for (const field of EXTERNAL_WORLD_FIELDS) {
        if (req.body?.[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      const updated = await this.repository.updateWorld(worldId, updates);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Mundo no encontrado' });
      }
      res.json({ success: true, world: updated });
    } catch (err) {
      next(err);
    }
  };

  shutdownWorld = async (req, res, next) => {
    try {
      const worldId = req.params.id;
      const stoppedWorld = await this.placementEngine.releaseSelfStoppedWorld(worldId, req.body?.runtimeId || null);
      if (!stoppedWorld) {
        return res.status(404).json({ success: false, error: 'Mundo no encontrado o ya detenido' });
      }
      res.json({
        success: true,
        world: stoppedWorld,
        message: `Mundo ${worldId} detenido por inactividad, contenedor eliminado y recursos liberados.`,
      });
    } catch (err) {
      next(err);
    }
  };

  deleteWorld = async (req, res, next) => {
    try {
      const deleted = await this.placementEngine.destroyAndDeprovisionWorld(req.params.id, req.body?.force ?? false);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Mundo no encontrado' });
      }
      res.json({ success: true, message: `Mundo ${req.params.id} eliminado.` });
    } catch (err) {
      next(err);
    }
  };
}
