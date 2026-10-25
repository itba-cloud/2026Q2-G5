import { randomUUID, randomInt } from 'node:crypto';
import { OperationError } from './errors.js';

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OperationError('INVALID_INPUT', `${name} debe ser un entero entre ${min} y ${max}`, 400);
  }
  return value;
}

export class OperationService {
  constructor(worlds, operations, { dispatcher } = {}) {
    this.worlds = worlds;
    this.operations = operations;
    this.dispatcher = dispatcher;
  }

  async dispatchAccepted(op) {
    // RDS is the durable outbox. Failure after commit must not turn acceptance
    // into a new user intention; the scheduled sweep retries this same operation.
    if (this.dispatcher) {
      try { await this.dispatcher.dispatchOne(op.operation_id, { timeoutMs: 750 }); }
      catch (err) { console.warn(JSON.stringify({ event: 'operation.dispatch_deferred', operationId: op.operation_id, error: err.name })); }
    }
    return op;
  }

  async create(body = {}, options) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) {
      throw new OperationError('INVALID_INPUT', 'Nombre de mundo obligatorio (máximo 120 caracteres)', 400);
    }
    if (body.autoStart !== undefined && typeof body.autoStart !== 'boolean') {
      throw new OperationError('INVALID_INPUT', 'autoStart debe ser booleano', 400);
    }
    if (body.biome !== undefined && (typeof body.biome !== 'string' || body.biome.length > 40)) {
      throw new OperationError('INVALID_INPUT', 'Biome inválido', 400);
    }
    const payload = {
      name: body.name.trim(), biome: body.biome || 'forest', autoStart: body.autoStart !== false,
      seed: integer(body.seed, undefined, -2147483648, 2147483647, 'seed'),
      maxPlayers: integer(body.maxPlayers, 20, 1, 200, 'maxPlayers'),
      botCount: integer(body.botCount, 2, 0, 100, 'botCount'),
    };
    const create = { ...payload, id: `world-${randomUUID()}`, seed: payload.seed ?? randomInt(100000, 1000000) };
    if (!payload.autoStart) return { world: await this.worlds.createWorld(create) };
    return { operation: await this.dispatchAccepted(await this.operations.accept({ kind: 'START', create, payload, ...options })) };
  }

  async submit(kind, worldId, body = {}, options) {
    const payload = kind === 'START'
      ? { botCount: integer(body.botCount, undefined, 0, 100, 'botCount') }
      : kind === 'SELF_SHUTDOWN' ? { runtimeId: body.runtimeId || null }
        : { force: body.force === true };
    if (body.runtimeId && !/^[0-9a-f-]{36}$/i.test(body.runtimeId)) {
      throw new OperationError('INVALID_INPUT', 'runtimeId inválido', 400);
    }
    return this.dispatchAccepted(await this.operations.accept({ kind, worldId, payload, ...options }));
  }
}
