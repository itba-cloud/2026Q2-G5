import { randomUUID, createHash } from 'node:crypto';
import { OperationError, LIVE, TERMINAL } from '../lifecycle/errors.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])])
  );
  return value;
}

export class RdsOperationRepository {
  constructor(worlds, config) {
    this.worlds = worlds;
    this.pool = worlds.pool;
    this.config = config;
    if (!this.pool) throw new Error('Asynchronous lifecycle requires PostgreSQL');
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async get(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id || '')) return null;
    return (await this.pool.query('SELECT * FROM lobby_operations WHERE operation_id=$1', [id])).rows[0] || null;
  }

  async accept({ kind, worldId, create, payload = {}, key = randomUUID(), visibility = 'public' }) {
    if (typeof key !== 'string' || !key.length || key.length > 128) {
      throw new OperationError('INVALID_KEY', 'Idempotency-Key debe tener entre 1 y 128 caracteres', 400);
    }
    const scope = `${visibility}:${create ? 'CREATE' : kind}:${create ? '' : worldId}`;
    const hash = createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
    return this.transaction(async client => {
      // Serialize only repeated keys, including CREATEs that have no world row yet.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${scope}:${key}`]);
      const old = (await client.query(`SELECT * FROM lobby_operations
        WHERE idempotency_scope=$1 AND idempotency_key=$2`, [scope, key])).rows[0];
      if (old) {
        if (old.request_hash !== hash) throw new OperationError('IDEMPOTENCY_CONFLICT', 'La clave ya fue usada con otros datos');
        return old;
      }
      if (create) {
        worldId = create.id;
        await client.query(`INSERT INTO worlds(world_id,name,status,seed,biome,max_players,bot_count)
          VALUES($1,$2,'INACTIVE',$3,$4,$5,$6)`,
        [worldId, create.name, create.seed, create.biome, create.maxPlayers, create.botCount]);
      }
      const world = (await client.query('SELECT * FROM worlds WHERE world_id=$1 FOR UPDATE', [worldId])).rows[0];
      if (!world) throw new OperationError('WORLD_NOT_FOUND', 'Mundo no encontrado', 404);
      if (kind === 'DELETE' && world.is_default && !payload.force) {
        throw new OperationError('DEFAULT_WORLD', 'No se puede eliminar el mundo por defecto', 400);
      }
      if (kind === 'SELF_SHUTDOWN' && (world.status === 'INACTIVE' || (world.runtime_id || null) !== (payload.runtimeId || null))) {
        throw new OperationError('STALE_RUNTIME', 'El aviso pertenece a otra ejecución del mundo');
      }
      const pending = (await client.query(`SELECT * FROM lobby_operations
        WHERE world_id=$1 AND status=ANY($2) ORDER BY created_at`, [worldId, LIVE])).rows;
      const conflicting = pending.find(op => kind === 'START' || op.kind !== 'START');
      if (conflicting) throw new OperationError('OPERATION_PENDING', 'El mundo tiene una operación pendiente', 409, conflicting.operation_id);
      if (kind !== 'START') {
        await client.query(`UPDATE lobby_operations SET cancel_requested=true, updated_at=now()
          WHERE world_id=$1 AND kind='START' AND status=ANY($2)`, [worldId, LIVE]);
      }
      const version = kind === 'START' ? this.config.startWorkflowArn : this.config.stopWorkflowArn;
      if (!version || !/:stateMachine:[^:]+:\d+$/.test(version)) throw new OperationError('WORKFLOW_NOT_CONFIGURED', 'Workflow no configurado', 503);
      const id = randomUUID();
      return (await client.query(`INSERT INTO lobby_operations(
        operation_id,world_id,target_world_id,kind,visibility,idempotency_scope,idempotency_key,
        request_hash,request,workflow_version_arn,deadline_at)
        VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,now()+make_interval(secs=>$10::numeric)) RETURNING *`,
      [id, worldId, kind, visibility, scope, key, hash, payload, version, this.config.operationTimeoutSeconds || 600])).rows[0];
    });
  }

  // All multi-row lifecycle transactions lock world, then operation. Never perform I/O in fn.
  async locked(id, fn) {
    const snapshot = await this.get(id);
    if (!snapshot) throw new OperationError('OPERATION_NOT_FOUND', 'Operación no encontrada', 404);
    return this.transaction(async client => {
      const world = (await client.query('SELECT * FROM worlds WHERE world_id=$1 FOR UPDATE', [snapshot.target_world_id])).rows[0];
      const op = (await client.query('SELECT * FROM lobby_operations WHERE operation_id=$1 FOR UPDATE', [id])).rows[0];
      return fn(client, op, world);
    });
  }

  async claimTask(id, { recovery = false, executionArn } = {}) {
    return this.locked(id, async (client, op) => {
      if (TERMINAL.has(op.status)) return { terminal: op };
      if (op.status === 'RECOVERY_PENDING' && !recovery) return { deferred: op };
      if (op.task_expires_at && new Date(op.task_expires_at) > new Date()) {
        throw new OperationError('TASK_BUSY', 'Otra tarea todavía está ejecutándose', 503);
      }
      if (executionArn && op.execution_arn && op.execution_arn !== executionArn) {
        throw new OperationError('EXECUTION_MISMATCH', 'Ejecución ajena', 409);
      }
      const token = randomUUID();
      const result = await client.query(`UPDATE lobby_operations SET
        task_token=$2, task_expires_at=now()+interval '45 seconds',
        execution_arn=COALESCE(execution_arn,$3),
        status=CASE WHEN status='ACCEPTED' THEN 'RUNNING' ELSE status END, updated_at=now()
        WHERE operation_id=$1 RETURNING *`, [id, token, executionArn || null]);
      return { op: result.rows[0], token };
    });
  }

  async taskWrite(id, token, fn) {
    return this.locked(id, async (client, op, world) => {
      if (op.task_token !== token || new Date(op.task_expires_at) <= new Date()) {
        throw new OperationError('TASK_OWNERSHIP_LOST', 'La tarea perdió su lease', 409);
      }
      return fn(client, op, world);
    });
  }

  async releaseTask(id, token) {
    await this.pool.query(`UPDATE lobby_operations SET task_token=NULL,task_expires_at=NULL
      WHERE operation_id=$1 AND task_token=$2`, [id, token]);
  }

  async claimDispatch(limit = 10, operationId = null) {
    return (await this.pool.query(`WITH pending AS (
      SELECT operation_id FROM lobby_operations WHERE status='ACCEPTED' AND next_attempt_at<=now()
        AND (dispatch_expires_at IS NULL OR dispatch_expires_at<now())
        AND ($2::uuid IS NULL OR operation_id=$2)
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE lobby_operations op SET dispatch_token=gen_random_uuid(),
      dispatch_expires_at=now()+interval '30 seconds',dispatch_attempts=dispatch_attempts+1
      FROM pending WHERE op.operation_id=pending.operation_id RETURNING op.*`, [limit, operationId])).rows;
  }

  async checkpoint(name) {
    return (await this.pool.query('SELECT cursor FROM lobby_maintenance_progress WHERE name=$1', [name])).rows[0]?.cursor || '';
  }

  async saveCheckpoint(name, cursor, token) {
    const result = await this.pool.query(`INSERT INTO lobby_maintenance_progress(name,cursor)
      SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM lobby_worker_leases
        WHERE name='reconciliation' AND token=$3 AND expires_at>now())
      ON CONFLICT(name) DO UPDATE SET cursor=EXCLUDED.cursor,updated_at=now() RETURNING name`, [name, cursor, token]);
    if (!result.rowCount) throw new Error('Maintenance lease lost');
  }

  async dispatched(op, arn) {
    await this.pool.query(`UPDATE lobby_operations SET execution_arn=$3,
      status=CASE WHEN status='ACCEPTED' THEN 'RUNNING' ELSE status END,
      dispatch_token=NULL,dispatch_expires_at=NULL,updated_at=now()
      WHERE operation_id=$1 AND dispatch_token=$2`, [op.operation_id, op.dispatch_token, arn]);
  }

  async dispatchFailed(op) {
    await this.pool.query(`UPDATE lobby_operations SET dispatch_token=NULL,dispatch_expires_at=NULL,
      next_attempt_at=now()+make_interval(secs=>$3::numeric),updated_at=now()
      WHERE operation_id=$1 AND dispatch_token=$2`,
    [op.operation_id, op.dispatch_token, Math.min(60, 2 ** Math.min(op.dispatch_attempts, 6))]);
  }

  async lease(name, token, seconds = 45) {
    return (await this.pool.query(`INSERT INTO lobby_worker_leases(name,token,expires_at)
      VALUES($1,$2,now()+make_interval(secs=>$3::numeric))
      ON CONFLICT(name) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
      WHERE lobby_worker_leases.expires_at<now() OR lobby_worker_leases.token=$2 RETURNING token`,
    [name, token, seconds])).rowCount === 1;
  }

  async releaseLease(name, token) {
    await this.pool.query('DELETE FROM lobby_worker_leases WHERE name=$1 AND token=$2', [name, token]);
  }

  async hasPlacedWorlds(hostId) {
    return (await this.pool.query(`SELECT 1 FROM worlds
      WHERE host_id=$1 AND status IN ('STARTING','ACTIVE','STOPPING') LIMIT 1`, [hostId])).rowCount > 0;
  }

  // Worlds with a live operation are left to its workflow and recovery. A stop that
  // already claimed the world can never reach the dead host, so it is told the container is gone.
  async releaseWorldsOnRetiredHost(hostId) {
    return this.transaction(async client => {
      const placed = (await client.query(`SELECT world_id FROM worlds
        WHERE host_id=$1 AND status IN ('STARTING','ACTIVE','STOPPING') ORDER BY world_id FOR UPDATE`, [hostId])).rows;
      const released = [];
      const stopping = [];
      for (const { world_id: worldId } of placed) {
        const live = (await client.query(`SELECT 1 FROM lobby_operations
          WHERE world_id=$1 AND status=ANY($2) LIMIT 1`, [worldId, LIVE])).rowCount > 0;
        if (live) {
          const claimed = await client.query(`UPDATE lobby_operations
            SET context=jsonb_set(context,'{phase}','"REMOVED"'),updated_at=now()
            WHERE world_id=$1 AND status=ANY($2) AND kind<>'START'
              AND context->>'phase'='CLAIMED' AND context->>'hostId'=$3`, [worldId, LIVE, hostId]);
          if (claimed.rowCount) stopping.push(worldId);
          continue;
        }
        await client.query(`UPDATE worlds SET status='INACTIVE',host_id=NULL,port=NULL,port_scope=NULL,
          ws_url=NULL,npc_ws_url=NULL,npc_bot_count=0,container_id=NULL,players_count=0,
          reservation_token=NULL,reservation_expires_at=NULL,updated_at=now()
          WHERE world_id=$1`, [worldId]);
        released.push(worldId);
      }
      return { released, stopping };
    });
  }
}
