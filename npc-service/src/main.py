"""
Main entry point for the NPC Service.
Runs the HTTP REST API server (aiohttp) and manages dynamic bot pools.
"""

import asyncio
import logging
import signal
import sys
from pathlib import Path

# Ensure the root of npc-service is in sys.path so 'import src.*' works from any CWD
_service_root = Path(__file__).resolve().parent.parent
if str(_service_root) not in sys.path:
    sys.path.insert(0, str(_service_root))

from aiohttp import web
from src.config import config
from src.manager.bot_manager import BotManager
from src.api.server import create_http_app
from src.manager.reconciler import Reconciler
from src.runtime_identity import resolve_instance_id
from src.store.db import create_pool
from src.store.lease_store import LeaseStore
from src.telemetry.publisher import KinesisTelemetryPublisher

# Configure logging
logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("Main")


async def main():
    logger.info("=" * 60)
    logger.info("🤖 Elastic Worlds - NPC Autonomous Service (RDS leases + BT)")
    logger.info(f"REST API Server:       http://{config.HTTP_HOST}:{config.HTTP_PORT}")
    logger.info(f"Default Bot Prefix:    {config.BOT_NAME_PREFIX}")
    logger.info(f"Decision Tick Rate:    {config.DECISION_TICK_RATE_HZ} Hz")
    logger.info(f"Auto-Spawn Default:    {config.AUTO_SPAWN_DEFAULT_WORLD}")
    logger.info("=" * 60)

    instance_id = resolve_instance_id()
    logger.info(f"Replica instance id:   {instance_id}")

    manager = BotManager()
    reconciler = None
    if config.ASSIGNMENT_MODE not in ("leases", "standalone"):
        raise SystemExit(f"NPC_ASSIGNMENT_MODE must be 'leases' or 'standalone', not '{config.ASSIGNMENT_MODE}'.")
    if config.ASSIGNMENT_MODE == "leases":
        async def connect() -> LeaseStore:
            return LeaseStore(await create_pool(config), instance_id, config.LEASE_TTL_SECONDS)

        reconciler = Reconciler(
            manager,
            connect,
            interval_seconds=config.RECONCILE_INTERVAL_SECONDS,
            lease_ttl_seconds=config.LEASE_TTL_SECONDS,
            max_worlds=config.MAX_WORLDS_PER_TASK,
            claim_batch=config.CLAIM_BATCH,
            spawn_options={
                "name_prefix": config.BOT_NAME_PREFIX,
                "tick_rate_hz": config.DECISION_TICK_RATE_HZ,
                "reconnect_delay": config.RECONNECT_DELAY_SECONDS,
            },
        )
    app = create_http_app(manager, reconciler, instance_id)

    # 1. Start aiohttp HTTP Server
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, config.HTTP_HOST, config.HTTP_PORT)
    await site.start()
    logger.info(f"🚀 NPC REST API is listening on http://{config.HTTP_HOST}:{config.HTTP_PORT}")

    # 2. Claim worlds through RDS leases, or auto-spawn a fixed world when standalone
    if reconciler is not None:
        logger.info(f"Assigning worlds through RDS leases at {config.DB_HOST} "
                    f"(up to {config.MAX_WORLDS_PER_TASK} worlds, lease TTL {config.LEASE_TTL_SECONDS}s).")
        reconciler.start()
    elif config.AUTO_SPAWN_DEFAULT_WORLD:
        logger.info(f"Auto-spawning default bots connecting to '{config.WORLD_WS_URL}'...")
        await manager.spawn_bots_for_world(
            world_id="world-01",
            ws_url=config.WORLD_WS_URL,
            count=config.BOT_COUNT,
            name_prefix=config.BOT_NAME_PREFIX,
            tick_rate_hz=config.DECISION_TICK_RATE_HZ,
            reconnect_delay=config.RECONNECT_DELAY_SECONDS,
        )

    # 3. Report telemetry to the pipeline (optional — never fatal)
    telemetry = None
    if config.TELEMETRY_MODE == "kinesis":
        try:
            telemetry = KinesisTelemetryPublisher(
                stream_name=config.TELEMETRY_STREAM_NAME,
                get_status=manager.get_status,
                region=config.AWS_REGION,
                interval_seconds=config.TELEMETRY_INTERVAL_SECONDS,
                instance_id=instance_id,
            )
            telemetry.start()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"Telemetry disabled: {exc}")
            telemetry = None

    # 4. Graceful shutdown handler
    stop_event = asyncio.Event()

    async def shutdown(sig_name: str = "SIGTERM"):
        logger.info(f"Received {sig_name}. Initiating graceful shutdown...")
        if telemetry is not None:
            await telemetry.stop()
        # Bots first, then the leases: other replicas take the worlds on their next tick.
        if reconciler is not None:
            await reconciler.stop()
        await manager.stop_all()
        await runner.cleanup()
        stop_event.set()
        logger.info("NPC Service stopped cleanly.")

    # Register OS signals
    if sys.platform != "win32":
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(
                sig,
                lambda s=sig: asyncio.create_task(shutdown(s.name))
            )

    try:
        # Keep running until stop_event is triggered
        await stop_event.wait()
    except (asyncio.CancelledError, KeyboardInterrupt):
        logger.info("Main loop interrupted.")
    finally:
        if not stop_event.is_set():
            await shutdown("EXIT")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
