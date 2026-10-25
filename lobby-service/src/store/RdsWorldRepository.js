import { Pool } from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { IWorldRepository } from './IWorldRepository.js';
import { RESERVATION_OUTCOME, STOP_OUTCOME, WorldLifecycleError, portScopeForHost } from './worldLifecycle.js';
import { runMigrations } from './migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORLD_COLUMNS = {
  name: 'name',
  status: 'status',
  seed: 'seed',
  biome: 'biome',
  hostId: 'host_id',
  port: 'port',
  wsUrl: 'ws_url',
  containerId: 'container_id',
  playersCount: 'players_count',
  maxPlayers: 'max_players',
  botCount: 'bot_count',
  isDefault: 'is_default',
  portScope: 'port_scope',
  runtimeId: 'runtime_id',
  reservationToken: 'reservation_token',
  reservationExpiresAt: 'reservation_expires_at',
};

const HOST_COLUMNS = {
  name: 'name',
  hostIp: 'host_ip',
  publicHost: 'public_host',
  publicWsProtocol: 'public_ws_protocol',
  dockerApiUrl: 'docker_api_url',
  maxWorlds: 'max_worlds',
  status: 'status',
  isPermanent: 'is_permanent',
  hierarchy: 'hierarchy',
};

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export function rowToWorld(row) {
  if (!row) return null;

  return {
    id: row.world_id,
    name: row.name,
    status: row.status,
    seed: row.seed,
    biome: row.biome,
    hostId: row.host_id,
    port: row.port,
    wsUrl: row.ws_url,
    containerId: row.container_id,
    runtimeId: row.runtime_id || null,
    playersCount: row.players_count,
    maxPlayers: row.max_players,
    botCount: row.bot_count,
    isDefault: row.is_default,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToHost(row) {
  if (!row) return null;

  return {
    id: row.host_id,
    name: row.name,
    hostIp: row.host_ip,
    publicHost: row.public_host,
    publicWsProtocol: row.public_ws_protocol,
    dockerApiUrl: row.docker_api_url,
    portRange: {
      min: row.port_min,
      max: row.port_max,
    },
    activeWorlds: row.active_worlds,
    maxWorlds: row.max_worlds,
    status: row.status,
    isPermanent: row.is_permanent,
    hierarchy: row.hierarchy,
    lastHeartbeat: toIso(row.last_heartbeat),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Repositorio PostgreSQL para el catalogo operativo de mundos y hosts.
 */
export class RdsWorldRepository extends IWorldRepository {
  constructor(config) {
    super();
    this.config = config;
    this.pool = new Pool({
      ...config.db,
      max: config.dbPoolMax || 10,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
    });
    // An RDS failover drops idle connections; unhandled, this event crashes the process.
    this.pool.on('error', (err) => {
      console.warn(`[RdsWorldRepository] Idle database connection lost: ${err.message}`);
    });
    if (typeof config.db?.password?.invalidate === 'function') {
      this._retryWithRotatedPassword(config.db.password);
    }
    this.isInitialized = false;
  }

  /**
   * RDS rotates the master password in Secrets Manager. A new connection that
   * still uses the cached value fails with invalid_password (28P01) before any
   * statement runs, so dropping the cache and retrying once is safe.
   */
  _retryWithRotatedPassword(password) {
    const retry = (method) => async (...args) => {
      // pg-pool's own query() calls connect(callback); only promise calls retry.
      if (typeof args.at(-1) === 'function') return method(...args);
      try {
        return await method(...args);
      } catch (err) {
        if (err?.code !== '28P01') throw err;
        password.invalidate();
        return method(...args);
      }
    };
    this.pool.query = retry(this.pool.query.bind(this.pool));
    this.pool.connect = retry(this.pool.connect.bind(this.pool));
  }

  async init({ migrate = true } = {}) {
    if (this.isInitialized) return;
    try {
      if (migrate) {
        await runMigrations(this.pool, path.join(__dirname, 'migrations'));
        await this._seedDefaultWorld();
        if (this.config.seedDefaultHost) await this._seedDefaultHost();
      } else {
        await this.pool.query('SELECT 1 FROM worlds LIMIT 0');
      }
      this.isInitialized = true;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async close() {
    await this.pool.end();
    this.isInitialized = false;
  }

  async _seedDefaultWorld() {
    await this.pool.query(`
      INSERT INTO worlds (
        world_id, name, status, seed, biome, players_count, max_players, bot_count, is_default
      ) VALUES ('world-01', '🌲 Bosque Inicial', 'INACTIVE', 48291, 'forest', 0, 20, 2, true)
      ON CONFLICT (world_id) DO NOTHING
    `);
  }

  async _seedDefaultHost() {
    const hostIp = this.config.privateHost || this.config.publicHost || '127.0.0.1';
    await this.pool.query(`
      INSERT INTO hosts (
        host_id, name, host_ip, public_host, public_ws_protocol, docker_api_url,
        port_min, port_max, max_worlds, status, is_permanent, hierarchy, last_heartbeat
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 10, 'HEALTHY', true, 100, now())
      ON CONFLICT (host_id) DO NOTHING
    `, [
      'host-primary-01',
      'Primary World Host Node',
      hostIp,
      this.config.publicHost || 'localhost',
      this.config.publicWsProtocol || 'ws',
      process.env.DOCKER_HOST || 'http://127.0.0.1:2375',
      this.config.worldPortRange?.min || 8001,
      this.config.worldPortRange?.max || 8050,
    ]);
  }

  async listWorlds(filter = {}) {
    const clauses = [];
    const values = [];

    if (filter.status) {
      values.push(filter.status);
      clauses.push(`status = $${values.length}`);
    }
    if (filter.excludeStatus) {
      values.push(filter.excludeStatus);
      clauses.push(`status <> $${values.length}`);
    }
    if (filter.hostId) {
      values.push(filter.hostId);
      clauses.push(`host_id = $${values.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM worlds ${where} ORDER BY created_at, world_id`,
      values
    );
    return result.rows.map(rowToWorld);
  }

  async getWorld(worldId) {
    const result = await this.pool.query('SELECT * FROM worlds WHERE world_id = $1', [worldId]);
    return rowToWorld(result.rows[0]);
  }

  async createWorld(worldData) {
    try {
      const result = await this.pool.query(`
        INSERT INTO worlds (
          world_id, name, status, seed, biome, host_id, port, ws_url,
          container_id, players_count, max_players, bot_count, is_default
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `, [
        worldData.id,
        worldData.name,
        worldData.status || 'INACTIVE',
        worldData.seed,
        worldData.biome || 'forest',
        worldData.hostId ?? null,
        worldData.port ?? null,
        worldData.wsUrl ?? null,
        worldData.containerId ?? null,
        worldData.playersCount ?? 0,
        worldData.maxPlayers ?? 20,
        worldData.botCount ?? 0,
        worldData.isDefault ?? false,
      ]);
      return rowToWorld(result.rows[0]);
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'worlds_pkey') {
        throw new Error(`El mundo con ID "${worldData.id}" ya existe.`);
      }
      throw err;
    }
  }

  async updateWorld(worldId, updates = {}) {
    const assignments = [];
    const values = [];

    for (const [property, column] of Object.entries(WORLD_COLUMNS)) {
      if (updates[property] === undefined) continue;
      values.push(updates[property]);
      assignments.push(`${column} = $${values.length}`);
    }

    if (assignments.length === 0) {
      return this.getWorld(worldId);
    }

    assignments.push('updated_at = now()');
    values.push(worldId);
    const result = await this.pool.query(
      `UPDATE worlds SET ${assignments.join(', ')} WHERE world_id = $${values.length} RETURNING *`,
      values
    );
    return rowToWorld(result.rows[0]);
  }

  async deleteWorld(worldId) {
    const result = await this.pool.query('DELETE FROM worlds WHERE world_id = $1 RETURNING *', [worldId]);
    return rowToWorld(result.rows[0]) || false;
  }

  /**
   * Reserva host y puerto para iniciar un mundo dentro de una transaccion corta.
   * No habla con Docker: solo deja el mundo en STARTING con un token de dueno.
   * @param {string} worldId
   * @returns {Promise<{ outcome: string, world: object|null, host?: object, token?: string }>}
   */
  async reserveWorldStart(worldId) {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this._reserveWorldStartOnce(worldId);
      } catch (err) {
        // Otra reserva gano el mismo (port_scope, port) mientras esta elegia:
        // reintentar sobre el estado ya confirmado en vez de fallar el inicio.
        if (err.code !== '23505' || attempt === maxAttempts) throw err;
      }
    }
  }

  async _reserveWorldStartOnce(worldId) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Bloquear la fila del mundo para serializar los inicios concurrentes
      const worldResult = await client.query('SELECT * FROM worlds WHERE world_id = $1 FOR UPDATE', [worldId]);
      const world = rowToWorld(worldResult.rows[0]);

      if (!world) {
        await client.query('ROLLBACK');
        return { outcome: RESERVATION_OUTCOME.NOT_FOUND, world: null };
      }

      // 2. Devolver el estado actual si el mundo ya esta arriba o en transicion
      if (world.status === 'ACTIVE' && world.wsUrl && world.port) {
        await client.query('ROLLBACK');
        return { outcome: RESERVATION_OUTCOME.ACTIVE, world };
      }
      if (world.status === 'STARTING' || world.status === 'STOPPING') {
        await client.query('ROLLBACK');
        return { outcome: RESERVATION_OUTCOME[world.status], world };
      }

      // 3. Tomar un host sano con capacidad: SKIP LOCKED manda las reservas
      //    simultaneas al siguiente candidato en vez de encolarlas
      const host = await this._lockHostWithCapacity(client);

      // 4. Elegir el primer puerto libre dentro del scope de ese host
      const portScope = portScopeForHost(host);
      const port = await this._findFreePortInScope(client, host, portScope);

      // 5. Guardar la reserva con token y vencimiento de lease
      const token = crypto.randomUUID();
      const reserved = await client.query(`
        UPDATE worlds SET
          status = 'STARTING',
          host_id = $2,
          port = $3,
          port_scope = $4,
          ws_url = NULL,
          container_id = NULL,
          runtime_id = $5::uuid,
          reservation_token = $5::text,
          reservation_expires_at = now() + make_interval(secs => $6::numeric),
          updated_at = now()
        WHERE world_id = $1
        RETURNING *
      `, [worldId, host.id, port, portScope, token, this._leaseSeconds()]);

      await client.query('COMMIT');
      return {
        outcome: RESERVATION_OUTCOME.RESERVED,
        world: rowToWorld(reserved.rows[0]),
        host,
        token,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async _lockHostWithCapacity(client) {
    const result = await client.query(`
      SELECT hosts.*, load.active_worlds
      FROM hosts
      JOIN LATERAL (
        SELECT COUNT(*)::INTEGER AS active_worlds
        FROM worlds
        WHERE worlds.host_id = hosts.host_id
          AND worlds.status IN ('STARTING', 'ACTIVE', 'STOPPING')
      ) AS load ON true
      WHERE hosts.status = 'HEALTHY'
        AND (hosts.last_heartbeat IS NULL OR hosts.last_heartbeat > now() - INTERVAL '90 seconds')
        AND load.active_worlds < hosts.max_worlds
      ORDER BY
        load.active_worlds::NUMERIC / hosts.max_worlds,
        hosts.hierarchy DESC,
        hosts.created_at,
        hosts.host_id
      FOR UPDATE OF hosts SKIP LOCKED
      LIMIT 1
    `);

    const host = rowToHost(result.rows[0]);
    if (host) return host;

    const healthy = await client.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM hosts
      WHERE status = 'HEALTHY'
        AND (last_heartbeat IS NULL OR last_heartbeat > now() - INTERVAL '90 seconds')
    `);
    if (healthy.rows[0].count === 0) {
      throw new Error('No hay nodos host disponibles en la flota para crear el mundo.');
    }
    throw new Error('Capacidad agotada en todos los nodos host de la flota.');
  }

  async _findFreePortInScope(client, host, portScope) {
    const minPort = host.portRange?.min || 8001;
    const maxPort = host.portRange?.max || 8050;

    const result = await client.query(`
      SELECT candidate.port
      FROM generate_series($1::INTEGER, $2::INTEGER) AS candidate(port)
      WHERE NOT EXISTS (
        SELECT 1 FROM worlds
        WHERE worlds.port = candidate.port AND worlds.port_scope = $3
      )
      ORDER BY candidate.port
      LIMIT 1
    `, [minPort, maxPort, portScope]);

    const port = result.rows[0]?.port;
    if (!port) {
      throw new Error(`Rango de puertos agotado (${minPort}-${maxPort}) en el nodo ${host.id}`);
    }
    return port;
  }

  _leaseSeconds() {
    return (this.config.worldStartLeaseMs || 60000) / 1000;
  }

  /**
   * Registra el contenedor recien creado sin cerrar todavia la reserva.
   * @returns {Promise<object|null>} Mundo actualizado, o null si perdio la reserva
   */
  async attachWorldContainer(worldId, token, containerId) {
    const result = await this.pool.query(`
      UPDATE worlds SET container_id = $3, updated_at = now()
      WHERE world_id = $1 AND status = 'STARTING' AND reservation_token = $2
      RETURNING *
    `, [worldId, token, containerId]);
    return rowToWorld(result.rows[0]);
  }

  /**
   * Confirma STARTING -> ACTIVE. Solo el token ganador puede cerrar la reserva.
   * @returns {Promise<object|null>} Mundo activo, o null si perdio la reserva
   */
  async completeWorldStart(worldId, token, launchResult = {}) {
    const result = await this.pool.query(`
      UPDATE worlds SET
        status = 'ACTIVE',
        ws_url = $3,
        container_id = $4,
        npc_ws_url = $5,
        npc_bot_count = $6,
        reservation_token = NULL,
        reservation_expires_at = NULL,
        updated_at = now()
      WHERE world_id = $1 AND status = 'STARTING' AND reservation_token = $2
      RETURNING *
    `, [worldId, token, launchResult.wsUrl ?? null, launchResult.containerId ?? null,
      launchResult.internalWsUrl || launchResult.wsUrl || null, Math.max(0, launchResult.npcBotCount ?? 0)]);
    return rowToWorld(result.rows[0]);
  }

  async failWorldStart(worldId, token) {
    return this._releaseReservedWorld(worldId, token, ['STARTING', 'STOPPING']);
  }

  async completeWorldStop(worldId, token) {
    return this._releaseReservedWorld(worldId, token, ['STOPPING']);
  }

  async _releaseReservedWorld(worldId, token, expectedStatuses) {
    const result = await this.pool.query(`
      UPDATE worlds SET
        status = 'INACTIVE',
        host_id = NULL,
        port = NULL,
        port_scope = NULL,
        ws_url = NULL,
        npc_ws_url = NULL,
        npc_bot_count = 0,
        container_id = NULL,
        players_count = 0,
        reservation_token = NULL,
        reservation_expires_at = NULL,
        updated_at = now()
      WHERE world_id = $1 AND reservation_token = $2 AND status = ANY($3)
      RETURNING *
    `, [worldId, token, expectedStatuses]);
    return rowToWorld(result.rows[0]);
  }

  /**
   * Reclama la parada de un mundo. Un mundo en STARTING queda marcado como
   * parada pendiente conservando el token del worker que lo inicio: ese worker
   * detecta que perdio la reserva, limpia su contenedor y lo deja INACTIVE.
   * @param {string} worldId
   * @returns {Promise<{ outcome: string, world: object|null, token?: string }>}
   */
  async beginWorldStop(worldId, { runtimeId, enforceRuntime = false } = {}) {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const worldResult = await client.query('SELECT * FROM worlds WHERE world_id = $1 FOR UPDATE', [worldId]);
      const world = rowToWorld(worldResult.rows[0]);

      if (!world) {
        await client.query('ROLLBACK');
        return { outcome: STOP_OUTCOME.NOT_FOUND, world: null };
      }
      if (enforceRuntime && (world.runtimeId || null) !== (runtimeId || null)) {
        throw new WorldLifecycleError('STALE_RUNTIME', 'El aviso pertenece a otra ejecución del mundo');
      }
      if (world.status === 'INACTIVE') {
        await client.query('ROLLBACK');
        return { outcome: STOP_OUTCOME.INACTIVE, world };
      }
      if (world.status === 'STOPPING') {
        await client.query('ROLLBACK');
        return { outcome: STOP_OUTCOME.STOPPING, world };
      }

      if (world.status === 'STARTING') {
        const pending = await client.query(`
          UPDATE worlds SET status = 'STOPPING', updated_at = now()
          WHERE world_id = $1
          RETURNING *
        `, [worldId]);
        await client.query('COMMIT');
        return { outcome: STOP_OUTCOME.PENDING, world: rowToWorld(pending.rows[0]) };
      }

      const token = crypto.randomUUID();
      const claimed = await client.query(`
        UPDATE worlds SET
          status = 'STOPPING',
          reservation_token = $2,
          reservation_expires_at = now() + make_interval(secs => $3::numeric),
          updated_at = now()
        WHERE world_id = $1
        RETURNING *
      `, [worldId, token, this._leaseSeconds()]);

      await client.query('COMMIT');
      return { outcome: STOP_OUTCOME.CLAIMED, world: rowToWorld(claimed.rows[0]), token };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reservas cuyo lease vencio sin que nadie las confirmara.
   * @returns {Promise<Array<{ world: object, token: string }>>}
   */
  async listExpiredWorldStarts() {
    const result = await this.pool.query(`
      SELECT * FROM worlds
      WHERE status IN ('STARTING', 'STOPPING')
        AND reservation_token IS NOT NULL
        AND reservation_expires_at < now()
      ORDER BY reservation_expires_at
    `);
    return result.rows.map((row) => ({
      world: rowToWorld(row),
      token: row.reservation_token,
    }));
  }

  async listHosts(filter = {}) {
    const values = [];
    let where = '';
    if (filter.status) {
      values.push(filter.status);
      where = 'WHERE status = $1';
    }

    const result = await this.pool.query(
      `SELECT * FROM host_load ${where} ORDER BY created_at, host_id`,
      values
    );
    return result.rows.map(rowToHost);
  }

  async getHost(hostId) {
    const result = await this.pool.query('SELECT * FROM host_load WHERE host_id = $1', [hostId]);
    return rowToHost(result.rows[0]);
  }

  async registerHost(hostData) {
    const portRange = hostData.portRange || this.config.worldPortRange;
    const isPermanent = false;
    const values = [
      hostData.id,
      hostData.name || hostData.id,
      hostData.hostIp || '127.0.0.1',
      hostData.publicHost || hostData.hostIp || 'localhost',
      hostData.publicWsProtocol || 'ws',
      hostData.dockerApiUrl || null,
      portRange?.min || 8001,
      portRange?.max || 8050,
      hostData.maxWorlds ?? 10,
      hostData.status || 'HEALTHY',
      isPermanent,
      hostData.hierarchy ?? 50,
    ];

    const result = await this.pool.query(`
      INSERT INTO hosts (
        host_id, name, host_ip, public_host, public_ws_protocol, docker_api_url,
        port_min, port_max, max_worlds, status, is_permanent, hierarchy, last_heartbeat
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
      ON CONFLICT (host_id) DO UPDATE SET
        name = EXCLUDED.name,
        host_ip = EXCLUDED.host_ip,
        public_host = EXCLUDED.public_host,
        public_ws_protocol = EXCLUDED.public_ws_protocol,
        docker_api_url = EXCLUDED.docker_api_url,
        port_min = EXCLUDED.port_min,
        port_max = EXCLUDED.port_max,
        max_worlds = EXCLUDED.max_worlds,
        status = EXCLUDED.status,
        is_permanent = EXCLUDED.is_permanent,
        hierarchy = EXCLUDED.hierarchy,
        last_heartbeat = now(),
        updated_at = now()
      RETURNING host_id
    `, values);
    return this.getHost(result.rows[0].host_id);
  }

  async updateHostLoad(hostId, _activeWorldsDelta = 0, updates = {}) {
    const assignments = [];
    const values = [];

    for (const [property, column] of Object.entries(HOST_COLUMNS)) {
      if (updates[property] === undefined) continue;
      values.push(updates[property]);
      assignments.push(`${column} = $${values.length}`);
    }

    if (updates.portRange) {
      values.push(updates.portRange.min);
      assignments.push(`port_min = $${values.length}`);
      values.push(updates.portRange.max);
      assignments.push(`port_max = $${values.length}`);
    }

    assignments.push('last_heartbeat = now()', 'updated_at = now()');
    values.push(hostId);
    const result = await this.pool.query(
      `UPDATE hosts SET ${assignments.join(', ')} WHERE host_id = $${values.length} RETURNING host_id`,
      values
    );
    if (result.rowCount === 0) return null;
    return this.getHost(hostId);
  }

  /**
   * Resets all worlds placed on a dead host back to INACTIVE, clearing placement and reservation fields.
   * @param {string} hostId
   * @returns {Promise<object[]>}
   */
  async releaseWorldsOnDeadHost(hostId) {
    if (!hostId) return [];
    const result = await this.pool.query(`
      UPDATE worlds
      SET
        status = 'INACTIVE',
        host_id = NULL,
        port = NULL,
        port_scope = NULL,
        ws_url = NULL,
        npc_ws_url = NULL,
        npc_bot_count = 0,
        container_id = NULL,
        reservation_token = NULL,
        reservation_expires_at = NULL,
        players_count = 0,
        updated_at = now()
      WHERE host_id = $1 AND status IN ('STARTING', 'ACTIVE', 'STOPPING')
      RETURNING *
    `, [hostId]);
    return result.rows.map(rowToWorld);
  }

  /**
   * Updates host status (e.g. UNHEALTHY) without touching last_heartbeat.
   * @param {string} hostId
   * @param {string} status
   * @returns {Promise<object|null>}
   */
  async updateHostStatus(hostId, status) {
    const result = await this.pool.query(`
      UPDATE hosts
      SET status = $2, updated_at = now()
      WHERE host_id = $1
      RETURNING host_id
    `, [hostId, status]);
    if (result.rowCount === 0) return null;
    return this.getHost(hostId);
  }

  /**
   * Deletes a dead host from the registry (for cleaning up terminated ephemeral EC2 instances).
   * @param {string} hostId
   * @returns {Promise<boolean>}
   */
  async deleteHost(hostId) {
    const result = await this.pool.query('DELETE FROM hosts WHERE host_id = $1', [hostId]);
    return result.rowCount > 0;
  }
}
