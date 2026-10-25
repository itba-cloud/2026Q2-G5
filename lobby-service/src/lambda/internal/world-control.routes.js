import { Router } from 'express';
import { OperationError, publicWorld } from '../../lifecycle/errors.js';

const REPORT_FIELDS = { name: 'name', biome: 'biome', playersCount: 'players_count', maxPlayers: 'max_players', botCount: 'bot_count' };

export function createWorldControlRoutes(repository, service) {
  const router = Router();
  const options = req => ({ key: req.get('Idempotency-Key') || undefined, visibility: 'internal' });
  const route = (method, path, handler) => {
    for (const prefix of ['', '/api']) router[method](`${prefix}${path}`, (req, res, next) => {
      Promise.resolve().then(() => handler(req, res)).catch(next);
    });
  };
  const accepted = (res, op) => res.status(202).json({
    success: true, operationId: op.operation_id, worldId: op.target_world_id, status: op.status,
  });
  for (const [method, path, kind] of [['post', 'stop', 'STOP'], ['post', 'shutdown', 'SELF_SHUTDOWN'], ['delete', '', 'DELETE']]) {
    route(method, `/worlds/:id${path && `/${path}`}`, async (req, res) => {
      accepted(res, await service.submit(kind, req.params.id, req.body, options(req)));
    });
  }
  for (const method of ['post', 'put']) route(method, '/worlds/:id/status', async (req, res) => {
    const body = req.body || {};
    if (['ACTIVE', 'INACTIVE'].includes(body.status)) {
      return accepted(res, await service.submit(body.status === 'ACTIVE' ? 'START' : 'STOP', req.params.id, body, options(req)));
    }
    if (body.status !== undefined) throw new OperationError('INVALID_STATUS', 'Estado reservado al Lobby', 400);
    const fields = Object.entries(REPORT_FIELDS).filter(([key]) => body[key] !== undefined);
    const values = [req.params.id, body.runtimeId || null, ...fields.map(([key]) => body[key])];
    const sets = fields.map(([, column], index) => `${column}=$${index + 3}`);
    const result = await repository.pool.query(`UPDATE worlds SET ${[...sets, 'updated_at=now()'].join(',')}
      WHERE world_id=$1 AND runtime_id IS NOT DISTINCT FROM $2::uuid RETURNING world_id`, values);
    if (!result.rowCount) throw new OperationError('STALE_RUNTIME', 'Mundo inexistente o aviso de otra ejecución');
    res.json({ success: true, world: publicWorld(await repository.getWorld(req.params.id)) });
  });
  return router;
}
