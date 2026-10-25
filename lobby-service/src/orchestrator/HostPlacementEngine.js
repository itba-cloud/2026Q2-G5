import { DockerContainerLauncher, worldContainerName } from './DockerContainerLauncher.js';
import {
  RESERVATION_OUTCOME,
  STOP_OUTCOME,
  LIFECYCLE_ERROR_CODES,
  WorldLifecycleError,
} from '../store/worldLifecycle.js';
import { config } from '../config.js';

/**
 * HostPlacementEngine: Orchestrates the world container lifecycle on top of the
 * repository reservations, which pick host and port atomically before any Docker
 * call so concurrent requests cannot collide on a port or overrun a host.
 */
export class HostPlacementEngine {
  /**
   * @param {import('../store/IWorldRepository.js').IWorldRepository} repository
   * @param {DockerContainerLauncher} [dockerLauncher]
   */
  constructor(repository, dockerLauncher = null, customConfig = config) {
    this.repository = repository;
    this.config = customConfig;
    this.dockerLauncher = dockerLauncher || new DockerContainerLauncher();
    this.lastReconciliationTime = 0;
    this.reconciliationInProgress = null;
  }

  /**
   * Probes the world service /health HTTP endpoint until it becomes ready.
   * @param {object} host Host node object
   * @param {number} port Assigned world port
   * @param {number} [timeoutMs=5000] Maximum wait time
   * @param {number} [intervalMs=50] Polling interval
   * @returns {Promise<boolean>}
   */
  async _waitForWorldReady(host, port, timeoutMs = 5000, intervalMs = 50) {
    const isMock = this.dockerLauncher && typeof this.dockerLauncher.isMockMode === 'function' && this.dockerLauncher.isMockMode();
    const targetHost = host.hostIp === '0.0.0.0' || host.hostIp === '127.0.0.1' ? '127.0.0.1' : (host.hostIp || 'localhost');
    const healthUrl = `http://${targetHost}:${port}/health`;
    const startTime = Date.now();

    console.log(`[HostPlacement] Probing world readiness at ${healthUrl} (timeout: ${timeoutMs}ms)...`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const res = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(300),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && (data.isReady || data.status === 'ok')) {
            const elapsed = Date.now() - startTime;
            console.log(`[HostPlacement] World on ${targetHost}:${port} is READY and healthy (responded in ${elapsed}ms).`);
            return true;
          }
        }
      } catch {
        // Container / HTTP server still booting, retry after interval
      }

      // If running in pure mock test mode without a real background node process, allow fast fallback
      if (isMock && Date.now() - startTime >= 150) {
        console.log(`[HostPlacement:MOCK] World readiness probe bypassed for mock test environment.`);
        return true;
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    if (isMock) {
      return true;
    }

    throw new Error(`El servidor del mundo en ${targetHost}:${port} no respondió al readiness probe tras ${timeoutMs}ms.`);
  }

  /**
   * Removes the container a reservation created and frees its host and port.
   * If the container cannot be removed the world is left in its transitional
   * state so a later reconciliation retries instead of leaking a live container.
   * @param {object} host Host node object
   * @param {string} worldId
   * @param {string} token Reservation token that owns the world
   * @param {object|null} [launchResult] Result of the launch, when it got that far
   * @returns {Promise<object|null>} Released world record, or null if kept for reconciliation
   */
  async _releaseReservation(host, worldId, token, launchResult = null) {
    const containerTarget = launchResult?.containerId || worldContainerName(worldId, token);
    const isRemoved = await this.dockerLauncher.stopWorldContainer(host, containerTarget);

    if (!isRemoved) {
      console.warn(`[HostPlacement] Could not remove container "${containerTarget}" for world "${worldId}". Leaving it for reconciliation.`);
      return null;
    }

    return this.repository.failWorldStart(worldId, token);
  }

  /**
   * Starts and activates an existing or inactive world, assigning host, port and container.
   * @param {string} worldId
   * @param {number} [overrideBotCount]
   * @returns {Promise<object>} Activated world record
   */
  async startWorld(worldId, overrideBotCount = null) {
    // 1. Reserve Host and Port Atomically (no Docker call inside the transaction)
    const reservation = await this.repository.reserveWorldStart(worldId);

    if (reservation.outcome === RESERVATION_OUTCOME.NOT_FOUND) {
      throw new Error(`El mundo "${worldId}" no existe.`);
    }

    // If already active with valid endpoint, return it
    if (reservation.outcome === RESERVATION_OUTCOME.ACTIVE) {
      return reservation.world;
    }

    if (reservation.outcome === RESERVATION_OUTCOME.STARTING) {
      throw new WorldLifecycleError(
        LIFECYCLE_ERROR_CODES.WORLD_STARTING,
        `El mundo "${worldId}" ya se esta iniciando.`
      );
    }
    if (reservation.outcome === RESERVATION_OUTCOME.STOPPING) {
      throw new WorldLifecycleError(
        LIFECYCLE_ERROR_CODES.WORLD_STOPPING,
        `El mundo "${worldId}" se esta deteniendo. Reintentar en unos segundos.`
      );
    }

    const { world, host, token } = reservation;
    let launchResult = null;

    try {
      // 2. Launch Container on the Host's Docker Daemon, outside the transaction
      launchResult = await this.dockerLauncher.launchWorldContainer(host, {
        id: world.id,
        name: world.name,
        seed: world.seed,
        port: world.port,
        token,
      });

      // 3. Store the container id while still STARTING, so a takeover can find it
      await this.repository.attachWorldContainer(worldId, token, launchResult.containerId);

      // 4. Verify World Readiness via HTTP Health Probe (Wait until online)
      await this._waitForWorldReady(host, world.port);
    } catch (err) {
      console.error(`[HostPlacement] Failed to spin up/verify container for world "${worldId}":`, err.message);
      await this._releaseReservation(host, worldId, token, launchResult);
      throw err;
    }

    const botsToSpawn = typeof overrideBotCount === 'number'
      ? overrideBotCount
      : (typeof world.botCount === 'number' ? world.botCount : (world.isDefault ? 2 : 0));

    // 5. Confirm STARTING -> ACTIVE, which only the winning token may do. NPC
    // replicas pick the world up from the bot count stored with it.
    const activeWorld = await this.repository.completeWorldStart(worldId, token, { ...launchResult, npcBotCount: botsToSpawn });

    if (!activeWorld) {
      console.warn(`[HostPlacement] Reservation for world "${worldId}" was taken over while its container was booting. Rolling back.`);
      await this._releaseReservation(host, worldId, token, launchResult);
      throw new WorldLifecycleError(
        LIFECYCLE_ERROR_CODES.WORLD_STOPPING,
        `El inicio del mundo "${worldId}" fue cancelado por una solicitud de parada.`
      );
    }

    console.log(`[HostPlacement] World "${world.name}" (${worldId}) started on host ${host.id} -> ${launchResult.wsUrl}`);

    return activeWorld;
  }

  /**
   * Stops an active world container and frees host capacity without deleting world metadata.
   * @param {string} worldId
   * @returns {Promise<object|null>}
   */
  async stopWorld(worldId) {
    // 1. Claim the stop before touching Docker
    const claim = await this.repository.beginWorldStop(worldId);
    if (claim.outcome === STOP_OUTCOME.NOT_FOUND) return null;

    if (claim.outcome === STOP_OUTCOME.INACTIVE) {
      return claim.world;
    }

    // The start worker still owns the container: it notices the takeover on its
    // next write, cleans up and leaves the world INACTIVE by itself.
    if (claim.outcome === STOP_OUTCOME.PENDING) {
      console.log(`[HostPlacement] Stop requested while world "${worldId}" was still starting. Marked as pending stop.`);
      return claim.world;
    }

    if (claim.outcome === STOP_OUTCOME.STOPPING) {
      console.log(`[HostPlacement] World "${worldId}" is already being stopped by another request.`);
      return claim.world;
    }

    const world = claim.world;
    const host = world.hostId ? await this.repository.getHost(world.hostId) : null;

    // 2. Stop and remove Container
    if (host) {
      const containerTarget = world.containerId || worldContainerName(world.id);
      const isRemoved = await this.dockerLauncher.stopWorldContainer(host, containerTarget);

      if (!isRemoved) {
        return this.repository.getWorld(worldId);
      }
    }

    if (world.hostId && !host) return this.repository.getWorld(worldId);

    // 3. Reset World to INACTIVE with the claiming token
    const updatedWorld = await this.repository.completeWorldStop(worldId, claim.token);

    console.log(`[HostPlacement] World "${worldId}" stopped, container removed, and returned to INACTIVE.`);
    return updatedWorld || this.repository.getWorld(worldId);
  }

  /**
   * Releases a world that reported its own shutdown. The container is already
   * exiting, so the Lobby only reaps it and frees the slot.
   * @param {string} worldId
   * @returns {Promise<object|null>}
   */
  async releaseSelfStoppedWorld(worldId, runtimeId = null) {
    const claim = await this.repository.beginWorldStop(worldId, { runtimeId, enforceRuntime: true });
    if (claim.outcome === STOP_OUTCOME.NOT_FOUND) return null;

    if (claim.outcome !== STOP_OUTCOME.CLAIMED) {
      return claim.world;
    }

    const world = claim.world;
    const host = world.hostId ? await this.repository.getHost(world.hostId) : null;

    if (host) {
      const containerTarget = world.containerId || worldContainerName(world.id);
      if (!await this.dockerLauncher.removeWorldContainer(host, containerTarget)) return this.repository.getWorld(worldId);
    }

    if (world.hostId && !host) return this.repository.getWorld(worldId);
    const releasedWorld = await this.repository.completeWorldStop(worldId, claim.token);

    console.log(`[HostPlacement] World "${worldId}" reported its own shutdown; container reaped and slot released.`);
    return releasedWorld || this.repository.getWorld(worldId);
  }

  /**
   * Reclaims reservations whose lease expired because the worker that owned them
   * died before confirming. Removes the container that reservation created, if
   * any, and frees its host and port.
   * @returns {Promise<number>} Number of reclaimed reservations
   */
  async recoverExpiredWorldStarts() {
    let reclaimedCount = 0;

    try {
      const expiredReservations = await this.repository.listExpiredWorldStarts();

      for (const { world, token } of expiredReservations) {
        const host = world.hostId ? await this.repository.getHost(world.hostId) : null;

        if (host) {
          const containerTarget = world.containerId || worldContainerName(world.id, token);
          try {
            if (!await this.dockerLauncher.stopWorldContainer(host, containerTarget)) continue;
          } catch (err) {
            console.warn(`[HostPlacement:Reconciliation] Warning stopping expired container for world "${world.id}":`, err.message);
            continue;
          }
        }

        if (world.hostId && !host) continue;
        // Release only after confirmed retirement.
        if (await this.repository.failWorldStart(world.id, token)) {
          reclaimedCount++;
          console.log(`[HostPlacement:Reconciliation] Expired ${world.status} reservation for world "${world.id}" reclaimed. Host and port released.`);
        }
      }
    } catch (err) {
      console.warn('[HostPlacement:Reconciliation] Expired reservation sweep warning:', err.message);
    }

    return reclaimedCount;
  }

  /**
   * Evaluates host fleet health based on heartbeat timestamps.
   * If a host has missed heartbeats, marks it UNHEALTHY and frees its active/starting worlds.
   * If an ephemeral host has been dead for > pruneTimeoutMs, deletes it from the fleet.
   * @param {number} [heartbeatTimeoutMs=90000]
   * @param {number} [pruneTimeoutMs=300000]
   * @returns {Promise<void>}
   */
  async reconcileHostFleet(heartbeatTimeoutMs = 90000, pruneTimeoutMs = 300000) {
    try {
      const hosts = await this.repository.listHosts();
      const now = Date.now();

      for (const host of hosts) {
        try {
          if (!host.lastHeartbeat) continue;
          const lastHb = new Date(host.lastHeartbeat).getTime();
          if (isNaN(lastHb)) continue;

          const ageMs = now - lastHb;

          if (ageMs > heartbeatTimeoutMs) {
            if (host.status !== 'DOWN') {
              console.warn(`[HostPlacement:HostFleet] Host "${host.id}" missed heartbeats (${Math.round(ageMs / 1000)}s ago). Marking DOWN.`);
              await this.repository.updateHostStatus(host.id, 'DOWN');
            }

            // Missing heartbeats do not prove the host stopped executing worlds.
            // Keep occupied slots until Docker retirement can be verified.
            const placed = await this.repository.listWorlds({ hostId: host.id });
            if (ageMs > pruneTimeoutMs && !placed.some(w => w.hostId)) {
              await this.repository.deleteHost(host.id);
            }
          }
        } catch (hostErr) {
          console.warn(`[HostPlacement:HostFleet] Error reconciling host "${host.id}":`, hostErr.message);
        }
      }
    } catch (err) {
      console.warn('[HostPlacement:HostFleet] Host fleet reconciliation error:', err.message);
    }
  }

  /**
   * Reconciles database world records with real Docker container and host status.
   * Runs host fleet sweep, recovers expired reservations, and verifies active containers in parallel.
   * @param {object} [options]
   * @param {boolean} [options.force=false]
   * @returns {Promise<void>}
   */
  async reconcileWorldStates({ force = false } = {}) {
    // Throttle on-demand reconciliations (at most once every 3000ms unless forced)
    const now = Date.now();
    if (this.config.reconcileOnRead === false && !force) return;
    if (!force && now - this.lastReconciliationTime < 3000) {
      return;
    }

    if (this.reconciliationInProgress) {
      return this.reconciliationInProgress;
    }

    this.reconciliationInProgress = (async () => {
      try {
        // 1. Sweep host fleet health (missed heartbeats -> mark DOWN & free worlds)
        await this.reconcileHostFleet();

        // 2. Reclaim expired reservations
        await this.recoverExpiredWorldStarts();

        // 3. Reconcile placed worlds against Docker and host health
        const allWorlds = await this.repository.listWorlds();
        const placedWorlds = allWorlds.filter((w) => ['ACTIVE', 'STARTING', 'STOPPING'].includes(w.status));

        if (placedWorlds.length > 0) {
          // Pre-fetch host records
          const hostCache = new Map();
          for (const w of placedWorlds) {
            if (w.hostId && !hostCache.has(w.hostId)) {
              hostCache.set(w.hostId, await this.repository.getHost(w.hostId));
            }
          }

          // Check containers and host health in parallel
          await Promise.allSettled(placedWorlds.map(async (world) => {
            if (!world.hostId) return;
            const host = hostCache.get(world.hostId);

            if (!host || host.status !== 'HEALTHY') {
              console.log(`[HostPlacement:Reconciliation] World "${world.id}" is assigned to non-healthy/dead host "${world.hostId}". Retaining placement until retirement can be verified.`);
              // Leave placement occupied: a network partition is not proof of deletion.
              return;
            }

            if (world.status === 'ACTIVE') {
              const containerTarget = world.containerId || worldContainerName(world.id);
              const containerStatus = await this.dockerLauncher.getContainerStatus(host, containerTarget);

              if (containerStatus.hostUnreachable) {
                console.warn(`[HostPlacement:Reconciliation] Host "${host.id}" is unreachable. Marking DOWN and retaining unverified placement.`);
                await this.repository.updateHostStatus(host.id, 'DOWN');
                // Keep the world and its port reserved until Docker is reachable.
                return;
              }

              if (!containerStatus.exists || !containerStatus.running) {
                console.log(`[HostPlacement:Reconciliation] Container for world "${world.id}" is ${containerStatus.status}. Reconciling database to INACTIVE.`);
                await this.stopWorld(world.id);
              }
            }
          }));
        }

        this.lastReconciliationTime = Date.now();
      } catch (err) {
        console.warn('[HostPlacement:Reconciliation] Reconciliation loop warning:', err.message);
      } finally {
        this.reconciliationInProgress = null;
      }
    })();

    return this.reconciliationInProgress;
  }

  /**
   * Creates a new world in the catalog and optionally starts it.
   * @param {object} params
   * @param {string} params.name
   * @param {number} [params.seed]
   * @param {string} [params.biome='forest']
   * @param {number} [params.maxPlayers=20]
   * @param {number} [params.botCount=2]
   * @param {boolean} [params.autoStart=true]
   * @returns {Promise<object>} Created world record
   */
  async createAndDeployWorld({ name, seed, biome = 'forest', maxPlayers = 20, botCount = 2, autoStart = true }) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('El nombre del mundo es obligatorio');
    }

    const cleanName = name.trim();
    const slug = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'world';

    const timestamp = Date.now().toString(36);
    const worldId = `${slug}-${timestamp}`;
    const assignedSeed = typeof seed === 'number' && !isNaN(seed) ? Math.floor(seed) : Math.floor(Math.random() * 900000) + 100000;
    const assignedBots = typeof botCount === 'number' && !isNaN(botCount) && botCount >= 0 ? Math.floor(botCount) : 2;

    // 1. Create world as INACTIVE in Database
    const initialWorld = await this.repository.createWorld({
      id: worldId,
      name: cleanName,
      status: 'INACTIVE',
      seed: assignedSeed,
      hostId: null,
      port: null,
      wsUrl: null,
      containerId: null,
      playersCount: 0,
      maxPlayers,
      botCount: assignedBots,
      biome,
      isDefault: false,
    });

    if (!autoStart) {
      return initialWorld;
    }

    // 2. Start World Container
    try {
      return await this.startWorld(worldId, assignedBots);
    } catch (err) {
      console.error(`[HostPlacement] Auto-start failed for new world "${worldId}". World remains INACTIVE.`);
      throw err;
    }
  }

  /**
   * Deprovisions and stops a world container, freeing host capacity and removing dynamic world.
   * @param {string} worldId
   * @param {boolean} [force=false]
   * @returns {Promise<boolean>}
   */
  async destroyAndDeprovisionWorld(worldId, force = false) {
    const world = await this.repository.getWorld(worldId);
    if (!world) return false;

    if (world.isDefault && !force) {
      throw new Error('No se puede eliminar el mundo por defecto');
    }

    // 1. Stop container and release host load
    const stopped = await this.stopWorld(worldId);

    // A world still in transition keeps its reservation, so deleting the row now
    // would orphan the container that reservation owns.
    if (stopped && stopped.status !== 'INACTIVE') {
      throw new WorldLifecycleError(
        LIFECYCLE_ERROR_CODES.WORLD_STOPPING,
        `El mundo "${worldId}" se esta deteniendo. Reintentar la eliminacion en unos segundos.`
      );
    }

    // 2. Delete world record if not default
    if (!world.isDefault || force) {
      await this.repository.deleteWorld(worldId);
    }

    console.log(`[HostPlacement] World "${worldId}" despawned and cleaned up.`);
    return true;
  }
}
