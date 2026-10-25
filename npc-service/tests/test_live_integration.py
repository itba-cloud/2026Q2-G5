"""
Integration test: Connects NPCNetworkClient to a live WorldService WebSocket server.
"""

import asyncio
import pytest
import subprocess
import os
from src.network.client import NPCNetworkClient
from src.brain.behavior_tree.npc_tree import BehaviorTreeBrain


@pytest.mark.integration
@pytest.mark.asyncio
async def test_live_world_service_integration():
    # 1. Spawn a local World Service node process on test port 8005
    env = os.environ.copy()
    env["PORT"] = "8005"
    env["WORLD_ID"] = "py-integration-world"
    env["STORAGE_MODE"] = "local"
    env["DATA_DIR"] = "./.test_npc_data"
    env["IDLE_TIMEOUT"] = "0"
    env["LOBBY_API_URL"] = ""

    proc = subprocess.Popen(
        ["node", "world-service/src/index.js"],
        cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        # Give Node.js server time to boot up and listen
        await asyncio.sleep(1.5)

        # 2. Connect Python Bot Client
        client = NPCNetworkClient(
            server_url="ws://127.0.0.1:8005",
            bot_name="[NPC] Integrator",
            brain=BehaviorTreeBrain(),
            tick_rate_hz=10.0,
        )

        client_task = asyncio.create_task(client.start())

        # Wait until bot joins and receives INIT & STATE_SYNC
        joined = False
        for _ in range(40):
            if client._is_joined and client.world_view.last_tick > 0:
                joined = True
                break
            await asyncio.sleep(0.1)

        if not joined and proc.poll() is not None:
            stdout, stderr = proc.communicate()
            raise RuntimeError(f"World service crashed on boot:\nStdout: {stdout.decode()}\nStderr: {stderr.decode()}")

        assert client._is_joined is True, "Bot should have joined the live world server"
        assert client.world_view.bot_id != "", "Bot should have received a unique player ID"
        assert client.world_view.last_tick > 0, "Bot should have received STATE_SYNC broadcasts"
        assert len(client.world_view.resources) > 0, "Bot should perceive world resources"

        # Let the bot run its BehaviorTree decision loop for 2 seconds
        await asyncio.sleep(2.0)

        # Cleanup client
        await client.stop()
        client_task.cancel()

    finally:
        # Terminate world-service process
        proc.terminate()
        try:
            proc.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            proc.kill()
