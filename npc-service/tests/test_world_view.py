"""
Unit tests for WorldView and spatial queries.
"""

import pytest
import math
from src.model.world_view import WorldView


def test_world_view_init_hydration():
    wv = WorldView(bot_name="TestBot")
    init_data = {
        "worldId": "test-world",
        "worldWidth": 1200,
        "worldHeight": 800,
        "playerId": "p_bot_1",
        "player": {
            "id": "p_bot_1",
            "name": "TestBot",
            "x": 300,
            "y": 400,
            "hp": 90,
            "maxHp": 100,
            "inventory": {"wood": 10, "stone": 5, "food": 2},
        },
        "resources": [
            {"id": "tree_1", "type": "tree", "x": 320, "y": 400, "hp": 3},
            {"id": "rock_1", "type": "rock", "x": 500, "y": 500, "hp": 4},
        ],
        "structures": [
            {"id": "cf_1", "type": "campfire", "x": 350, "y": 400, "hp": 50, "healRadius": 40},
        ],
        "players": [
            {"id": "p_bot_1", "name": "TestBot", "x": 300, "y": 400, "hp": 90, "isDead": False},
            {"id": "p_human_1", "name": "Alice", "x": 600, "y": 400, "hp": 100, "isDead": False},
        ],
    }

    wv.update_from_init(init_data)

    assert wv.bot_id == "p_bot_1"
    assert wv.x == 300
    assert wv.y == 400
    assert wv.hp == 90
    assert wv.inventory["wood"] == 10
    assert len(wv.resources) == 2
    assert len(wv.structures) == 1
    assert len(wv.players) == 1  # Alice only (self excluded from other players)
    assert "p_human_1" in wv.players


def test_spatial_calculations():
    wv = WorldView()
    wv.x = 100
    wv.y = 100

    # Distance
    assert wv.distance_to(100, 150) == 50.0
    assert wv.distance_to(130, 140) == 50.0

    # Angle
    angle_east = wv.angle_to(200, 100)
    assert pytest.approx(angle_east) == 0.0

    angle_south = wv.angle_to(100, 200)
    assert pytest.approx(angle_south) == math.pi / 2

    # Direction normalized
    dx, dy = wv.direction_to(100, 200)
    assert pytest.approx(dx) == 0.0
    assert pytest.approx(dy) == 1.0


def test_find_nearest_helpers():
    wv = WorldView(bot_id="p_bot")
    wv.x = 200
    wv.y = 200

    wv.resources = {
        "tree_far": {"id": "tree_far", "type": "tree", "x": 500, "y": 500},
        "tree_near": {"id": "tree_near", "type": "tree", "x": 230, "y": 200},
        "rock_near": {"id": "rock_near", "type": "rock", "x": 210, "y": 200},
    }

    wv.players = {
        "p_enemy_1": {"id": "p_enemy_1", "name": "Enemy", "x": 250, "y": 200, "isDead": False},
        "p_dead": {"id": "p_dead", "name": "Ghost", "x": 205, "y": 200, "isDead": True},
    }

    wv.structures = {
        "cf_1": {"id": "cf_1", "type": "campfire", "x": 220, "y": 200},
    }

    # Nearest resource (any)
    nearest_res = wv.find_nearest_resource()
    assert nearest_res["id"] == "rock_near"

    # Nearest tree specifically
    nearest_tree = wv.find_nearest_resource(resource_type="tree")
    assert nearest_tree["id"] == "tree_near"

    # Nearest alive enemy (skips dead player)
    nearest_enemy = wv.find_nearest_enemy()
    assert nearest_enemy["id"] == "p_enemy_1"

    # Nearest campfire
    nearest_cf = wv.find_nearest_campfire()
    assert nearest_cf["id"] == "cf_1"


def test_sync_state_updates():
    wv = WorldView(bot_id="p_bot")
    wv.x = 100
    wv.y = 100
    wv.hp = 100

    sync_payload = {
        "tick": 42,
        "timestamp": 123456789,
        "players": [
            {
                "id": "p_bot",
                "name": "Bot",
                "x": 105.5,
                "y": 102.3,
                "hp": 75,
                "maxHp": 100,
                "isDead": False,
                "inventory": {"wood": 3, "stone": 1, "food": 0},
            },
            {
                "id": "p_other",
                "name": "Rival",
                "x": 180.0,
                "y": 120.0,
                "hp": 100,
                "maxHp": 100,
                "isDead": False,
            }
        ],
        "projectiles": [
            {"id": "proj_1", "x": 120, "y": 100, "vx": -5, "vy": 0, "shooterId": "p_other"}
        ],
        "structures": [],
    }

    wv.update_from_sync(sync_payload)

    assert wv.last_tick == 42
    assert wv.x == 105.5
    assert wv.y == 102.3
    assert wv.hp == 75
    assert wv.inventory["wood"] == 3
    assert "p_other" in wv.players
    assert len(wv.projectiles) == 1
    assert wv.is_under_threat(threat_radius=200.0) is True
