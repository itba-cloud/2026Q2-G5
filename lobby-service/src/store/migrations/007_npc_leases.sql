-- The NPC Service runs as N replicas that assign worlds to themselves. A world
-- wants bots while it is ACTIVE with npc_bot_count > 0; npc_ws_url is the
-- address the bots dial (the world's private endpoint, not the public one).
-- npc_bot_count belongs to the current runtime, so a per-start botCount override
-- does not overwrite the world's configured bot_count.
ALTER TABLE worlds
  ADD COLUMN npc_ws_url TEXT,
  ADD COLUMN npc_bot_count INTEGER NOT NULL DEFAULT 0 CHECK (npc_bot_count >= 0);

-- One row per world owned by an NPC replica. The owner renews lease_expires_at
-- every reconcile tick; an expired lease may be taken over by any replica.
-- runtime_id fences the lease to one execution of the world.
CREATE TABLE npc_leases (
  world_id TEXT PRIMARY KEY REFERENCES worlds(world_id) ON DELETE CASCADE,
  runtime_id TEXT,
  owner_id TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_npc_leases_owner ON npc_leases (owner_id);
CREATE INDEX idx_worlds_npc_wanted ON worlds (updated_at) WHERE status = 'ACTIVE' AND npc_bot_count > 0;
