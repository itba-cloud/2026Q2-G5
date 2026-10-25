"""
Leaf condition nodes for Behavior Tree.
Inspects WorldView and returns SUCCESS if condition is met, otherwise FAILURE.
"""

from typing import List, Optional
from src.brain.behavior_tree.core import Node, Status
from src.model.world_view import WorldView
from src.model.actions import Action


class IsHealthLow(Node):
    """Checks if bot's health is below threshold percentage."""

    def __init__(self, threshold_pct: float = 35.0, name: Optional[str] = None):
        super().__init__(name=name or f"IsHealthLow(<={threshold_pct}%)")
        self.threshold_pct = threshold_pct

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        if world_view.max_hp <= 0:
            return Status.FAILURE
        pct = (world_view.hp / world_view.max_hp) * 100.0
        return Status.SUCCESS if pct <= self.threshold_pct else Status.FAILURE


class IsHealthFull(Node):
    """Checks if bot's health is at 100%."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name=name or "IsHealthFull")

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        return Status.SUCCESS if world_view.hp >= world_view.max_hp else Status.FAILURE


class HasItemInInventory(Node):
    """Checks if the bot has at least `min_count` of `item_name` in inventory."""

    def __init__(self, item_name: str, min_count: int = 1, name: Optional[str] = None):
        super().__init__(name=name or f"HasItem({item_name}>={min_count})")
        self.item_name = item_name
        self.min_count = min_count

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        current_count = world_view.inventory.get(self.item_name, 0)
        return Status.SUCCESS if current_count >= self.min_count else Status.FAILURE


class IsEnemyNearby(Node):
    """Checks if an alive other player is within `max_distance`."""

    def __init__(self, max_distance: float = 240.0, name: Optional[str] = None):
        super().__init__(name=name or f"IsEnemyNearby(<={max_distance}px)")
        self.max_distance = max_distance

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        nearest_enemy = world_view.find_nearest_enemy(max_range=self.max_distance)
        return Status.SUCCESS if nearest_enemy is not None else Status.FAILURE


class IsCampfireNearby(Node):
    """Checks if a campfire structure exists within `max_distance`."""

    def __init__(self, max_distance: float = 400.0, name: Optional[str] = None):
        super().__init__(name=name or f"IsCampfireNearby(<={max_distance}px)")
        self.max_distance = max_distance

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        nearest_campfire = world_view.find_nearest_campfire()
        if not nearest_campfire:
            return Status.FAILURE
        dist = world_view.distance_to(nearest_campfire.get("x", 0), nearest_campfire.get("y", 0))
        return Status.SUCCESS if dist <= self.max_distance else Status.FAILURE


class IsResourceNearby(Node):
    """Checks if a harvestable resource exists within `max_distance`."""

    def __init__(self, resource_type: Optional[str] = None, max_distance: float = 600.0, name: Optional[str] = None):
        super().__init__(name=name or f"IsResourceNearby({resource_type or 'any'}, <={max_distance}px)")
        self.resource_type = resource_type
        self.max_distance = max_distance

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        nearest_res = world_view.find_nearest_resource(resource_type=self.resource_type)
        if not nearest_res:
            return Status.FAILURE
        dist = world_view.distance_to(nearest_res.get("x", 0), nearest_res.get("y", 0))
        return Status.SUCCESS if dist <= self.max_distance else Status.FAILURE


class IsUnderThreat(Node):
    """Checks if the bot is in imminent danger."""

    def __init__(self, threat_radius: float = 200.0, name: Optional[str] = None):
        super().__init__(name=name or f"IsUnderThreat(<={threat_radius}px)")
        self.threat_radius = threat_radius

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        return Status.SUCCESS if world_view.is_under_threat(self.threat_radius) else Status.FAILURE
