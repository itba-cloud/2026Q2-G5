/**
 * HealthController: Handles system health check and status probes.
 */
export class HealthController {
  constructor(repository) {
    this.repository = repository;
  }

  getHealth = async (req, res, next) => {
    try {
      const worlds = await this.repository.listWorlds();
      const hosts = await this.repository.listHosts();
      const activeWorldsCount = worlds.filter((w) => w.status === 'ACTIVE').length;

      res.json({
        status: 'ok',
        service: 'lobby-service',
        timestamp: new Date().toISOString(),
        activeWorldsCount,
        totalWorldsCount: worlds.length,
        activeHostsCount: hosts.length,
      });
    } catch (err) {
      next(err);
    }
  };
}
