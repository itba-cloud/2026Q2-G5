ALTER TABLE worlds
  ADD COLUMN reservation_token TEXT,
  ADD COLUMN reservation_expires_at TIMESTAMPTZ,
  ADD COLUMN port_scope TEXT;

UPDATE worlds
SET port_scope = CASE
  WHEN hosts.host_ip IN ('127.0.0.1', 'localhost', '0.0.0.0', '::1') THEN 'loopback'
  ELSE worlds.host_id
END
FROM hosts
WHERE worlds.host_id = hosts.host_id AND worlds.port IS NOT NULL;

CREATE UNIQUE INDEX uq_worlds_scope_port ON worlds (port_scope, port)
  WHERE port_scope IS NOT NULL AND port IS NOT NULL;

CREATE INDEX idx_worlds_reservation_expiry ON worlds (reservation_expires_at)
  WHERE reservation_expires_at IS NOT NULL;

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
  COUNT(worlds.world_id) FILTER (
    WHERE worlds.status IN ('STARTING', 'ACTIVE', 'STOPPING')
  )::INTEGER AS active_worlds
FROM hosts
LEFT JOIN worlds ON worlds.host_id = hosts.host_id
GROUP BY hosts.host_id;
