/**
 * HostController: Handles fleet monitoring, load queries, and host heartbeats.
 */
export class HostController {
  /**
   * @param {import('../../store/IWorldRepository.js').IWorldRepository} repository
   * @param {import('../../orchestrator/HostPlacementEngine.js').HostPlacementEngine} [placementEngine]
   */
  constructor(repository, placementEngine = null) {
    this.repository = repository;
    this.placementEngine = placementEngine;
  }

  listHosts = async (req, res, next) => {
    try {
      if (this.placementEngine && this.placementEngine.config?.reconcileOnRead !== false) {
        await this.placementEngine.reconcileHostFleet();
      }
      const hosts = await this.repository.listHosts();
      res.json({
        success: true,
        count: hosts.length,
        hosts: hosts.map((h) => ({
          ...h,
          loadFactor: Math.round(((h.activeWorlds || 0) / (h.maxWorlds || 10)) * 100) / 100,
        })),
      });
    } catch (err) {
      next(err);
    }
  };

  registerHostHeartbeat = async (req, res, next) => {
    try {
      const host = await this.repository.registerHost(req.body);
      res.json({ success: true, host });
    } catch (err) {
      next(err);
    }
  };
}
