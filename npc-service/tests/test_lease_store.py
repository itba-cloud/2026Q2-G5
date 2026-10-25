"""
LeaseStore against a real PostgreSQL, on the schema the Lobby's migrations build.

Needs TEST_DATABASE_URL, like the Lobby's serverless tests; each test runs in its
own schema. Skipped when the variable is not set.
"""

import asyncio
import os
import uuid
from pathlib import Path

import pytest
import pytest_asyncio

from src.store.lease_store import LeaseStore

asyncpg = pytest.importorskip("asyncpg")

DATABASE_URL = os.getenv("TEST_DATABASE_URL")
MIGRATIONS = Path(__file__).resolve().parents[2] / "lobby-service" / "src" / "store" / "migrations"

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not set")


@pytest_asyncio.fixture
async def db():
    schema = f"npc_test_{uuid.uuid4().hex}"
    admin = await asyncpg.connect(DATABASE_URL)
    await admin.execute(f"CREATE SCHEMA {schema}")
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=4,
                                     server_settings={"search_path": schema})
    async with pool.acquire() as conn:
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            await conn.execute(migration.read_text())
    try:
        yield pool
    finally:
        await pool.close()
        await admin.execute(f"DROP SCHEMA {schema} CASCADE")
        await admin.close()


async def add_world(pool, world_id, status="ACTIVE", bots=2, url="ws://10.0.1.7:8001"):
    runtime = str(uuid.uuid4())
    await pool.execute(
        """INSERT INTO worlds (world_id, name, seed, status, runtime_id, npc_ws_url, npc_bot_count)
           VALUES ($1, $1, 1, $2, $3::uuid, $4, $5)""",
        world_id, status, runtime, url, bots)
    return runtime


async def expire(pool, world_id):
    await pool.execute(
        "UPDATE npc_leases SET lease_expires_at = now() - interval '1 second' WHERE world_id = $1", world_id)


@pytest.mark.asyncio
async def test_claims_only_worlds_that_want_bots(db):
    runtime = await add_world(db, "active")
    await add_world(db, "no-bots", bots=0)
    await add_world(db, "starting", status="STARTING")
    store = LeaseStore(db, "replica-a", ttl_seconds=15)

    assert await store.claim(10) == ["active"]
    owned = await store.renew()
    assert list(owned) == ["active"]
    assert owned["active"].wanted
    assert owned["active"].runtime_id == runtime
    assert (owned["active"].ws_url, owned["active"].bot_count) == ("ws://10.0.1.7:8001", 2)


@pytest.mark.asyncio
async def test_a_live_lease_is_never_taken_and_an_expired_one_is(db):
    await add_world(db, "w1")
    a = LeaseStore(db, "replica-a", ttl_seconds=15)
    b = LeaseStore(db, "replica-b", ttl_seconds=15)

    assert await a.claim(10) == ["w1"]
    assert await b.claim(10) == []

    await expire(db, "w1")
    assert await b.claim(10) == ["w1"]
    assert await a.renew() == {}, "The previous owner learns it lost the world on its next renew"
    assert list(await b.renew()) == ["w1"]


@pytest.mark.asyncio
async def test_concurrent_claims_hand_each_world_to_one_replica(db):
    worlds = [f"w{i}" for i in range(6)]
    for world_id in worlds:
        await add_world(db, world_id)
    stores = [LeaseStore(db, f"replica-{i}", ttl_seconds=15) for i in range(4)]

    results = await asyncio.gather(*(store.claim(10) for store in stores))

    claimed = [world_id for result in results for world_id in result]
    assert sorted(claimed) == sorted(worlds)
    assert len(claimed) == len(set(claimed))


@pytest.mark.asyncio
async def test_restarted_or_stopped_worlds_are_no_longer_wanted(db):
    await add_world(db, "restarted")
    await add_world(db, "stopped")
    store = LeaseStore(db, "replica-a", ttl_seconds=15)
    await store.claim(10)

    await db.execute("UPDATE worlds SET runtime_id = gen_random_uuid() WHERE world_id = 'restarted'")
    await db.execute("UPDATE worlds SET status = 'STOPPING' WHERE world_id = 'stopped'")
    owned = await store.renew()

    assert not owned["restarted"].wanted
    assert not owned["stopped"].wanted


@pytest.mark.asyncio
async def test_release_frees_worlds_for_other_replicas(db):
    await add_world(db, "w1")
    await add_world(db, "w2")
    a = LeaseStore(db, "replica-a", ttl_seconds=15)
    b = LeaseStore(db, "replica-b", ttl_seconds=15)
    await a.claim(10)

    await a.release(["w1"])
    assert await b.claim(10) == ["w1"]

    await a.release_all()
    assert await b.claim(10) == ["w2"]
    assert await a.renew() == {}


@pytest.mark.asyncio
async def test_deleting_a_world_drops_its_lease(db):
    await add_world(db, "w1", status="INACTIVE")
    await db.execute("UPDATE worlds SET status = 'ACTIVE' WHERE world_id = 'w1'")
    store = LeaseStore(db, "replica-a", ttl_seconds=15)
    await store.claim(10)

    await db.execute("UPDATE worlds SET status = 'INACTIVE' WHERE world_id = 'w1'")
    await db.execute("DELETE FROM worlds WHERE world_id = 'w1'")

    assert await store.renew() == {}
    assert await db.fetchval("SELECT count(*) FROM npc_leases") == 0
