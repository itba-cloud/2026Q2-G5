import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { IWorldRepository } from './IWorldRepository.js';
import { RESERVATION_OUTCOME, STOP_OUTCOME, WorldLifecycleError, portScopeForHost } from './worldLifecycle.js';

const TRANSITIONAL_STATUSES = ['STARTING', 'ACTIVE', 'STOPPING'];

/**
 * Serializes the read-decide-write cycles of the world lifecycle. JSON files
 * offer no locks, so this only protects a single process: this adapter stays a
 * development backend, and RDS is the one that guards concurrent Lobby nodes.
 */
class AsyncMutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(task) {
    const result = this.tail.then(task, task);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

/**
 * Reservation bookkeeping stays internal: it never reaches an API response.
 */
function withoutReservation(world) {
  if (!world) return world;
  const { reservationToken, reservationExpiresAt, portScope, ...visibleWorld } = world;
  return visibleWorld;
}

/**
 * LocalJsonWorldRepository: Asynchronous file-based repository adapter.
 * Emulates external database behavior for local development and testing.
 */
export class LocalJsonWorldRepository extends IWorldRepository {
  constructor(config) {
    super();
    this.config = config;
    this.dataDir = path.resolve(this.config.dataDir || './.lobby_data');
    this.worldsFile = path.join(this.dataDir, 'worlds.json');
    this.hostsFile = path.join(this.dataDir, 'hosts.json');
    this.lifecycleMutex = new AsyncMutex();
    this.isInitialized = false;
  }

  async init() {
    if (this.isInitialized) return;

    await fs.mkdir(this.dataDir, { recursive: true });

    // 1. Initialize Hosts File if not exists
    try {
      await fs.access(this.hostsFile);
    } catch {
      await this._seedDefaultHosts();
    }

    // 2. Initialize Worlds File if not exists
    try {
      await fs.access(this.worldsFile);
    } catch {
      await this._seedDefaultWorlds();
    }

    this.isInitialized = true;
  }

  async _readJson(filePath, defaultValue = []) {
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return defaultValue;
    }
  }

  async _writeJson(filePath, data) {
    const tempPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  }

