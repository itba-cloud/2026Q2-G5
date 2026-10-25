"""
Unit tests for NPC Service HTTP REST API handlers.
Uses in-process mocked requests for isolated, fast, socket-free verification.
"""

import json
import pytest
from aiohttp.test_utils import make_mocked_request
from src.manager.bot_manager import BotManager
from src.api.server import (
    handle_health,
    handle_list_bots,
    handle_get_world_bots,
)


class StubReconciler:
    def __init__(self, healthy: bool):
        self.healthy = healthy

    def is_healthy(self):
        return self.healthy

    def get_status(self):
        return {"ownedWorlds": ["world-alpha"], "lastReconcileAgeSeconds": 1.0, "maxWorlds": 10}


@pytest.mark.asyncio
async def test_health_handler():
    bot_manager = BotManager()
    req = make_mocked_request("GET", "/health", app={"bot_manager": bot_manager, "instance_id": "task-1"})
    resp = await handle_health(req)

    assert resp.status == 200
    data = json.loads(resp.text)
    assert data["status"] == "ok"
    assert data["service"] == "npc-service"
    assert data["instanceId"] == "task-1"
    assert data["activeWorldsCount"] == 0
    assert data["totalBotsCount"] == 0


@pytest.mark.asyncio
async def test_health_reports_a_stalled_reconciler_as_unhealthy():
    app = {"bot_manager": BotManager(), "reconciler": StubReconciler(healthy=False)}
    resp = await handle_health(make_mocked_request("GET", "/health", app=app))
    assert resp.status == 503
    assert json.loads(resp.text)["status"] == "stalled"

    app["reconciler"] = StubReconciler(healthy=True)
    resp = await handle_health(make_mocked_request("GET", "/health", app=app))
    assert resp.status == 200
    assert json.loads(resp.text)["reconciler"]["ownedWorlds"] == ["world-alpha"]


@pytest.mark.asyncio
async def test_bot_status_handlers():
    bot_manager = BotManager()
    app_ctx = {"bot_manager": bot_manager}
    try:
        await bot_manager.spawn_bots_for_world("world-alpha", "ws://127.0.0.1:1", count=2, runtime_id="run-1")

        list_resp = await handle_list_bots(make_mocked_request("GET", "/bots", app=app_ctx))
        assert list_resp.status == 200
        list_data = json.loads(list_resp.text)
        assert list_data["activeWorldsCount"] == 1
        assert list_data["totalBotsCount"] == 2
        assert list_data["worlds"]["world-alpha"]["runtimeId"] == "run-1"

        get_req = make_mocked_request("GET", "/bots/world-alpha", match_info={"world_id": "world-alpha"}, app=app_ctx)
        get_resp = await handle_get_world_bots(get_req)
        assert get_resp.status == 200
        assert json.loads(get_resp.text)["world"]["botCount"] == 2

        missing_req = make_mocked_request("GET", "/bots/nope", match_info={"world_id": "nope"}, app=app_ctx)
        assert (await handle_get_world_bots(missing_req)).status == 404
    finally:
        await bot_manager.stop_all()
