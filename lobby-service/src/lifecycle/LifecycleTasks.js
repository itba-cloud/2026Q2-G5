import { worldContainerName } from '../orchestrator/DockerContainerLauncher.js';
import { rowToWorld } from '../store/RdsWorldRepository.js';
import { portScopeForHost } from '../store/worldLifecycle.js';
import { OperationError, TERMINAL, publicWorld } from './errors.js';

export const ACTIONS = new Set(['reserve', 'launch', 'health', 'confirm', 'bots', 'claimStop', 'despawn', 'remove', 'release', 'delete', 'finish', 'cleanup', 'recordFailure', 'recovery']);

export class LifecycleTasks {
  constructor(worlds, operations, launcher, { config = {}, probe, now = Date.now } = {}) {
    Object.assign(this, { worlds, operations, launcher, config, now });
    this.probe = probe || (async (host, world) => {
      if (launcher.isMockMode()) return true;
      const target = host.hostIp === '0.0.0.0' ? '127.0.0.1' : host.hostIp;
      try {
        const res = await fetch(`http://${target}:${world.port}/health`, { signal: AbortSignal.timeout(2000) });
        const body = res.ok && await res.json();
        return Boolean(body && body.worldId === world.id && (body.isReady || body.status === 'ok'));
      } catch { return false; }
    });
  }

  async invoke(action, operationId, options = {}) {
    if (!ACTIONS.has(action)) throw new OperationError('INVALID_ACTION', 'Acción desconocida', 400);
    const claim = await this.operations.claimTask(operationId, options);
    if (claim.terminal) return this.flags(claim.terminal);
    if (claim.deferred) return { operationId, recoveryPending: true, failed: true };
    const { token } = claim;
    console.log(JSON.stringify({ event: 'lifecycle.task', operationId, action }));
    try {
      return { operationId, ...await this[action](operationId, token) };
    } finally {
      await this.operations.releaseTask(operationId, token);
    }
  }

  flags(op) {
    return { operationId: op.operation_id, done: TERMINAL.has(op.status),
      failed: ['FAILED', 'CANCELLED'].includes(op.status), recoveryPending: op.status === 'RECOVERY_PENDING' };
  }

  async context(id, token, mutate) {
    return this.operations.taskWrite(id, token, async (client, op, world) => {
      const result = await mutate(client, op, world);
      await client.query(`UPDATE lobby_operations SET context=$3,updated_at=now() WHERE operation_id=$1 AND task_token=$2`, [id, token, op.context]);
      return result;
    });
  }

  async failure(id, token, code, recovery = false) {
    await this.operations.taskWrite(id, token, async (client, op) => {
      await client.query(`UPDATE lobby_operations SET error=$3,
        status=CASE WHEN $4 THEN 'RECOVERY_PENDING' ELSE status END,updated_at=now()
        WHERE operation_id=$1 AND task_token=$2`, [id, token, { code, message: this.message(code) }, recovery]);
    });
    return { failed: true, recoveryPending: recovery };
  }

  message(code) {
    return ({ NO_CAPACITY: 'No hay capacidad disponible para iniciar el mundo', CANCELLED: 'Inicio cancelado por una parada',
      HEALTH_TIMEOUT: 'El mundo no estuvo listo dentro del plazo', TASK_STOPPED: 'El contenedor del mundo terminó antes de estar listo',
      CLEANUP_PENDING: 'Esperando verificar la retirada del contenedor',
      WORKFLOW_INTERRUPTED: 'La operación fue interrumpida y requiere recuperación' })[code] || 'No se pudo completar la operación del mundo';
  }

