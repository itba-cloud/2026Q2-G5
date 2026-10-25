/**
 * MetricsController: Serves the observability and cost dashboard from the
 * snapshots produced by the telemetry store.
 */
export class MetricsController {
  /**
   * @param {{ getSnapshot(): Promise<object>, getHistory(limit?: number): Promise<object[]> }} telemetry
   */
  constructor(telemetry) {
    this.telemetry = telemetry;
  }

  getSnapshot = async (req, res, next) => {
    try {
      const snapshot = await this.telemetry.getSnapshot();
      res.json({ success: true, ...snapshot });
    } catch (err) {
      next(err);
    }
  };

  getHistory = async (req, res, next) => {
    try {
      const rawLimit = Number.parseInt(req.query.limit, 10);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
      res.json({
        success: true,
        points: await this.telemetry.getHistory(limit),
      });
    } catch (err) {
      next(err);
    }
  };

  getWorldMetrics = async (req, res, next) => {
    try {
      const snapshot = await this.telemetry.getSnapshot();
      const world = snapshot.worlds.find((w) => w.id === req.params.id);
      if (!world) {
        return res.status(404).json({ success: false, error: 'Mundo no encontrado' });
      }
      res.json({ success: true, timestamp: snapshot.timestamp, world });
    } catch (err) {
      next(err);
    }
  };

  getCosts = async (req, res, next) => {
    try {
      const snapshot = await this.telemetry.getSnapshot();
      res.json({
        success: true,
        timestamp: snapshot.timestamp,
        cost: snapshot.cost,
        hosts: snapshot.hosts,
        worlds: snapshot.worlds.map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          hostId: w.hostId,
          cost: w.cost,
          rightSizing: w.rightSizing,
        })),
        recommendations: snapshot.recommendations,
      });
    } catch (err) {
      next(err);
    }
  };
}
