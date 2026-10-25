"""
Reconciler: keeps this replica's bot pools in line with the worlds it leases.

Every tick it renews its leases, drops the pools of worlds it no longer owns or that
no longer want bots, re-provisions pools whose target changed, and claims new worlds
while it has capacity. The loop is level-triggered: a missed tick or a failed query
is corrected by the next one, so no Lobby event can be lost.
"""

import asyncio
import logging
import time
from typing import Awaitable, Callable, Dict, List, Optional

from src.manager.bot_manager import BotManager
from src.store.lease_store import LeaseStore, OwnedWorld

logger = logging.getLogger("Reconciler")


class Reconciler:
    def __init__(
        self,
        manager: BotManager,
        connect: Callable[[], Awaitable[LeaseStore]],
        *,
        interval_seconds: float = 3.0,
        lease_ttl_seconds: float = 15.0,
        max_worlds: int = 10,
        claim_batch: int = 2,
        spawn_options: Optional[dict] = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.manager = manager
        self.connect = connect
        self.interval_seconds = interval_seconds
        self.lease_ttl_seconds = lease_ttl_seconds
        self.max_worlds = max_worlds
        self.claim_batch = claim_batch
        self.spawn_options = spawn_options or {}
        self.clock = clock
        self.store: Optional[LeaseStore] = None
        self.owned: Dict[str, OwnedWorld] = {}
        self.last_success_at: Optional[float] = None
        self._task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------ loop

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="npc-reconciler")

    async def _run(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - the next tick retries
                logger.warning(f"Reconcile tick failed: {exc}")
                await self._fence_if_lease_expired()
            await asyncio.sleep(self.interval_seconds)

    async def tick(self) -> None:
        if self.store is None:
            self.store = await self.connect()

        owned = await self.store.renew()
        released = await self._converge(owned)

        capacity = self.max_worlds - (len(owned) - len(released))
        claimed = await self.store.claim(min(capacity, self.claim_batch))
        if claimed:
            logger.info(f"Claimed world(s) {', '.join(claimed)}.")
            owned = await self.store.renew()
            await self._converge(owned)

        self.owned = {w: o for w, o in owned.items() if o.wanted}
        self.last_success_at = self.clock()

    async def _converge(self, owned: Dict[str, OwnedWorld]) -> List[str]:
        # A pool whose lease is gone belongs to another replica now (we paused past
        # the TTL): stop it before that replica's bots join, never after.
        for world_id in list(self.manager.pools):
            if world_id not in owned:
                logger.warning(f"Lease of world '{world_id}' lost; despawning its bots.")
                await self.manager.despawn_bots_for_world(world_id)

        released = [w for w, o in owned.items() if not o.wanted]
        for world_id in released:
            await self.manager.despawn_bots_for_world(world_id)
        # Bots go first: another replica may claim the world as soon as the row is gone.
        await self.store.release(released)

        for world_id, target in owned.items():
            if target.wanted and not self._pool_matches(world_id, target):
                await self.manager.spawn_bots_for_world(
                    world_id=world_id,
                    ws_url=target.ws_url,
                    count=target.bot_count,
                    runtime_id=target.runtime_id,
                    **self.spawn_options,
                )
        return released

    def _pool_matches(self, world_id: str, target: OwnedWorld) -> bool:
        pool = self.manager.pools.get(world_id)
        return bool(
            pool
            and pool.runtime_id == target.runtime_id
            and pool.ws_url == target.ws_url
            and len(pool.clients) == target.bot_count
        )

    async def _fence_if_lease_expired(self) -> None:
        """
        Without the database this replica cannot renew. Once its leases may have
        expired another replica can own the worlds, so its own bots must go.
        """
        if not self.manager.pools:
            return
        last = self.last_success_at
        if last is None or self.clock() - last >= self.lease_ttl_seconds * 0.8:
            logger.warning("Leases could not be renewed in time; despawning every bot pool.")
            await self.manager.stop_all()
            self.owned = {}

    # ---------------------------------------------------------------- status

    def is_healthy(self, max_age_seconds: float = 30.0) -> bool:
        return self.last_success_at is not None and self.clock() - self.last_success_at <= max_age_seconds

    def get_status(self) -> dict:
        age = None if self.last_success_at is None else round(self.clock() - self.last_success_at, 1)
        return {
            "ownedWorlds": sorted(self.owned),
            "lastReconcileAgeSeconds": age,
            "maxWorlds": self.max_worlds,
        }

    # -------------------------------------------------------------- shutdown

    async def stop(self) -> None:
        """Stops the loop, the bots and then frees the leases for other replicas."""
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        await self.manager.stop_all()
        if self.store is not None:
            try:
                await self.store.release_all()
                logger.info("Released every lease held by this replica.")
            except Exception as exc:  # noqa: BLE001 - the leases still expire on their own
                logger.warning(f"Could not release leases on shutdown: {exc}")
            await self.store.close()
            self.store = None
