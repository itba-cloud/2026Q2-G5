/**
 * Shared vocabulary for the world start/stop lifecycle: reservation outcomes,
 * the error the HTTP layer maps to 409, and the port allocation scope.
 */

export const RESERVATION_OUTCOME = Object.freeze({
  RESERVED: 'RESERVED',
  ACTIVE: 'ACTIVE',
  STARTING: 'STARTING',
  STOPPING: 'STOPPING',
  NOT_FOUND: 'NOT_FOUND',
});

export const STOP_OUTCOME = Object.freeze({
  CLAIMED: 'CLAIMED',
  PENDING: 'PENDING',
  STOPPING: 'STOPPING',
  INACTIVE: 'INACTIVE',
  NOT_FOUND: 'NOT_FOUND',
});

export const LIFECYCLE_ERROR_CODES = Object.freeze({
  WORLD_STARTING: 'WORLD_STARTING',
  WORLD_STOPPING: 'WORLD_STOPPING',
});

/**
 * Raised when a request collides with a transition already in flight.
 */
export class WorldLifecycleError extends Error {
  /**
   * @param {string} code One of LIFECYCLE_ERROR_CODES
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WorldLifecycleError';
    this.code = code;
  }
}

const LOOPBACK_HOST_IPS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);

/**
 * Scope a port is unique within. Hosts bound to a loopback address all share the
 * developer's single Docker daemon, so they cannot hand out the same port twice.
 * @param {object} host Host node object
 * @returns {string}
 */
export function portScopeForHost(host) {
  return LOOPBACK_HOST_IPS.has(host.hostIp) ? 'loopback' : host.id;
}
