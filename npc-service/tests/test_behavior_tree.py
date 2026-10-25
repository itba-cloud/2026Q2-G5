"""
Unit tests for Behavior Tree nodes and the full BehaviorTreeBrain decision hierarchy.
"""

import pytest
from src.brain.behavior_tree.core import Status
from src.brain.behavior_tree.composites import Selector, Sequence
from src.brain.behavior_tree.conditions import (
    IsHealthLow,
    IsEnemyNearby,
    HasItemInInventory,
    IsCampfireNearby,
    IsResourceNearby,
)
from src.brain.behavior_tree.leaves import (
    EatFoodAction,
    FleeToCampfireAction,
    BuildDefensiveWallAction,
    AttackAndKiteAction,
    HarvestNearestResourceAction,
)
from src.brain.behavior_tree.npc_tree import BehaviorTreeBrain
from src.model.world_view import WorldView
from src.model.actions import (
    MoveAction,
    ShootAction,
    HarvestAction,
    BuildAction,
    UseItemAction,
)


def test_behavior_tree_composites():
    wv = WorldView()
    actions = []

    # Sequence where first fails
    seq_fail = Sequence([
        IsHealthLow(threshold_pct=30.0),
        EatFoodAction(),
    ])
    wv.hp = 100.0
    status = seq_fail.tick(wv, actions)
    assert status == Status.FAILURE
    assert len(actions) == 0

    # Sequence where all pass
    seq_pass = Sequence([
        HasItemInInventory("wood", min_count=2),
        HasItemInInventory("stone", min_count=1),
    ])
    wv.inventory = {"wood": 5, "stone": 3}
    status = seq_pass.tick(wv, actions)
    assert status == Status.SUCCESS

    # Selector where first fails and second succeeds
    sel = Selector([
        IsHealthLow(threshold_pct=20.0),
        HasItemInInventory("wood", min_count=1),
    ])
    status = sel.tick(wv, actions)
    assert status == Status.SUCCESS


def test_critical_survival_food():
    brain = BehaviorTreeBrain()
    wv = WorldView(bot_id="bot_1")
    wv.hp = 20.0  # Low health (<35%)
    wv.max_hp = 100.0
    wv.inventory = {"food": 2, "wood": 0, "stone": 0}

    actions = brain.decide_actions(wv)

    assert any(isinstance(a, UseItemAction) and a.item == "food" for a in actions), \
        "Bot should consume food when health is low and food is available in inventory"


def test_critical_survival_flee_to_campfire():
    brain = BehaviorTreeBrain()
    wv = WorldView(bot_id="bot_1")
    wv.x = 100.0
    wv.y = 100.0
    wv.hp = 25.0  # Low health (<35%)
    wv.max_hp = 100.0
    wv.inventory = {"food": 0, "wood": 0, "stone": 0}  # No food
    wv.structures = {
        "cf_1": {"id": "cf_1", "type": "campfire", "x": 100.0, "y": 200.0, "healRadius": 40.0}
    }

    actions = brain.decide_actions(wv)

    # Should emit MoveAction towards (100, 200)
    move_action = next((a for a in actions if isinstance(a, MoveAction)), None)
    assert move_action is not None, "Bot should move towards the nearby campfire"
    assert move_action.dx == 0.0
    assert move_action.dy == 1.0


def test_critical_survival_build_defensive_wall():
    brain = BehaviorTreeBrain()
    wv = WorldView(bot_id="bot_1")
    wv.x = 200.0
    wv.y = 200.0
    wv.hp = 20.0  # Low health
    wv.inventory = {"food": 0, "wood": 10, "stone": 0}  # Enough wood for wall
    wv.players = {
        "enemy_1": {"id": "enemy_1", "name": "Hunter", "x": 260.0, "y": 200.0, "isDead": False}
    }

    actions = brain.decide_actions(wv)

    build_action = next((a for a in actions if isinstance(a, BuildAction)), None)
    assert build_action is not None, "Bot should build a defensive wall when pressed by enemy with low hp"
    assert build_action.structure_type == "wall"


def test_tactical_combat_and_kite():
    brain = BehaviorTreeBrain()
    wv = WorldView(bot_id="bot_1")
    wv.x = 300.0
    wv.y = 300.0
    wv.hp = 100.0  # Healthy
    wv.players = {
        "enemy_1": {"id": "enemy_1", "name": "Target", "x": 450.0, "y": 300.0, "isDead": False}
    }

    actions = brain.decide_actions(wv)

    shoot_action = next((a for a in actions if isinstance(a, ShootAction)), None)
    move_action = next((a for a in actions if isinstance(a, MoveAction)), None)

    assert shoot_action is not None, "Healthy bot should engage nearby enemy with SHOOT action"
    assert pytest.approx(shoot_action.angle) == 0.0  # Enemy is directly to the East
    assert move_action is not None, "Bot should reposition/kite relative to enemy"


def test_peaceful_resource_harvesting():
    brain = BehaviorTreeBrain()
    wv = WorldView(bot_id="bot_1")
    wv.x = 500.0
    wv.y = 500.0
    wv.hp = 100.0
    wv.players = {}  # No enemies nearby
    wv.resources = {
        "tree_close": {"id": "tree_close", "type": "tree", "x": 520.0, "y": 500.0, "hp": 3}
    }

    actions = brain.decide_actions(wv)

    # In close range (20px <= 55px range) -> should harvest
    harvest_action = next((a for a in actions if isinstance(a, HarvestAction)), None)
    assert harvest_action is not None, "Peaceful bot near a tree should issue HARVEST action"
    assert harvest_action.target_id == "tree_close"


def test_dead_bot_emits_no_actions():
    brain = BehaviorTreeBrain()
    wv = WorldView(bot_id="bot_1")
    wv.is_dead = True
    wv.hp = 0

    actions = brain.decide_actions(wv)
    assert len(actions) == 0, "Dead bot should not emit any actions until respawned"
