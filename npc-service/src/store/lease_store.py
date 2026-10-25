"""
LeaseStore: which worlds this NPC replica owns, kept in the npc_leases table.

A world wants bots while it is ACTIVE with npc_bot_count > 0 (the Lobby writes both
columns when the world starts). Each replica renews its leases every reconcile tick;
a lease that is not renewed within its TTL may be taken over by any replica.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass(frozen=True)
class OwnedWorld:
    """A leased world and whether it still wants bots from this lease."""

    world_id: str
    runtime_id: Optional[str]
    ws_url: Optional[str]
    bot_count: int
    wanted: bool


# Renewing and reading the target in one statement keeps a tick to two round trips.
# A lease whose world restarted with another runtime is no longer wanted: the owner
# releases it and the next claim takes the world again with its new runtime.
_RENEW_SQL = """
UPDATE npc_leases l
SET lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
FROM worlds w
WHERE l.owner_id = $1 AND w.world_id = l.world_id
RETURNING l.world_id, l.runtime_id, w.status, w.runtime_id::text AS world_runtime_id,
          w.npc_ws_url, w.npc_bot_count
"""

# ON CONFLICT ... WHERE is atomic per row: when two replicas race for the same
# world, only one gets it back in RETURNING. No row of worlds is locked, so the
# Lobby's writes never wait on an NPC replica.
_CLAIM_SQL = """
INSERT INTO npc_leases (world_id, runtime_id, owner_id, lease_expires_at)
SELECT w.world_id, w.runtime_id::text, $1, now() + make_interval(secs => $2)
FROM worlds w LEFT JOIN npc_leases l USING (world_id)
WHERE w.status = 'ACTIVE' AND w.npc_bot_count > 0 AND w.npc_ws_url IS NOT NULL
  AND (l.world_id IS NULL OR l.lease_expires_at < now())
ORDER BY w.updated_at
LIMIT $3
ON CONFLICT (world_id) DO UPDATE
  SET owner_id = EXCLUDED.owner_id, runtime_id = EXCLUDED.runtime_id,
      lease_expires_at = EXCLUDED.lease_expires_at, acquired_at = now(), updated_at = now()
  WHERE npc_leases.lease_expires_at < now()
RETURNING world_id
"""


class LeaseStore:
    def __init__(self, pool, owner_id: str, ttl_seconds: float):
        self.pool = pool
        self.owner_id = owner_id
        self.ttl_seconds = float(ttl_seconds)

    async def renew(self) -> Dict[str, OwnedWorld]:
        """Extends every lease this replica holds and returns them with their target."""
        rows = await self.pool.fetch(_RENEW_SQL, self.owner_id, self.ttl_seconds)
        owned = {}
        for row in rows:
            wanted = (
                row["status"] == "ACTIVE"
                and row["npc_bot_count"] > 0
                and bool(row["npc_ws_url"])
                and row["runtime_id"] == row["world_runtime_id"]
            )
            owned[row["world_id"]] = OwnedWorld(
                world_id=row["world_id"],
                runtime_id=row["runtime_id"],
                ws_url=row["npc_ws_url"],
                bot_count=int(row["npc_bot_count"]),
                wanted=wanted,
            )
        return owned

    async def claim(self, limit: int) -> List[str]:
        """Takes up to `limit` worlds that want bots and have no live owner."""
        if limit <= 0:
            return []
        rows = await self.pool.fetch(_CLAIM_SQL, self.owner_id, self.ttl_seconds, limit)
        return [row["world_id"] for row in rows]

    async def release(self, world_ids: List[str]) -> None:
        if world_ids:
            await self.pool.execute(
                "DELETE FROM npc_leases WHERE owner_id = $1 AND world_id = ANY($2::text[])",
                self.owner_id, list(world_ids),
            )

    async def release_all(self) -> None:
        await self.pool.execute("DELETE FROM npc_leases WHERE owner_id = $1", self.owner_id)

    async def close(self) -> None:
        await self.pool.close()
