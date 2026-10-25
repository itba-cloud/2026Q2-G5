ALTER TABLE hosts DROP CONSTRAINT IF EXISTS hosts_status_check;
ALTER TABLE hosts ADD CONSTRAINT hosts_status_check CHECK (status IN ('HEALTHY', 'DEGRADED', 'DRAINING', 'DOWN', 'UNHEALTHY'));

UPDATE hosts SET is_permanent = false;
