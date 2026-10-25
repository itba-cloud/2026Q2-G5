"""
Read-only HTTP API of an NPC replica: the ECS health check and bot status for debugging.
Replicas assign worlds to themselves through RDS leases (see manager/reconciler.py),
so nothing asks them to spawn or despawn bots over HTTP.
"""

import logging
from aiohttp import web
from src.manager.bot_manager import BotManager

logger = logging.getLogger("HttpApi")


def create_http_app(bot_manager: BotManager, reconciler=None, instance_id: str = "") -> web.Application:
    """
    Constructs and returns the configured aiohttp web application.
    `reconciler` is None when the replica runs without a database (local auto-spawn).
    """
    app = web.Application()
    app["bot_manager"] = bot_manager
    app["reconciler"] = reconciler
    app["instance_id"] = instance_id

    # Routes
    app.router.add_get("/health", handle_health)
    app.router.add_get("/bots", handle_list_bots)
    app.router.add_get("/bots/{world_id}", handle_get_world_bots)

    return app


async def handle_health(request: web.Request) -> web.Response:
    """
    Health check with current bot fleet stats. A replica whose reconcile loop has
    stalled answers 503 so ECS replaces it; its leases then expire and move.
    """
    bot_manager: BotManager = request.app["bot_manager"]
    reconciler = request.app.get("reconciler")
    status_data = bot_manager.get_status()
    healthy = reconciler is None or reconciler.is_healthy()
    body = {
        "status": "ok" if healthy else "stalled",
        "service": "npc-service",
        "instanceId": request.app.get("instance_id", ""),
        "activeWorldsCount": status_data["activeWorldsCount"],
        "totalBotsCount": status_data["totalBotsCount"],
    }
    if reconciler is not None:
        body["reconciler"] = reconciler.get_status()
    return web.json_response(body, status=200 if healthy else 503)


async def handle_list_bots(request: web.Request) -> web.Response:
    """Lists all active worlds and their currently connected bots."""
    bot_manager: BotManager = request.app["bot_manager"]
    return web.json_response(bot_manager.get_status())


async def handle_get_world_bots(request: web.Request) -> web.Response:
    """Gets bots status for a specific world ID."""
    world_id = request.match_info["world_id"]
    bot_manager: BotManager = request.app["bot_manager"]
    world_data = bot_manager.get_world_bots(world_id)

    if not world_data:
        return web.json_response({
            "success": False,
            "error": f"No hay bots activos para el mundo '{world_id}'"
        }, status=404)

    return web.json_response({
        "success": True,
        "world": world_data
    })