  async reserve(id, token) {
    try {
      const existing = await this.ensureExisting(id, token);
      if (existing) return existing;
      return await this.context(id, token, async (client, op, world) => {
        if (op.cancel_requested) return { failed: true };
        if (new Date(op.deadline_at) < new Date()) throw new OperationError('OPERATION_EXPIRED', 'La operación venció');
        if (!world) throw new OperationError('WORLD_NOT_FOUND', 'Mundo inexistente');
        if (op.context.phase) return { active: op.context.phase === 'ACTIVE' };
        if (world.status === 'ACTIVE') {
          throw new OperationError('WORLD_TRANSITION', 'El mundo cambió durante la comprobación');
        }
        if (world.status !== 'INACTIVE') throw new OperationError('WORLD_TRANSITION', 'Mundo en transición');
        // Fargate tasks get their own ENI: no host capacity nor port scope to reserve.
        let hostId = null, scope = null, port = this.launcher.port;
        if (this.launcher.requiresHost !== false) {
          const host = await this.worlds._lockHostWithCapacity(client);
          scope = portScopeForHost(host);
          port = await this.worlds._findFreePortInScope(client, host, scope);
          hostId = host.id;
        }
        await client.query(`UPDATE worlds SET status='STARTING',host_id=$2,port=$3,port_scope=$4,
          runtime_id=$5::uuid,reservation_token=$5::text,reservation_expires_at=$6,ws_url=NULL,container_id=NULL,updated_at=now()
          WHERE world_id=$1`, [world.world_id, hostId, port, scope, id, op.deadline_at]);
        op.context = { phase: 'RESERVED', token: id, runtimeId: id, hostId,
          port, healthDeadline: this.now() + (this.config.healthTimeoutMs || 30000) };
        return { active: false };
      });
    } catch (err) {
      if (err instanceof OperationError) return this.failure(id, token, err.code);
      if (/capacidad|nodos host|puertos agotado/i.test(err.message)) return this.failure(id, token, 'NO_CAPACITY');
      throw err;
    }
  }

  async ensureExisting(id, token) {
    const initial = await this.snapshot(id, token);
    if (initial.op.cancel_requested) return { failed: true };
    if (new Date(initial.op.deadline_at) < new Date()) return this.failure(id, token, 'OPERATION_EXPIRED');
    if (!initial.op.context.phase && initial.world?.status === 'ACTIVE') {
      await this.context(id, token, async (client, op, world) => {
        if (world.status !== 'ACTIVE' || op.context.phase) return;
        // Take ownership before network I/O. STOP and other joins use the same
        // durable operation lock; no DB transaction spans a Docker request.
        op.context = { phase: 'VERIFYING', restartingExisting: true, token: id,
          runtimeId: world.runtime_id, hostId: world.host_id, containerId: world.container_id, port: world.port };
        await client.query(`UPDATE worlds SET status='STOPPING',reservation_token=$2,
          reservation_expires_at=$3,updated_at=now() WHERE world_id=$1`, [world.world_id, id, op.deadline_at]);
      });
    }
    const { op, world } = await this.snapshot(id, token);
    if (!op.context.restartingExisting || op.context.phase === 'ACTIVE') return null;
    if (op.context.phase !== 'RELEASED' && !this.owns(op, world)) return this.failure(id, token, 'OWNERSHIP_LOST', true);
    if (op.context.phase === 'VERIFYING') {
      const host = await this.placement(op.context.hostId);
      if (!host || !op.context.containerId) return this.failure(id, token, 'CLEANUP_PENDING', true);
      const status = await this.launcher.getContainerStatus(host, op.context.containerId);
      if (status.privateIp) host.hostIp = status.privateIp;
      if (status.hostUnreachable || status.status === 'unknown') return this.failure(id, token, 'HOST_UNAVAILABLE', true);
      if (status.exists && !this.launcher.isMockMode() &&
          (status.labels?.['elastic-worlds.world-id'] !== world.world_id ||
           (op.context.runtimeId && status.labels?.['elastic-worlds.reservation-token'] !== op.context.runtimeId))) {
        return this.failure(id, token, 'CONTAINER_IDENTITY_MISMATCH', true);
      }
      const healthy = status.exists && status.running &&
        (await this.probe(host, rowToWorld(world)) || await this.probe(host, rowToWorld(world)));
      if (healthy) {
        return this.context(id, token, async (client, current, currentWorld) => {
          if (current.cancel_requested || !this.owns(current, currentWorld)) return { failed: true };
          if (!currentWorld.ws_url) return { failed: true };
          await client.query(`UPDATE worlds SET status='ACTIVE',reservation_token=NULL,
            reservation_expires_at=NULL,updated_at=now() WHERE world_id=$1`, [currentWorld.world_id]);
          current.context = { phase: 'ACTIVE', alreadyActive: true, runtimeId: currentWorld.runtime_id };
          return { active: true };
        });
      }
    }
    if (op.context.phase !== 'RELEASED') {
      const result = await this.remove(id, token);
      if (!result.removed) return { ...result, failed: true };
      await this.release(id, token);
    }
    await this.context(id, token, async (client, current) => { current.context = {}; });
    return null; // The same START now reserves capacity for its new runtime.
  }

