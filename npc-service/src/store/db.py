"""
Connection to the Lobby's PostgreSQL registry, where NPC replicas keep their leases.

In AWS the password comes from the Secrets Manager secret RDS manages
(DB_SECRET_ARN), the same one the Lobby Lambdas read; in local development, from
DB_PASSWORD. RDS enforces TLS (rds.force_ssl=1), so DB_CA_FILE points at the RDS
CA bundle baked into the image.
"""

import asyncio
import json
import logging
import ssl
import time
from typing import Optional

logger = logging.getLogger("Database")

PASSWORD_TTL_SECONDS = 15 * 60


class SecretPassword:
    """
    Password read from the RDS-managed secret, cached for a while.

    asyncpg calls the instance for every new connection, so after a rotation the
    next connection uses the current value. invalidate() drops the cache when
    PostgreSQL rejects it. Errors name the secret, never its value.
    """

    def __init__(self, secret_id: str, region: str, client=None, ttl: float = PASSWORD_TTL_SECONDS, clock=time.monotonic):
        self.secret_id = secret_id
        self.region = region
        self._client = client
        self._ttl = ttl
        self._clock = clock
        self._value: Optional[str] = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    def _read(self) -> str:
        if self._client is None:
            import boto3  # Imported lazily: local development does not need it.

            self._client = boto3.client("secretsmanager", region_name=self.region)
        try:
            response = self._client.get_secret_value(SecretId=self.secret_id)
            password = json.loads(response.get("SecretString") or "{}").get("password")
        except Exception as err:
            raise RuntimeError(f"Could not read the database password from secret {self.secret_id}: {type(err).__name__}") from None
        if not isinstance(password, str) or not password:
            raise RuntimeError(f"Could not read the database password from secret {self.secret_id}: the secret has no password field")
        return password

    async def __call__(self) -> str:
        # One request shared by concurrent connections; the SDK call blocks, so it runs in an executor.
        async with self._lock:
            if self._value is None or self._clock() >= self._expires_at:
                loop = asyncio.get_running_loop()
                self._value = await loop.run_in_executor(None, self._read)
                self._expires_at = self._clock() + self._ttl
            return self._value

    def invalidate(self) -> None:
        self._value = None
        self._expires_at = 0.0


def database_password(cfg):
    """The secret reader in AWS, the plain DB_PASSWORD in local development."""
    if cfg.DB_SECRET_ARN:
        return SecretPassword(cfg.DB_SECRET_ARN, cfg.AWS_REGION)
    return cfg.DB_PASSWORD


def ssl_context(ca_file: str) -> Optional[ssl.SSLContext]:
    if not ca_file:
        return None
    context = ssl.create_default_context(cafile=ca_file)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


async def create_pool(cfg):
    import asyncpg

    password = database_password(cfg)
    if isinstance(password, SecretPassword):
        # Fail at startup, not at the first lease, when the secret is unreachable.
        await password()

    async def connect(*args, **kwargs):
        # RDS rotates the password: a connection made with the cached value fails
        # with invalid_password before any statement runs, so retrying once is safe.
        try:
            return await asyncpg.connect(*args, **kwargs)
        except asyncpg.InvalidPasswordError:
            if not isinstance(password, SecretPassword):
                raise
            password.invalidate()
            return await asyncpg.connect(*args, **kwargs)

    pool = await asyncpg.create_pool(
        host=cfg.DB_HOST,
        port=cfg.DB_PORT,
        database=cfg.DB_NAME,
        user=cfg.DB_USER,
        password=password,
        ssl=ssl_context(cfg.DB_CA_FILE),
        min_size=1,
        max_size=2,
        command_timeout=5,
        connect=connect,
    )
    logger.info(f"Connected to PostgreSQL at {cfg.DB_HOST}:{cfg.DB_PORT}/{cfg.DB_NAME}.")
    return pool
