export class OperationError extends Error {
  constructor(code, message, statusCode = 409, operationId) {
    super(message);
    this.name = 'OperationError';
    Object.assign(this, { code, statusCode, operationId });
  }
}

export const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
export const LIVE = ['ACCEPTED', 'RUNNING', 'RECOVERY_PENDING'];

export function publicWorld(world) {
  if (!world) return null;
  const { reservationToken, reservationExpiresAt, portScope, hostId, containerId, ...safe } = world;
  return safe;
}

export function publicOperation(op) {
  return {
    id: op.operation_id,
    operationId: op.operation_id,
    worldId: op.target_world_id,
    type: op.kind,
    status: op.status,
    result: op.result,
    error: op.error,
    createdAt: op.created_at,
    updatedAt: op.updated_at,
  };
}
