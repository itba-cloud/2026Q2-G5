ALTER TABLE hosts
  ADD COLUMN public_ws_protocol TEXT NOT NULL DEFAULT 'ws'
    CHECK (public_ws_protocol IN ('ws', 'wss')),
  ADD COLUMN port_min INTEGER NOT NULL DEFAULT 8001
    CHECK (port_min BETWEEN 1 AND 65535),
  ADD COLUMN port_max INTEGER NOT NULL DEFAULT 8050
    CHECK (port_max BETWEEN 1 AND 65535),
  ADD COLUMN is_permanent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN hierarchy INTEGER NOT NULL DEFAULT 50
    CHECK (hierarchy >= 0),
  ADD CONSTRAINT chk_hosts_port_range CHECK (port_min <= port_max);

DROP VIEW host_load;

CREATE VIEW host_load AS
SELECT
  hosts.host_id,
  hosts.name,
  hosts.host_ip,
  hosts.public_host,
  hosts.public_ws_protocol,
  hosts.docker_api_url,
  hosts.port_min,
  hosts.port_max,
  hosts.max_worlds,
  hosts.status,
  hosts.is_permanent,
  hosts.hierarchy,
  hosts.last_heartbeat,
  hosts.created_at,
  hosts.updated_at,
  COUNT(worlds.world_id) FILTER (WHERE worlds.status = 'ACTIVE')::INTEGER AS active_worlds
FROM hosts
LEFT JOIN worlds ON worlds.host_id = hosts.host_id
GROUP BY hosts.host_id;
