"""
BehaviorTreeBrain: Concrete implementation of Brain using a hierarchical Behavior Tree.
"""

from typing import List, Optional
from src.brain.base import Brain
from src.brain.behavior_tree.core import Node
from src.brain.behavior_tree.composites import Selector, Sequence
from src.brain.behavior_tree.conditions import (
    IsHealthLow,
    IsEnemyNearby,
    IsCampfireNearby,
    IsResourceNearby,
    HasItemInInventory,
)
from src.brain.behavior_tree.leaves import (
    EatFoodAction,
    FleeToCampfireAction,
    BuildDefensiveWallAction,
    BuildCampfireAction,
    AttackAndKiteAction,
    HarvestNearestResourceAction,
    WanderExploreAction,
)
from src.model.world_view import WorldView
from src.model.actions import Action


class BehaviorTreeBrain(Brain):
    """
    Hierarchical Behavior Tree Brain for NPC Bots.
    Implements prioritized survival, combat, harvesting, and exploration.
    """

    def __init__(self, root: Optional[Node] = None):
        self.root: Node = root or self._build_default_tree()

    def decide_actions(self, world_view: WorldView) -> List[Action]:
        """
        Ticks the Behavior Tree against the current WorldView perception.
        Returns the generated list of actions.
        """
        if world_view.is_dead:
            return []

        actions: List[Action] = []
        self.root.tick(world_view, actions)
        return actions

    def _build_default_tree(self) -> Node:
        """
        Assembles the complete hierarchical Behavior Tree for the NPC.
        """
        # --- BRANCH 1: CRITICAL SURVIVAL (Priority 1) ---
        survival_methods = Selector([
            # 1a. Eat food if available in inventory
            Sequence([
                HasItemInInventory(item_name="food", min_count=1),
                EatFoodAction()
            ], name="Seq_EatFood"),

            # 1b. If campfire is nearby, flee towards it
            Sequence([
                IsCampfireNearby(max_distance=450.0),
                FleeToCampfireAction()
            ], name="Seq_FleeToCampfire"),

            # 1c. Build emergency campfire if materials exist
            Sequence([
                HasItemInInventory(item_name="wood", min_count=3),
                HasItemInInventory(item_name="stone", min_count=2),
                BuildCampfireAction()
            ], name="Seq_BuildCampfire"),

            # 1d. Build emergency barricade wall if enemy is pressing
            Sequence([
                HasItemInInventory(item_name="wood", min_count=5),
                IsEnemyNearby(max_distance=280.0),
                BuildDefensiveWallAction()
            ], name="Seq_BuildDefensiveWall"),

            # 1e. Kite/Retreat away while shooting
            AttackAndKiteAction(combat_range=300.0, optimal_dist=220.0, name="Act_RetreatKite")
        ], name="Sel_SurvivalTactics")

        critical_survival_branch = Sequence([
            IsHealthLow(threshold_pct=35.0),
            survival_methods
        ], name="Branch_CriticalSurvival")

        # --- BRANCH 2: TACTICAL COMBAT & DEFENSE (Priority 2) ---
        combat_branch = Sequence([
            IsEnemyNearby(max_distance=240.0),
            AttackAndKiteAction(combat_range=240.0, optimal_dist=160.0, name="Act_AttackAndKite")
        ], name="Branch_TacticalCombat")

        # --- BRANCH 3: RESOURCE HARVESTING (Priority 3) ---
        harvest_branch = Sequence([
            IsResourceNearby(max_distance=600.0),
            HarvestNearestResourceAction(harvest_range=55.0, name="Act_HarvestNearest")
        ], name="Branch_ResourceHarvesting")

        # --- BRANCH 4: EXPLORATION / PATROL (Priority 4 - Fallback) ---
        explore_branch = WanderExploreAction(name="Act_WanderExplore")

        # --- ROOT SELECTOR ---
        root = Selector([
            critical_survival_branch,
            combat_branch,
            harvest_branch,
            explore_branch
        ], name="NPC_Root_Selector")

        return root