  async _seedDefaultHosts() {
    const defaultHosts = [
      {
        id: 'host-primary-01',
        name: 'Primary World Host Node',
        hostIp: this.config.privateHost || this.config.publicHost || '127.0.0.1',
        publicHost: this.config.publicHost || 'localhost',
        publicWsProtocol: this.config.publicWsProtocol || 'ws',
        dockerApiUrl: process.env.DOCKER_HOST || 'http://127.0.0.1:2375',
        activeWorlds: 0,
        maxWorlds: 10,
        portRange: {
          min: this.config.worldPortRange?.min || 8001,
          max: this.config.worldPortRange?.max || 8050,
        },
        status: 'HEALTHY',
        isPermanent: true, // Primary baseline host that never scales down to 0
        hierarchy: 100, // Higher hierarchy = preferred anchor
        lastHeartbeat: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    await this._writeJson(this.hostsFile, defaultHosts);
  }

  async _seedDefaultWorlds() {
    const defaultWorld = {
      id: 'world-01',
      name: '🌲 Bosque Inicial',
      status: 'INACTIVE',
      seed: 48291,
      hostId: null,
      port: null,
      wsUrl: null,
      playersCount: 0,
      maxPlayers: 20,
      biome: 'forest',
      containerId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDefault: true,
    };
    await this._writeJson(this.worldsFile, [defaultWorld]);
  }

  // --- World Operations ---

  async listWorlds(filter = {}) {
    await this.init();
    const worlds = await this._readJson(this.worldsFile, []);
    return worlds
      .filter((w) => {
        if (filter.status && w.status !== filter.status) return false;
        if (filter.excludeStatus && w.status === filter.excludeStatus) return false;
        if (filter.hostId && w.hostId !== filter.hostId) return false;
        return true;
      })
      .map(withoutReservation);
  }

  async getWorld(worldId) {
    await this.init();
    const worlds = await this._readJson(this.worldsFile, []);
    return withoutReservation(worlds.find((w) => w.id === worldId)) || null;
  }

  async createWorld(worldData) {
    await this.init();
    const worlds = await this._readJson(this.worldsFile, []);

    const existing = worlds.find((w) => w.id === worldData.id);
    if (existing) {
      throw new Error(`El mundo con ID "${worldData.id}" ya existe.`);
    }

    const newWorld = {
      ...worldData,
      createdAt: worldData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    worlds.push(newWorld);
    await this._writeJson(this.worldsFile, worlds);
    return withoutReservation(newWorld);
  }

  async updateWorld(worldId, updates = {}) {
    await this.init();
    const worlds = await this._readJson(this.worldsFile, []);
    const idx = worlds.findIndex((w) => w.id === worldId);
    if (idx === -1) return null;

    worlds[idx] = {
      ...worlds[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    await this._writeJson(this.worldsFile, worlds);
    return withoutReservation(worlds[idx]);
  }

  async deleteWorld(worldId) {
    await this.init();
    const worlds = await this._readJson(this.worldsFile, []);
    const idx = worlds.findIndex((w) => w.id === worldId);
    if (idx === -1) return false;

    const removed = worlds.splice(idx, 1)[0];
    await this._writeJson(this.worldsFile, worlds);
    return withoutReservation(removed);
  }

  // --- World Lifecycle Operations ---

  async reserveWorldStart(worldId) {
    return this.lifecycleMutex.run(async () => {
      await this.init();
      const worlds = await this._readJson(this.worldsFile, []);
      const world = worlds.find((w) => w.id === worldId);

      if (!world) {
        return { outcome: RESERVATION_OUTCOME.NOT_FOUND, world: null };
      }
      if (world.status === 'ACTIVE' && world.wsUrl && world.port) {
        return { outcome: RESERVATION_OUTCOME.ACTIVE, world: withoutReservation(world) };
      }
      if (world.status === 'STARTING' || world.status === 'STOPPING') {
        return { outcome: RESERVATION_OUTCOME[world.status], world: withoutReservation(world) };
      }

      const host = await this._selectHostWithCapacity(worlds);
      const portScope = portScopeForHost(host);
      const port = this._findFreePortInScope(worlds, host, portScope);
      const token = crypto.randomUUID();
      const leaseMs = this.config.worldStartLeaseMs || 60000;

      Object.assign(world, {
        status: 'STARTING',
        hostId: host.id,
        port,
        portScope,
        wsUrl: null,
        containerId: null,
        runtimeId: token,
        reservationToken: token,
        reservationExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await this._writeJson(this.worldsFile, worlds);
      return { outcome: RESERVATION_OUTCOME.RESERVED, world: withoutReservation(world), host, token };
    });
  }

  async _selectHostWithCapacity(worlds) {
    const hosts = await this._readJson(this.hostsFile, []);
    const now = Date.now();
    const healthyHosts = hosts.filter((h) => {
      if (h.status !== 'HEALTHY') return false;
      if (!h.lastHeartbeat) return true;
      const ageMs = now - new Date(h.lastHeartbeat).getTime();
      return !isNaN(ageMs) && ageMs <= 90000;
    });

    if (healthyHosts.length === 0) {
      throw new Error('No hay nodos host disponibles en la flota para crear el mundo.');
    }

    // A world holds a slot while it has a host and a port, transitions included
    const loadOf = (host) => worlds.filter(
      (w) => w.hostId === host.id && TRANSITIONAL_STATUSES.includes(w.status)
    ).length;

    const eligibleHosts = healthyHosts.filter((h) => loadOf(h) < (h.maxWorlds || 10));
    if (eligibleHosts.length === 0) {
      throw new Error('Capacidad agotada en todos los nodos host de la flota.');
    }

    // Least relative load first, higher hierarchy breaks the tie
    eligibleHosts.sort((a, b) => {
      const loadA = loadOf(a) / (a.maxWorlds || 10);
      const loadB = loadOf(b) / (b.maxWorlds || 10);

      if (Math.abs(loadA - loadB) > 0.001) {
        return loadA - loadB;
      }

      return (b.hierarchy || 50) - (a.hierarchy || 50);
    });

    return eligibleHosts[0];
  }

  _findFreePortInScope(worlds, host, portScope) {
    const minPort = host.portRange?.min || 8001;
    const maxPort = host.portRange?.max || 8050;
    const usedPorts = new Set(
      worlds.filter((w) => w.portScope === portScope && w.port).map((w) => w.port)
    );

    for (let port = minPort; port <= maxPort; port++) {
      if (!usedPorts.has(port)) {
        return port;
      }
    }

    throw new Error(`Rango de puertos agotado (${minPort}-${maxPort}) en el nodo ${host.id}`);
  }

  async attachWorldContainer(worldId, token, containerId) {
    return this.lifecycleMutex.run(async () => {
      const worlds = await this._readJson(this.worldsFile, []);
      const world = worlds.find((w) => w.id === worldId);
      if (!world || world.status !== 'STARTING' || world.reservationToken !== token) return null;

      world.containerId = containerId;
      world.updatedAt = new Date().toISOString();
      await this._writeJson(this.worldsFile, worlds);
      return withoutReservation(world);
    });
  }

  async completeWorldStart(worldId, token, launchResult = {}) {
    return this.lifecycleMutex.run(async () => {
      const worlds = await this._readJson(this.worldsFile, []);
      const world = worlds.find((w) => w.id === worldId);
      if (!world || world.status !== 'STARTING' || world.reservationToken !== token) return null;

      Object.assign(world, {
        status: 'ACTIVE',
        wsUrl: launchResult.wsUrl ?? null,
        containerId: launchResult.containerId ?? null,
        reservationToken: null,
        reservationExpiresAt: null,
        updatedAt: new Date().toISOString(),
      });

      await this._writeJson(this.worldsFile, worlds);
      return withoutReservation(world);
    });
  }

  async failWorldStart(worldId, token) {
    return this._releaseReservedWorld(worldId, token, ['STARTING', 'STOPPING']);
  }

  async completeWorldStop(worldId, token) {
    return this._releaseReservedWorld(worldId, token, ['STOPPING']);
  }

  async _releaseReservedWorld(worldId, token, expectedStatuses) {
    return this.lifecycleMutex.run(async () => {
      const worlds = await this._readJson(this.worldsFile, []);
      const world = worlds.find((w) => w.id === worldId);
      if (!world || world.reservationToken !== token || !expectedStatuses.includes(world.status)) return null;

      Object.assign(world, {
        status: 'INACTIVE',
        hostId: null,
        port: null,
        portScope: null,
        wsUrl: null,
        containerId: null,
        playersCount: 0,
        reservationToken: null,
        reservationExpiresAt: null,
        updatedAt: new Date().toISOString(),
      });

      await this._writeJson(this.worldsFile, worlds);
      return withoutReservation(world);
    });
  }

  async beginWorldStop(worldId, { runtimeId, enforceRuntime = false } = {}) {
    return this.lifecycleMutex.run(async () => {
      await this.init();
      const worlds = await this._readJson(this.worldsFile, []);
      const world = worlds.find((w) => w.id === worldId);

      if (!world) {
        return { outcome: STOP_OUTCOME.NOT_FOUND, world: null };
      }
      if (enforceRuntime && (world.runtimeId || null) !== (runtimeId || null)) {
        throw new WorldLifecycleError('STALE_RUNTIME', 'El aviso pertenece a otra ejecución del mundo');
      }
      if (world.status === 'INACTIVE') {
        return { outcome: STOP_OUTCOME.INACTIVE, world: withoutReservation(world) };
      }
      if (world.status === 'STOPPING') {
        return { outcome: STOP_OUTCOME.STOPPING, world: withoutReservation(world) };
      }

      // A world still starting keeps its token: the worker that owns the
      // container notices the takeover and cleans up after itself.
      if (world.status === 'STARTING') {
        world.status = 'STOPPING';
        world.updatedAt = new Date().toISOString();
        await this._writeJson(this.worldsFile, worlds);
        return { outcome: STOP_OUTCOME.PENDING, world: withoutReservation(world) };
      }

      const token = crypto.randomUUID();
      const leaseMs = this.config.worldStartLeaseMs || 60000;

      Object.assign(world, {
        status: 'STOPPING',
        reservationToken: token,
        reservationExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await this._writeJson(this.worldsFile, worlds);
      return { outcome: STOP_OUTCOME.CLAIMED, world: withoutReservation(world), token };
    });
  }

  async listExpiredWorldStarts() {
    await this.init();
    const worlds = await this._readJson(this.worldsFile, []);
    const now = Date.now();

    return worlds
      .filter((w) => (
        (w.status === 'STARTING' || w.status === 'STOPPING')
        && w.reservationToken
        && Date.parse(w.reservationExpiresAt) < now
      ))
      .map((w) => ({ world: withoutReservation(w), token: w.reservationToken }));
  }

  // --- Host Fleet Operations ---

  async listHosts(filter = {}) {
    await this.init();
    const hosts = await this._readJson(this.hostsFile, []);
    const worlds = await this._readJson(this.worldsFile, []);

    const enrichedHosts = hosts.map((h) => {
      const activeCount = worlds.filter((w) => w.hostId === h.id && ['STARTING', 'ACTIVE', 'STOPPING'].includes(w.status)).length;
      return {
        ...h,
        activeWorlds: activeCount,
      };
    });

    return enrichedHosts.filter((h) => {
      if (filter.status && h.status !== filter.status) return false;
      return true;
    });
  }

  async getHost(hostId) {
    await this.init();
    const hosts = await this._readJson(this.hostsFile, []);
    const host = hosts.find((h) => h.id === hostId);
    if (!host) return null;

    const worlds = await this._readJson(this.worldsFile, []);
    const activeCount = worlds.filter((w) => w.hostId === host.id && ['STARTING', 'ACTIVE', 'STOPPING'].includes(w.status)).length;
    return {
      ...host,
      activeWorlds: activeCount,
    };
  }

  async registerHost(hostData) {
    await this.init();
    const hosts = await this._readJson(this.hostsFile, []);
    const idx = hosts.findIndex((h) => h.id === hostData.id);

    const now = new Date().toISOString();
    const formatted = {
      ...hostData,
      activeWorlds: hostData.activeWorlds ?? 0,
      maxWorlds: hostData.maxWorlds ?? 10,
      status: hostData.status || 'HEALTHY',
      isPermanent: false,
      hierarchy: hostData.hierarchy ?? 50,
      lastHeartbeat: now,
      updatedAt: now,
    };

    if (idx >= 0) {
      hosts[idx] = { ...hosts[idx], ...formatted };
    } else {
      formatted.createdAt = now;
      hosts.push(formatted);
    }

    await this._writeJson(this.hostsFile, hosts);
    return formatted;
  }

  async updateHostLoad(hostId, activeWorldsDelta = 0, updates = {}) {
    await this.init();
    const hosts = await this._readJson(this.hostsFile, []);
    const idx = hosts.findIndex((h) => h.id === hostId);
    if (idx === -1) return null;

    const current = hosts[idx];
    const newActive = Math.max(0, (current.activeWorlds || 0) + activeWorldsDelta);

    hosts[idx] = {
      ...current,
      ...updates,
      activeWorlds: newActive,
      lastHeartbeat: updates.lastHeartbeat || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this._writeJson(this.hostsFile, hosts);
    return hosts[idx];
  }

  /**
   * Resets all worlds placed on a dead host back to INACTIVE, clearing placement and reservation fields.
   * @param {string} hostId
   * @returns {Promise<object[]>}
   */
  async releaseWorldsOnDeadHost(hostId) {
    if (!hostId) return [];
    await this.init();
    const worlds = await this._readJson(this.worldsFile, []);
    const released = [];

    for (const w of worlds) {
      if (w.hostId === hostId && ['STARTING', 'ACTIVE', 'STOPPING'].includes(w.status)) {
        w.status = 'INACTIVE';
        w.hostId = null;
        w.port = null;
        w.portScope = null;
        w.wsUrl = null;
        w.containerId = null;
        w.reservationToken = null;
        w.reservationExpiresAt = null;
        w.playersCount = 0;
        w.updatedAt = new Date().toISOString();
        released.push(withoutReservation(w));
      }
    }

    if (released.length > 0) {
      await this._writeJson(this.worldsFile, worlds);
    }
    return released;
  }

  /**
   * Updates host status (e.g. UNHEALTHY) without touching lastHeartbeat.
   * @param {string} hostId
   * @param {string} status
   * @returns {Promise<object|null>}
   */
  async updateHostStatus(hostId, status) {
    await this.init();
    const hosts = await this._readJson(this.hostsFile, []);
    const idx = hosts.findIndex((h) => h.id === hostId);
    if (idx === -1) return null;

    hosts[idx].status = status;
    hosts[idx].updatedAt = new Date().toISOString();
    await this._writeJson(this.hostsFile, hosts);
    return this.getHost(hostId);
  }

  /**
   * Deletes a dead host from the registry (for cleaning up terminated ephemeral EC2 instances).
   * @param {string} hostId
   * @returns {Promise<boolean>}
   */
  async deleteHost(hostId) {
    await this.init();
    const hosts = await this._readJson(this.hostsFile, []);
    const idx = hosts.findIndex((h) => h.id === hostId);
    if (idx === -1) return false;

    hosts.splice(idx, 1);
    await this._writeJson(this.hostsFile, hosts);
    return true;
  }
}
