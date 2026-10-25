import { Router } from 'express';
import { OperationError, publicOperation, publicWorld } from '../../lifecycle/errors.js';

export function createWorldApiRoutes(repository, service, { profile = 'internal' } = {}) {
  const router = Router();
  const visibility = profile === 'public' ? 'public' : 'internal';
  const present = visibility === 'public' ? publicWorld : world => world;
  const options = req => ({ key: req.get('Idempotency-Key') || undefined, visibility });
  const route = (method, path, handler) => {
    for (const prefix of ['', '/api']) router[method](`${prefix}${path}`, (req, res, next) => {
      Promise.resolve().then(() => handler(req, res)).catch(next);
    });
  };
  const accepted = (res, op) => res.status(202).json({
    success: true, operationId: op.operation_id, worldId: op.target_world_id, status: op.status,
  });
  route('get', '/operations/:id', async (req, res) => {
    const op = await service.operations.get(req.params.id);
    if (!op || (visibility === 'public' && op.visibility !== 'public')) {
      throw new OperationError('OPERATION_NOT_FOUND', 'Operación no encontrada', 404);
    }
    if (op.status === 'ACCEPTED') await service.dispatchAccepted(op);
    res.json({ success: true, operation: publicOperation(op) });
  });
  route('get', '/worlds', async (req, res) => {
    const worlds = (await repository.listWorlds()).map(present);
    res.json({ success: true, count: worlds.length, worlds });
  });
  route('get', '/worlds/:id', async (req, res) => {
    const world = await repository.getWorld(req.params.id);
    if (!world) throw new OperationError('WORLD_NOT_FOUND', 'Mundo no encontrado', 404);
    res.json({ success: true, world: present(world) });
  });
  route('post', '/worlds', async (req, res) => {
    const result = await service.create(req.body, options(req));
    if (result.operation) return accepted(res, result.operation);
    res.status(201).json({ success: true, world: publicWorld(result.world), worldId: result.world.id });
  });
  route('post', '/worlds/:id/start', async (req, res) => {
    accepted(res, await service.submit('START', req.params.id, req.body, options(req)));
  });
  return router;
}