  owns(op, world) {
    return world && op.context.token && world.reservation_token === op.context.token &&
      (world.runtime_id || null) === (op.context.runtimeId || null);
  }

  /**
   * Docker worlds live on a registered host. Fargate tasks have no host: the
   * launcher ignores it and the probe targets the task's own private IP.
   */
  async placement(hostId, hostIp = null) {
    if (this.launcher.requiresHost === false) return { id: 'fargate', hostIp };
    return hostId ? this.worlds.getHost(hostId) : null;
  }

  async snapshot(id, token) {
    return this.operations.taskWrite(id, token, async (client, op, world) => ({ op, world }));
  }

  async launch(id, token) {
    const { op, world } = await this.snapshot(id, token);
    if (op.cancel_requested || !this.owns(op, world)) return { failed: true };
    if (op.context.phase === 'LAUNCHED') return {};
    const host = await this.placement(op.context.hostId);
    if (!host) return this.failure(id, token, 'HOST_UNAVAILABLE', true);
    let result;
    try {
      result = await this.launcher.launchWorldContainer(host, {
        id: world.world_id, name: world.name, seed: world.seed, port: world.port,
        token: op.context.token, runtimeId: op.context.runtimeId, waitForPort: false,
      });
    } catch (err) {
      // The operation only stores a code; the reason (e.g. AccessDenied on RunTask) lives in the logs.
      console.warn(JSON.stringify({ event: 'lifecycle.launch_failed', operationId: id, error: err.name, message: err.message }));
      return this.failure(id, token, 'DOCKER_LAUNCH_FAILED');
    }
    return this.context(id, token, async (client, current, currentWorld) => {
      if (!this.owns(current, currentWorld)) return { failed: true };
      current.context = { ...current.context, phase: 'LAUNCHED', ...result };
      await client.query('UPDATE worlds SET container_id=$2,updated_at=now() WHERE world_id=$1', [currentWorld.world_id, result.containerId]);
      return { failed: current.cancel_requested };
    });
  }

  async health(id, token) {
    const { op, world } = await this.snapshot(id, token);
    if (op.cancel_requested || !this.owns(op, world)) return { failed: true, ready: false };
    if (this.now() > op.context.healthDeadline) return { ...await this.failure(id, token, 'HEALTH_TIMEOUT'), ready: false };
    const host = await this.placement(op.context.hostId, op.context.privateIp);
    if (host && this.launcher.resolveEndpoint && !op.context.privateIp) {
      // Fargate assigns the task's addresses after RunTask; poll until its ENI is attached.
      const endpoint = await this.launcher.resolveEndpoint(op.context.containerId);
      if (endpoint.stopped) return { ...await this.failure(id, token, 'TASK_STOPPED'), ready: false };
      if (!endpoint.ready) return { ready: false, failed: false };
      await this.context(id, token, async (client, current) => {
        Object.assign(current.context, { privateIp: endpoint.privateIp, wsUrl: endpoint.wsUrl, internalWsUrl: endpoint.internalWsUrl });
      });
      host.hostIp = endpoint.privateIp;
    }
    return { ready: host ? await this.probe(host, rowToWorld(world)) : false, failed: false };
  }

