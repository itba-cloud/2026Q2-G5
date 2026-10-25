-- Independent cursors prevent a slow/unreachable record from starving other stages.
-- The small fixed set of rows is written only by the shared maintenance lease owner.
CREATE TABLE lobby_maintenance_progress (
  name TEXT PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_operations_maintenance_cursor ON lobby_operations(operation_id)
  WHERE status IN ('RUNNING', 'RECOVERY_PENDING');
CREATE INDEX idx_worlds_maintenance_cursor ON worlds(world_id) WHERE status = 'ACTIVE';
