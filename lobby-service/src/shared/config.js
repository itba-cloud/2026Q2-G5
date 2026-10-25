import path from 'node:path';
import fs from 'node:fs';

function positiveInt(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} debe ser un entero positivo`);
  return value;
}

const list = value => (value || '').split(',').map(s => s.trim()).filter(Boolean);

export const config = Object.freeze({
  port: parseInt(process.env.LOBBY_PORT || process.env.PORT || '3000', 10),
  host: process.env.LOBBY_HOST || process.env.HOST || '0.0.0.0',
  publicHost: process.env.PUBLIC_HOST || 'localhost',
  // Dirección por la que el Lobby alcanza a los World Hosts dentro de la VPC. En AWS
  // es la IP privada: PUBLIC_HOST sirve para armar la wsUrl de los jugadores, pero no
  // es enrutable desde la subred privada donde vive el Lobby.
  privateHost: process.env.PRIVATE_HOST || '',
  publicWsProtocol: process.env.PUBLIC_WS_PROTOCOL || 'ws',

  reconcileEnabled: process.env.RECONCILE_ENABLED !== 'false',
  reconcileOnRead: process.env.RECONCILE_ON_READ !== 'false',
  migrateOnStart: process.env.MIGRATE_ON_START !== 'false',
  lifecycleMode: process.env.LIFECYCLE_MODE || 'sync',
  startWorkflowArn: process.env.START_WORKFLOW_ARN || '',
  stopWorkflowArn: process.env.STOP_WORKFLOW_ARN || '',
  operationTimeoutSeconds: Number(process.env.OPERATION_TIMEOUT_SECONDS || 600),
  dbPoolMax: Number(process.env.DB_POOL_MAX || 10),

  // Storage configuration
  storageMode: (process.env.STORAGE_MODE || 'local').toLowerCase(), // 'local' | 'rds'
  dataDir: path.resolve(process.env.DATA_DIR || './.lobby_data'),
  seedDefaultHost: (process.env.SEED_DEFAULT_HOST || 'false').toLowerCase() === 'true',

  // RDS / PostgreSQL configuration (for when STORAGE_MODE=rds)
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'cloudgame',
    user: process.env.DB_USER || 'dbadmin',
    password: process.env.DB_PASSWORD || 'secret',
    ...(process.env.DB_CA_FILE && { ssl: {
      rejectUnauthorized: true, ca: fs.readFileSync(process.env.DB_CA_FILE, 'utf8'),
    } }),
  },

  // Vida de una reserva de inicio/parada. Si el worker que la tomo muere antes de
  // confirmarla, la reconciliacion libera host y puerto pasado este plazo.
  worldStartLeaseMs: parseInt(process.env.WORLD_START_LEASE_MS || '60000', 10),

  // Dynamic port allocation range for world instances
  worldPortRange: {
    min: parseInt(process.env.WORLD_PORT_MIN || '8001', 10),
    max: parseInt(process.env.WORLD_PORT_MAX || '8050', 10),
  },

  // Docker launcher mode
  useDockerMock: (process.env.USE_DOCKER_MOCK || 'false').toLowerCase() === 'true',

  // Donde corren los mundos: 'docker' (World Hosts EC2) o 'fargate' (una task ECS por mundo).
  worldLauncher: (process.env.WORLD_LAUNCHER || 'docker').toLowerCase(),
  // Plazo para que un mundo recien lanzado responda /health. Fargate necesita mas
  // que un host con la imagen ya cargada: provisiona la ENI y descarga la imagen.
  healthTimeoutMs: positiveInt('HEALTH_TIMEOUT_MS', 30000),
  fargate: {
    cluster: process.env.ECS_CLUSTER || '',
    taskDefinition: process.env.WORLD_TASK_DEFINITION || '',
    containerName: process.env.WORLD_TASK_CONTAINER || 'world',
    subnets: list(process.env.WORLD_TASK_SUBNETS),
    securityGroups: list(process.env.WORLD_TASK_SECURITY_GROUPS),
    assignPublicIp: process.env.WORLD_TASK_PUBLIC_IP !== 'false',
    port: positiveInt('WORLD_TASK_PORT', 8001),
  },

  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()),

  // Cross-world messaging bus. The Lobby only publishes announcements here;
  // worlds are the ones that subscribe. See world-service/src/config.js for why
  // unset and set-but-empty mean different things.
  redisUrl: process.env.REDIS_URL === undefined ? 'redis://127.0.0.1:6379' : process.env.REDIS_URL,
  globalChannel: process.env.GLOBAL_CHANNEL || 'world-events',
  announcementMaxLength: parseInt(process.env.ANNOUNCEMENT_MAX_LENGTH || '200', 10),
});
