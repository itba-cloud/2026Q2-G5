ALTER TABLE worlds ADD COLUMN runtime_id UUID;

CREATE TABLE lobby_operations (
  operation_id UUID PRIMARY KEY,
  world_id TEXT REFERENCES worlds(world_id) ON DELETE SET NULL,
  target_world_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('START', 'STOP', 'DELETE', 'SELF_SHUTDOWN')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
  status TEXT NOT NULL DEFAULT 'ACCEPTED'
    CHECK (status IN ('ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'RECOVERY_PENDING')),
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL,
  request JSONB NOT NULL DEFAULT '{}',
  context JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  error JSONB,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  workflow_version_arn TEXT NOT NULL,
  execution_arn TEXT,
  dispatch_token UUID,
  dispatch_expires_at TIMESTAMPTZ,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_token UUID,
  task_expires_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (idempotency_scope, idempotency_key)
);

CREATE INDEX idx_operations_world ON lobby_operations(world_id);
CREATE INDEX idx_operations_target ON lobby_operations(target_world_id, created_at DESC);
CREATE INDEX idx_operations_dispatch ON lobby_operations(next_attempt_at, created_at)
  WHERE status = 'ACCEPTED';
CREATE INDEX idx_operations_recovery ON lobby_operations(updated_at)
  WHERE status IN ('RUNNING', 'RECOVERY_PENDING');

CREATE TABLE lobby_worker_leases (
  name TEXT PRIMARY KEY,
  token UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
