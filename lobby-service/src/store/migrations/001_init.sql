CREATE TABLE hosts (
  host_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_ip TEXT NOT NULL,
  public_host TEXT NOT NULL,
  docker_api_url TEXT,
  max_worlds INTEGER NOT NULL DEFAULT 10 CHECK (max_worlds > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'HEALTHY'
    CHECK (status IN ('HEALTHY', 'DEGRADED', 'DRAINING', 'DOWN')),
  last_heartbeat TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE worlds (
  world_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'INACTIVE'
    CHECK (status IN ('INACTIVE', 'STARTING', 'ACTIVE', 'STOPPING')),
  seed INTEGER NOT NULL,
  biome TEXT NOT NULL DEFAULT 'forest',
  host_id TEXT REFERENCES hosts(host_id) ON DELETE SET NULL,
  port INTEGER CHECK (port BETWEEN 1 AND 65535),
  ws_url TEXT,
  container_id TEXT,
  players_count INTEGER NOT NULL DEFAULT 0 CHECK (players_count >= 0),
  max_players INTEGER NOT NULL DEFAULT 20 CHECK (max_players > 0),
  bot_count INTEGER NOT NULL DEFAULT 0 CHECK (bot_count >= 0),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_worlds_host_port ON worlds (host_id, port)
  WHERE host_id IS NOT NULL AND port IS NOT NULL;

CREATE INDEX idx_worlds_status ON worlds (status);
CREATE INDEX idx_worlds_host ON worlds (host_id) WHERE host_id IS NOT NULL;

CREATE VIEW host_load AS
SELECT
  hosts.host_id,
  hosts.name,
  hosts.host_ip,
  hosts.public_host,
  hosts.docker_api_url,
  hosts.max_worlds,
  hosts.status,
  hosts.last_heartbeat,
  hosts.created_at,
  hosts.updated_at,
  COUNT(worlds.world_id) FILTER (WHERE worlds.status = 'ACTIVE')::INTEGER AS active_worlds
FROM hosts
LEFT JOIN worlds ON worlds.host_id = hosts.host_id
GROUP BY hosts.host_id;
