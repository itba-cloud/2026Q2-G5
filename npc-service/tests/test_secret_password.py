"""
Database password from the RDS-managed secret: caching, rotation and errors.

The last test needs TEST_DATABASE_URL, like test_lease_store.py.
"""

import asyncio
import json
import os
from types import SimpleNamespace
from urllib.parse import unquote, urlparse

import pytest

from src.store import db
from src.store.db import SecretPassword, database_password

SECRET_ID = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-test"


class FakeSecrets:
    def __init__(self, *values):
        self.values = list(values)
        self.calls = []

    def get_secret_value(self, SecretId):
        self.calls.append(SecretId)
        value = self.values.pop(0)
        if isinstance(value, Exception):
            raise value
        return {"SecretString": json.dumps(value)}


def make(*values, **kwargs):
    client = FakeSecrets(*values)
    return SecretPassword(SECRET_ID, "us-east-1", client=client, **kwargs), client


def test_reads_and_caches_the_password():
    password, client = make({"username": "dbadmin", "password": "first"})

    async def run():
        return [await password(), await password()]

    assert asyncio.run(run()) == ["first", "first"]
    assert client.calls == [SECRET_ID]


def test_concurrent_connections_share_one_request():
    password, client = make({"password": "first"})

    async def run():
        return await asyncio.gather(password(), password(), password())

    assert asyncio.run(run()) == ["first", "first", "first"]
    assert len(client.calls) == 1


def test_invalidate_and_expiry_fetch_again():
    clock = [0.0]
    password, _ = make({"password": "first"}, {"password": "rotated"}, {"password": "expired"}, ttl=10, clock=lambda: clock[0])

    async def run():
        values = [await password()]
        password.invalidate()
        values.append(await password())
        clock[0] = 10
        values.append(await password())
        return values

    assert asyncio.run(run()) == ["first", "rotated", "expired"]


def test_errors_name_the_secret_but_not_a_value():
    class AccessDeniedException(Exception):
        pass

    password, _ = make(AccessDeniedException("not authorized to perform secretsmanager:GetSecretValue"))
    with pytest.raises(RuntimeError, match=r"secret arn:aws:secretsmanager:.*rds!db-test: AccessDeniedException$"):
        asyncio.run(password())

    empty, _ = make({"username": "dbadmin", "password": ""})
    with pytest.raises(RuntimeError, match="the secret has no password field"):
        asyncio.run(empty())


def test_local_development_keeps_db_password():
    cfg = SimpleNamespace(DB_SECRET_ARN="", DB_PASSWORD="local", AWS_REGION="us-east-1")
    assert database_password(cfg) == "local"
    cfg.DB_SECRET_ARN = SECRET_ID
    assert isinstance(database_password(cfg), SecretPassword)


@pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL is not set")
def test_pool_reconnects_with_the_rotated_password(monkeypatch):
    pytest.importorskip("asyncpg")
    url = urlparse(os.environ["TEST_DATABASE_URL"])
    current = unquote(url.password or "")
    # The first value is the password before the rotation; PostgreSQL rejects it.
    password, client = make({"password": f"{current}-before-rotation"}, {"password": current})
    monkeypatch.setattr(db, "database_password", lambda cfg: password)
    cfg = SimpleNamespace(
        DB_HOST=url.hostname, DB_PORT=url.port or 5432, DB_NAME=url.path.lstrip("/"),
        DB_USER=unquote(url.username or ""), DB_CA_FILE="",
    )

    async def run():
        pool = await db.create_pool(cfg)
        try:
            return await pool.fetchval("SELECT 1")
        finally:
            await pool.close()

    assert asyncio.run(run()) == 1
    assert len(client.calls) == 2
