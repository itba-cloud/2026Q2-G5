import crypto from 'crypto';
import net from 'net';
import { worldEnvironment } from './worldEnvironment.js';

/**
 * Probes a TCP port to check if the server is accepting incoming connections.
 */
function probeTcpPort(hostIp, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, hostIp);
  });
}

/**
 * Waits for a container port to start accepting connections.
 */
async function waitForContainerPort(hostIp, port, maxWaitMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const isOpen = await probeTcpPort(hostIp, port, 200);
    if (isOpen) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Container name for a world. The reservation token keeps two attempts on the
 * same world from fighting over one name, and lets a lost reservation find the
 * container it created even before its id was stored.
 * @param {string} worldId
 * @param {string} [token] Reservation token that owns the container
 * @returns {string}
 */
export function worldContainerName(worldId, token) {
  return token ? `elastic-world-${worldId}-${token.slice(0, 8)}` : `elastic-world-${worldId}`;
}

/**
 * DockerContainerLauncher: Interacts with Docker Engine API on remote/local host nodes.
 * Launches and stops isolated world-service containers.
 * Includes graceful mock/fallback mode for local testing without Docker daemon.
 */
export class DockerContainerLauncher {
  constructor(options = {}) {
    this.mockContainers = new Map();
    this.defaultImage = options.defaultImage || process.env.WORLD_IMAGE || 'agromero/elastic-worlds-world-service:latest';
    if (options.useMock !== undefined) {
      this.useMock = Boolean(options.useMock);
    }
  }

  /** Reference used to find this world's container when its id was never recorded. */
  containerRef(worldId, token) {
    return worldContainerName(worldId, token);
  }

  isMockMode() {
    if (this.useMock !== undefined) {
      return this.useMock;
    }
    if (process.env.USE_DOCKER_MOCK !== undefined) {
      return process.env.USE_DOCKER_MOCK === 'true';
    }
    if (process.env.NODE_ENV === 'test') {
      return true;
    }
    return false;
  }

  /**
   * Spawns a new world-service container on the specified host.
   * @param {object} host Host node object from repository
   * @param {object} worldConfig World configuration parameters
   * @returns {Promise<{ containerId: string, port: number, wsUrl: string }>}
   */
  async launchWorldContainer(host, worldConfig) {
    const worldId = worldConfig.id;
    const port = worldConfig.port;
    const token = worldConfig.token || null;
    const containerName = worldContainerName(worldId, token);
    const publicHost = host.publicHost || host.hostIp || 'localhost';
    const internalHost = host.hostIp === '0.0.0.0' ? '127.0.0.1' : (host.hostIp || 'localhost');
    const protocol = host.publicWsProtocol || 'ws';
    const wsUrl = `${protocol}://${publicHost}:${port}`;
    const internalWsUrl = `ws://${internalHost}:${port}`;

    if (this.isMockMode()) {
      const mockContainerId = this.mockContainers.get(containerName) || `dckr_mock_${worldId}_${crypto.randomUUID().slice(0, 8)}`;
      this.mockContainers.set(containerName, mockContainerId);
      console.log(`[DockerLauncher:MOCK] Spawning container "${mockContainerId}" for world "${worldId}" on ${host.id}:${port}`);
      return {
        containerId: mockContainerId,
        port,
        wsUrl,
        internalWsUrl,
      };
    }

    // Real Docker Engine REST API Interaction
    const dockerApiUrl = host.dockerApiUrl || `http://${host.hostIp}:2375`;

    try {
      console.log(`[DockerLauncher] Connecting to Docker Engine at ${dockerApiUrl} to create container "${containerName}"`);

      // Ensure container reaches the host's Lobby Service via host.docker.internal
      const rawLobbyUrl = process.env.LOBBY_LOAD_BALANCER_URL || 'http://host.docker.internal:3000';
      const containerLobbyUrl = rawLobbyUrl
        .replace('127.0.0.1', 'host.docker.internal')
        .replace('localhost', 'host.docker.internal');

      // The world joins the cross-world message bus. Same rewrite as the Lobby
      // URL: a loopback address means the developer's machine, not the container.
      const rawRedisUrl = process.env.REDIS_URL || '';
      const containerRedisUrl = rawRedisUrl
        .replace('127.0.0.1', 'host.docker.internal')
        .replace('localhost', 'host.docker.internal');

      const containerPayload = {
        Image: this.defaultImage,
        Env: worldEnvironment(worldConfig, { port, lobbyUrl: containerLobbyUrl, redisUrl: containerRedisUrl })
          .map(([name, value]) => `${name}=${value}`),
        ExposedPorts: {
          [`${port}/tcp`]: {},
        },
        Labels: {
          'elastic-worlds.world-id': worldId,
          'elastic-worlds.reservation-token': token || '',
        },
        HostConfig: {
          PortBindings: {
            [`${port}/tcp`]: [{ HostPort: `${port}` }],
          },
          ExtraHosts: ['host.docker.internal:host-gateway'],
          RestartPolicy: { Name: 'no' },
        },
      };

      // 1. Create Container. The name carries the reservation token, so a 409 is a
      //    real collision and never a stale container this launch should delete.
      let containerId;
      try {
        const createRes = await fetch(`${dockerApiUrl}/containers/create?name=${encodeURIComponent(containerName)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(containerPayload), signal: AbortSignal.timeout(5000),
        });
        if (!createRes.ok) throw new Error(`Docker create: ${createRes.status}`);
        containerId = (await createRes.json()).Id;
      } catch (err) {
        // A create can succeed even if its response is lost. Reuse only our generation.
        const existing = await this.getContainerStatus(host, containerName);
        if (!existing.exists || existing.hostUnreachable || !existing.containerId ||
            existing.labels?.['elastic-worlds.world-id'] !== worldId ||
            existing.labels?.['elastic-worlds.reservation-token'] !== token) throw err;
        containerId = existing.containerId;
      }

      // 2. Start Container
      const startRes = await fetch(`${dockerApiUrl}/containers/${containerId}/start`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });

      if (!startRes.ok && startRes.status !== 304) {
        const errText = await startRes.text();
        throw new Error(`Docker API start failed (${startRes.status}): ${errText}`);
      }

      console.log(`[DockerLauncher] Container ${containerId.slice(0, 12)} started. Awaiting port ${port} readiness probe...`);

      // 3. Wait for WebSocket server in container to start listening on port
      const probeHost = host.hostIp === '0.0.0.0' ? '127.0.0.1' : (host.hostIp || '127.0.0.1');
      const isReady = worldConfig.waitForPort === false ? true : await waitForContainerPort(probeHost, port, 6000);
      if (isReady) {
        console.log(`[DockerLauncher] Container ${containerId.slice(0, 12)} is READY and accepting WebSocket connections on ${probeHost}:${port}`);
      } else {
        console.warn(`[DockerLauncher] Warning: Port ${probeHost}:${port} readiness probe timed out. Proceeding.`);
      }

      return {
        containerId,
        port,
        wsUrl,
        internalWsUrl,
      };
    } catch (err) {
      console.error(`[DockerLauncher] Error launching container on host ${host.id}:`, err.message);
      throw new Error(`Fallo en el servidor Docker al iniciar el contenedor del mundo: ${err.message}`);
    }
  }

  /**
   * Queries the status of a container on the host Docker Engine.
   * @param {object} host Host node object
   * @param {string} containerId Container ID or name
   * @returns {Promise<{ exists: boolean, running: boolean, status: string, hostUnreachable?: boolean }>}
   */
  async getContainerStatus(host, containerId) {
    if (!containerId || this.isMockMode() || containerId.startsWith('dckr_mock_')) {
      return { exists: true, running: true, status: 'running' };
    }

    const dockerApiUrl = host.dockerApiUrl || `http://${host.hostIp}:2375`;

    try {
      const res = await fetch(`${dockerApiUrl}/containers/${containerId}/json`, {
        signal: AbortSignal.timeout(1000),
      });

      if (res.status === 404) {
        return { exists: false, running: false, status: 'not_found' };
      }

      if (!res.ok) {
        return { exists: true, running: true, status: 'unknown' };
      }

      const data = await res.json();
      const isRunning = Boolean(data.State?.Running);
      return {
        exists: true,
        containerId: data.Id,
        labels: data.Config?.Labels || {},
        running: isRunning,
        status: data.State?.Status || (isRunning ? 'running' : 'exited'),
      };
    } catch (err) {
      console.warn(`[DockerLauncher] Host/container unreachable at ${dockerApiUrl} for "${containerId}": ${err.message}`);
      return { exists: false, running: false, status: 'unreachable', hostUnreachable: true };
    }
  }

  /**
   * Reaps a container whose world process is already shutting itself down.
   * Waits for it to exit and removes it without force, so the Lobby never cuts
   * short a shutdown the world started on its own.
   * @param {object} host Host node object
   * @param {string} containerId Container ID
   * @param {number} [maxWaitMs=3000] How long to wait for the process to exit
   * @returns {Promise<boolean>} False when the container is still running
   */
  async removeWorldContainer(host, containerId, maxWaitMs = 3000) {
    if (!containerId) return true;

    if (this.isMockMode() || containerId.startsWith('dckr_mock_')) {
      console.log(`[DockerLauncher:MOCK] Reaped self-stopped container "${containerId}" on ${host.id}`);
      return true;
    }

    const dockerApiUrl = host.dockerApiUrl || `http://${host.hostIp}:2375`;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const containerStatus = await this.getContainerStatus(host, containerId);
      if (containerStatus.hostUnreachable || containerStatus.status === 'unknown') return false;
      if (!containerStatus.exists) return true;
      if (!containerStatus.running) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    try {
      const removeRes = await fetch(`${dockerApiUrl}/containers/${containerId}?v=1`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(2500),
      });

      if (!removeRes.ok && removeRes.status !== 404) {
        console.warn(`[DockerLauncher] Container "${containerId}" on ${host.id} has not exited yet (${removeRes.status}). Leaving it for reconciliation.`);
        return false;
      }

      console.log(`[DockerLauncher] Reaped self-stopped container "${containerId}" on ${host.id}`);
      return true;
    } catch (err) {
      console.warn(`[DockerLauncher] Warning: Failed to reap container ${containerId}:`, err.message);
      const isUnreachable = err.name === 'AbortError' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message?.includes('fetch failed');
      if (isUnreachable) {
        console.warn(`[DockerLauncher] Host ${host.id} unreachable when reaping container "${containerId}". Retaining its reservation.`);
        return false;
      }
      return false;
    }
  }

  /**
   * Stops and removes a world-service container on the specified host.
   * @param {object} host Host node object
   * @param {string} containerId Container ID
   * @returns {Promise<boolean>}
   */
  async stopWorldContainer(host, containerId) {
    if (!containerId) return true;

    if (this.isMockMode() || containerId.startsWith('dckr_mock_') || containerId.startsWith('dckr_fallback_') || containerId.startsWith('mock-container')) {
      console.log(`[DockerLauncher:MOCK] Stopped and removed container "${containerId}" on ${host.id}`);
      return true;
    }

    const dockerApiUrl = host.dockerApiUrl || `http://${host.hostIp}:2375`;

    try {
      // 1. Stop container (with 2s grace period). A 404 means it is already gone.
      const stopRes = await fetch(`${dockerApiUrl}/containers/${containerId}/stop?t=2`, {
        method: 'POST',
        signal: AbortSignal.timeout(2500),
      });

      if (stopRes.status === 404) {
        console.log(`[DockerLauncher] Container "${containerId}" no longer exists on ${host.id}. Nothing to remove.`);
        return true;
      }

      // 2. Remove container
      const removeRes = await fetch(`${dockerApiUrl}/containers/${containerId}?v=1&force=true`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(2500),
      });

      if (!removeRes.ok && removeRes.status !== 404) {
        console.warn(`[DockerLauncher] Docker API remove failed (${removeRes.status}) for container "${containerId}" on ${host.id}.`);
        return false;
      }

      console.log(`[DockerLauncher] Successfully stopped and removed container "${containerId}" on ${host.id}`);
      return true;
    } catch (err) {
      console.warn(`[DockerLauncher] Warning: Failed to cleanly remove container ${containerId}:`, err.message);
      const isUnreachable = err.name === 'AbortError' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message?.includes('fetch failed');
      if (isUnreachable) {
        console.warn(`[DockerLauncher] Host ${host.id} unreachable when stopping container "${containerId}". Retaining its reservation.`);
        return false;
      }
      return false;
    }
  }
}