  async confirm(id, token) {
    return this.context(id, token, async (client, op, world) => {
      if (op.context.phase === 'ACTIVE') return {};
      if (op.cancel_requested || !this.owns(op, world) || world.status !== 'STARTING') return { failed: true };
      // NPC replicas pick the world up from these columns (see npc_leases).
      await client.query(`UPDATE worlds SET status='ACTIVE',ws_url=$2,npc_ws_url=$3,npc_bot_count=$4,
        reservation_token=NULL,reservation_expires_at=NULL,updated_at=now() WHERE world_id=$1`,
      [world.world_id, op.context.wsUrl, op.context.internalWsUrl || op.context.wsUrl, op.request.botCount ?? world.bot_count]);
      op.context.phase = 'ACTIVE';
      return {};
    });
  }

  // NPC replicas claim the world from its npc_* columns (see confirm), and drop it
  // once it leaves ACTIVE. Executions that started on an older workflow version
  // still call these two actions, so they stay as no-ops for one release.
  async bots() {
    return {};
  }

  async claimStop(id, token) {
    return this.context(id, token, async (client, op, world) => {
      if (op.context.phase) return { waiting: false, released: op.context.phase === 'RELEASED' };
      const start = (await client.query(`SELECT operation_id FROM lobby_operations WHERE world_id=$1
        AND kind='START' AND status IN ('ACCEPTED','RUNNING','RECOVERY_PENDING') LIMIT 1`, [op.target_world_id])).rows[0];
      if (start) return { waiting: true };
      if (!world || world.status === 'INACTIVE') {
        op.context.phase = 'RELEASED';
        return { waiting: false, released: true };
      }
      if (world.status !== 'ACTIVE') return { waiting: true };
      if (op.kind === 'SELF_SHUTDOWN' && (op.request.runtimeId || null) !== (world.runtime_id || null)) {
        throw new OperationError('STALE_RUNTIME', 'Aviso de otra ejecución');
      }
      op.context = { phase: 'CLAIMED', token: id, runtimeId: world.runtime_id, hostId: world.host_id,
        containerId: world.container_id, port: world.port };
      await client.query(`UPDATE worlds SET status='STOPPING',reservation_token=$2,
        reservation_expires_at=$3,updated_at=now() WHERE world_id=$1`, [world.world_id, id, op.deadline_at]);
      return { waiting: false, released: false };
    });
  }

  async despawn() {
    return {};
  }

  async remove(id, token) {
    const { op, world } = await this.snapshot(id, token);
    if (['REMOVED', 'RELEASED'].includes(op.context.phase)) return { removed: true };
    if (!this.owns(op, world)) return this.failure(id, token, 'OWNERSHIP_LOST', true);
    const host = await this.placement(op.context.hostId);
    if (!host) return this.failure(id, token, 'CLEANUP_PENDING', true);
    const runtime = op.context.runtimeId || op.context.token;
    const target = op.context.containerId || world.container_id ||
      (this.launcher.containerRef ? this.launcher.containerRef(world.world_id, runtime) : worldContainerName(world.world_id, runtime));
    const status = await this.launcher.getContainerStatus(host, target);
    if (status.hostUnreachable || status.status === 'unknown') return this.failure(id, token, 'CLEANUP_PENDING', true);
    if (status.exists && !this.launcher.isMockMode() &&
        (status.labels?.['elastic-worlds.world-id'] !== world.world_id ||
          (op.context.runtimeId && status.labels?.['elastic-worlds.reservation-token'] !== op.context.runtimeId))) {
      return this.failure(id, token, 'CONTAINER_IDENTITY_MISMATCH', true);
    }
    let removed = !status.exists;
    if (!removed) {
      removed = op.kind === 'SELF_SHUTDOWN'
        ? await this.launcher.removeWorldContainer(host, target, 0)
        : await this.launcher.stopWorldContainer(host, target);
    }
    if (!removed) {
      // A stop workflow polls Remove again; a START cleanup has no such loop and
      // leaves the task to recovery. Fargate stops asynchronously after StopTask.
      const draining = op.kind !== 'START' && (this.launcher.stopsAsynchronously || (op.kind === 'SELF_SHUTDOWN' && status.running));
      if (draining && this.now() < new Date(op.deadline_at).getTime()) return { removed: false };
      return this.failure(id, token, 'CLEANUP_PENDING', true);
    }
    return this.context(id, token, async (client, current, currentWorld) => {
      if (!this.owns(current, currentWorld)) return { failed: true, recoveryPending: true };
      current.context.phase = 'REMOVED';
      return { removed: true };
    });
  }

