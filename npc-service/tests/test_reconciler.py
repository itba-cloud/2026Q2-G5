"""
Reconciler against an in-memory lease store and a recording bot manager: no sockets,
no database. The SQL itself is covered by test_lease_store.py.
"""

import pytest

from src.manager.reconciler import Reconciler
from src.store.lease_store import OwnedWorld


class FakePool:
    def __init__(self, ws_url, runtime_id, count):
        self.ws_url = ws_url
        self.runtime_id = runtime_id
        self.clients = [object()] * count


class RecordingManager:
    def __init__(self):
        self.pools = {}
        self.calls = []

    async def spawn_bots_for_world(self, world_id, ws_url, count, runtime_id=None, **_):
        self.calls.append(("spawn", world_id, runtime_id, count))
        self.pools[world_id] = FakePool(ws_url, runtime_id, count)

    async def despawn_bots_for_world(self, world_id):
        self.calls.append(("despawn", world_id))
        return len(self.pools.pop(world_id, FakePool("", "", 0)).clients)

    async def stop_all(self):
        for world_id in list(self.pools):
            await self.despawn_bots_for_world(world_id)


class FakeStore:
    """`worlds` is what the Lobby wrote; `leases` maps world -> owner."""

    def __init__(self, owner="me"):
        self.owner = owner
        self.worlds = {}
        self.leases = {}
        self.failing = False
        self.released_all = False
        self.claim_limits = []

    def world(self, world_id, runtime="run-1", status="ACTIVE", bots=2, url=None):
        self.worlds[world_id] = {"status": status, "runtime": runtime, "bots": bots,
                                 "url": url or f"ws://10.0.0.1/{world_id}"}

    async def renew(self):
        if self.failing:
            raise ConnectionError("database unreachable")
        owned = {}
        for world_id, (owner, runtime) in self.leases.items():
            w = self.worlds.get(world_id)
            if owner != self.owner or w is None:
                continue
            wanted = w["status"] == "ACTIVE" and w["bots"] > 0 and w["runtime"] == runtime
            owned[world_id] = OwnedWorld(world_id, runtime, w["url"], w["bots"], wanted)
        return owned

    async def claim(self, limit):
        self.claim_limits.append(limit)
        claimed = []
        for world_id, w in self.worlds.items():
            if len(claimed) >= limit:
                break
            if world_id not in self.leases and w["status"] == "ACTIVE" and w["bots"] > 0:
                self.leases[world_id] = (self.owner, w["runtime"])
                claimed.append(world_id)
        return claimed

    async def release(self, world_ids):
        for world_id in world_ids:
            if self.leases.get(world_id, (None,))[0] == self.owner:
                del self.leases[world_id]

    async def release_all(self):
        self.released_all = True
        await self.release(list(self.leases))

    async def close(self):
        pass


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def make(store, manager=None, clock=None, **kwargs):
    manager = manager or RecordingManager()

    async def connect():
        return store

    options = {"max_worlds": 10, "claim_batch": 2, "lease_ttl_seconds": 15, **kwargs}
    return Reconciler(manager, connect, clock=clock or Clock(), **options), manager


@pytest.mark.asyncio
async def test_claims_worlds_and_spawns_their_bots_in_the_same_tick():
    store = FakeStore()
    store.world("w1", bots=3)
    reconciler, manager = make(store)

    await reconciler.tick()

    assert manager.calls == [("spawn", "w1", "run-1", 3)]
    assert manager.pools["w1"].ws_url == "ws://10.0.0.1/w1"
    assert reconciler.get_status()["ownedWorlds"] == ["w1"]

    await reconciler.tick()
    assert manager.calls == [("spawn", "w1", "run-1", 3)], "A pool that matches its target is left alone"


@pytest.mark.asyncio
async def test_stopped_world_despawns_before_its_lease_is_released():
    store = FakeStore()
    store.world("w1")
    reconciler, manager = make(store)
    await reconciler.tick()

    store.worlds["w1"]["status"] = "STOPPING"
    await reconciler.tick()

    assert manager.calls[-1] == ("despawn", "w1")
    assert "w1" not in store.leases
    assert reconciler.get_status()["ownedWorlds"] == []


@pytest.mark.asyncio
async def test_restarted_world_is_released_and_claimed_again_with_its_new_runtime():
    store = FakeStore()
    store.world("w1", runtime="run-1")
    reconciler, manager = make(store)
    await reconciler.tick()

    store.world("w1", runtime="run-2", url="ws://10.0.0.9/w1")
    await reconciler.tick()

    assert manager.calls[1] == ("despawn", "w1")
    assert manager.calls[-1] == ("spawn", "w1", "run-2", 2)
    assert manager.pools["w1"].ws_url == "ws://10.0.0.9/w1"
    assert store.leases["w1"] == ("me", "run-2")


@pytest.mark.asyncio
async def test_a_lease_taken_by_another_replica_stops_the_local_bots():
    store = FakeStore()
    store.world("w1")
    reconciler, manager = make(store)
    await reconciler.tick()

    store.leases["w1"] = ("other-replica", "run-1")
    await reconciler.tick()

    assert manager.calls[-1] == ("despawn", "w1")
    assert manager.pools == {}


@pytest.mark.asyncio
async def test_capacity_and_claim_batch_bound_each_tick():
    store = FakeStore()
    for i in range(5):
        store.world(f"w{i}")
    reconciler, manager = make(store, max_worlds=3, claim_batch=2)

    await reconciler.tick()
    assert len(manager.pools) == 2
    await reconciler.tick()
    assert len(manager.pools) == 3
    await reconciler.tick()
    assert len(manager.pools) == 3
    assert store.claim_limits == [2, 1, 0]


@pytest.mark.asyncio
async def test_a_database_outage_past_the_lease_ttl_fences_the_bots():
    store = FakeStore()
    store.world("w1")
    clock = Clock()
    reconciler, manager = make(store, clock=clock)
    await reconciler.tick()
    assert reconciler.is_healthy()

    store.failing = True
    clock.now += 5
    await reconciler._fence_if_lease_expired()
    assert "w1" in manager.pools, "A short outage keeps the bots: the lease is still valid"

    clock.now += 10
    await reconciler._fence_if_lease_expired()
    assert manager.pools == {}
    assert not reconciler.is_healthy(max_age_seconds=10)


@pytest.mark.asyncio
async def test_stop_despawns_everything_and_frees_the_leases():
    store = FakeStore()
    store.world("w1")
    store.world("w2")
    reconciler, manager = make(store)
    await reconciler.tick()

    await reconciler.stop()

    assert manager.pools == {}
    assert store.released_all and store.leases == {}
