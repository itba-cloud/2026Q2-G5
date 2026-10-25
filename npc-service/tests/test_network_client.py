"""
Unit tests for protocol serialization and NPCNetworkClient message handling.
"""

import pytest
from src.network.protocol import (
    MessageTypes,
    parse_incoming_message,
    create_message
)
from src.network.client import NPCNetworkClient
from src.model.actions import (
    MoveAction,
    ShootAction,
    HarvestAction,
    BuildAction,
    UseItemAction
)


def test_protocol_create_and_parse():
    # Valid payload
    payload = {"playerName": "[NPC] Guardian 1"}
    raw = create_message(MessageTypes.JOIN, payload)
    parsed = parse_incoming_message(raw)

    assert parsed is not None
    msg_type, data = parsed
    assert msg_type == MessageTypes.JOIN
    assert data["playerName"] == "[NPC] Guardian 1"

    # Bytes input
    raw_bytes = raw.encode("utf-8")
    parsed_bytes = parse_incoming_message(raw_bytes)
    assert parsed_bytes is not None
    assert parsed_bytes[0] == MessageTypes.JOIN

    # Invalid input
    assert parse_incoming_message("invalid json content") is None
    assert parse_incoming_message("{}") is None


def test_client_message_dispatch():
    client = NPCNetworkClient(server_url="ws://mock:8001", bot_name="TestBot")

    # 1. Test INIT
    init_payload = {
        "worldId": "world-alpha",
        "playerId": "p_bot_99",
        "player": {"id": "p_bot_99", "name": "TestBot", "x": 100, "y": 200, "hp": 100, "maxHp": 100},
        "resources": [{"id": "tree_1", "type": "tree", "x": 120, "y": 200}],
        "structures": [],
    }
    client._handle_server_message(MessageTypes.INIT, init_payload)

    assert client._is_joined is True
    assert client.world_view.bot_id == "p_bot_99"
    assert client.world_view.x == 100
    assert "tree_1" in client.world_view.resources

    # 2. Test STATE_SYNC
    sync_payload = {
        "tick": 10,
        "players": [
            {"id": "p_bot_99", "x": 150, "y": 250, "hp": 80, "maxHp": 100, "isDead": False}
        ],
        "structures": [],
        "projectiles": []
    }
    client._handle_server_message(MessageTypes.STATE_SYNC, sync_payload)

    assert client.world_view.x == 150
    assert client.world_view.y == 250
    assert client.world_view.hp == 80

    # 3. Test PLAYER_DIED & PLAYER_RESPAWNED
    death_payload = {"playerId": "p_bot_99", "killerName": "Slime"}
    client._handle_server_message(MessageTypes.PLAYER_DIED, death_payload)
    assert client.world_view.is_dead is True

    respawn_payload = {"playerId": "p_bot_99", "x": 500, "y": 500, "hp": 100}
    client._handle_server_message(MessageTypes.PLAYER_RESPAWNED, respawn_payload)
    assert client.world_view.is_dead is False
    assert client.world_view.hp == 100
    assert client.world_view.x == 500