  async release(id, token) {
    return this.context(id, token, async (client, op, world) => {
      if (op.context.phase === 'RELEASED') return {};
      if (op.context.phase !== 'REMOVED' || !this.owns(op, world)) throw new OperationError('UNVERIFIED_REMOVAL', 'Retirada no verificada');
      await client.query(`UPDATE worlds SET status='INACTIVE',host_id=NULL,port=NULL,port_scope=NULL,
        ws_url=NULL,npc_ws_url=NULL,npc_bot_count=0,container_id=NULL,players_count=0,reservation_token=NULL,
        reservation_expires_at=NULL,updated_at=now() WHERE world_id=$1`, [world.world_id]);
      op.context.phase = 'RELEASED';
      return {};
    });
  }

  async delete(id, token) {
    return this.context(id, token, async (client, op, world) => {
      if (op.kind !== 'DELETE' || !world) return {};
      if (op.context.phase !== 'RELEASED' || world.status !== 'INACTIVE') throw new OperationError('WORLD_TRANSITION', 'Mundo todavía ocupado');
      await client.query('DELETE FROM worlds WHERE world_id=$1', [world.world_id]);
      return {};
    });
  }

  async finish(id, token) {
    return this.operations.taskWrite(id, token, async (client, op, world) => {
      if (op.kind === 'START' && (op.context.phase !== 'ACTIVE' || world?.status !== 'ACTIVE' ||
          (world.runtime_id || null) !== (op.context.runtimeId || null))) throw new OperationError('NOT_ACTIVE', 'El mundo todavía no está activo');
      if (op.kind !== 'START' && op.context.phase !== 'RELEASED') throw new OperationError('NOT_RELEASED', 'El mundo todavía no está liberado');
      const result = { worldId: op.target_world_id, world: publicWorld(rowToWorld(world)),
        ...(op.kind === 'START' && { wsUrl: world.ws_url }),
        ...(op.context.warning && { warning: op.context.warning }) };
      await client.query(`UPDATE lobby_operations SET status='SUCCEEDED',result=$3,error=NULL,
        finished_at=now(),updated_at=now() WHERE operation_id=$1 AND task_token=$2`, [id, token, result]);
      return { done: true };
    });
  }

  async cleanup(id, token) {
    const { op, world } = await this.snapshot(id, token);
    if (op.context.phase === 'ACTIVE' && world?.status === 'ACTIVE' &&
        (world.runtime_id || null) === (op.context.runtimeId || null)) return this.finish(id, token);
    if (!op.context.token || op.context.phase === 'RELEASED') return { removed: true };
    const result = await this.remove(id, token);
    if (result.removed) await this.release(id, token);
    return result;
  }

  async recordFailure(id, token) {
    return this.operations.taskWrite(id, token, async (client, op) => {
      if (op.status === 'RECOVERY_PENDING' && op.context.token && op.context.phase !== 'RELEASED') return { recoveryPending: true, failed: true };
      const status = op.cancel_requested ? 'CANCELLED' : 'FAILED';
      const error = op.error || { code: op.cancel_requested ? 'CANCELLED' : 'WORKFLOW_FAILED', message: this.message(op.cancel_requested ? 'CANCELLED' : 'WORKFLOW_FAILED') };
      await client.query(`UPDATE lobby_operations SET status=$3,error=$4,finished_at=now(),updated_at=now()
        WHERE operation_id=$1 AND task_token=$2`, [id, token, status, error]);
      return { done: true, failed: true };
    });
  }

  async recovery(id, token) {
    return this.failure(id, token, 'WORKFLOW_INTERRUPTED', true);
  }
}
