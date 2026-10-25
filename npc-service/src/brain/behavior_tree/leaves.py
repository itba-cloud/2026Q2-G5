"""
Action leaf nodes for Behavior Tree.
Generates concrete Action value objects (Move, Shoot, Harvest, Build, UseItem).
"""

import math
import random
import time
from typing import List, Optional
from src.brain.behavior_tree.core import Node, Status
from src.model.world_view import WorldView
from src.model.actions import (
    Action,
    MoveAction,
    ShootAction,
    HarvestAction,
    BuildAction,
    UseItemAction,
    IdleAction
)


class EatFoodAction(Node):
    """Consumes a food item from inventory to recover health."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name=name or "EatFoodAction")

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        if world_view.inventory.get("food", 0) > 0 and world_view.hp < world_view.max_hp:
            actions.append(UseItemAction(item="food"))
            return Status.SUCCESS
        return Status.FAILURE


class FleeToCampfireAction(Node):
    """Moves towards the nearest campfire to passively regenerate health."""

    def __init__(self, heal_radius: float = 40.0, name: Optional[str] = None):
        super().__init__(name=name or "FleeToCampfireAction")
        self.heal_radius = heal_radius

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        campfire = world_view.find_nearest_campfire()
        if not campfire:
            return Status.FAILURE

        cx, cy = float(campfire.get("x", 0)), float(campfire.get("y", 0))
        dist = world_view.distance_to(cx, cy)

        if dist <= self.heal_radius:
            # Already inside campfire healing aura, stand still and enjoy regen
            actions.append(MoveAction(dx=0.0, dy=0.0))
            return Status.SUCCESS
        else:
            # Move towards campfire
            dx, dy = world_view.direction_to(cx, cy)
            actions.append(MoveAction(dx=dx, dy=dy))
            return Status.RUNNING


class BuildDefensiveWallAction(Node):
    """Constructs a wooden barricade between the bot and the nearest enemy."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name=name or "BuildDefensiveWallAction")
        self.last_built_time = 0.0

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        # Check cooldown (don't spam walls every frame)
        now = time.time()
        if now - self.last_built_time < 3.0:
            return Status.FAILURE

        if world_view.inventory.get("wood", 0) < 5:
            return Status.FAILURE

        enemy = world_view.find_nearest_enemy(max_range=300.0)
        if not enemy:
            return Status.FAILURE

        ex, ey = float(enemy.get("x", 0)), float(enemy.get("y", 0))
        dx, dy = world_view.direction_to(ex, ey)

        # Place wall 35 pixels ahead in direction of enemy
        wall_x = round(world_view.x + dx * 35.0)
        wall_y = round(world_view.y + dy * 35.0)

        actions.append(BuildAction(structure_type="wall", x=wall_x, y=wall_y))
        self.last_built_time = now
        return Status.SUCCESS


class BuildCampfireAction(Node):
    """Builds a campfire if the bot has required resources (3 wood, 2 stone) and no campfire is nearby."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name=name or "BuildCampfireAction")
        self.last_built_time = 0.0

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        now = time.time()
        if now - self.last_built_time < 10.0:
            return Status.FAILURE

        wood = world_view.inventory.get("wood", 0)
        stone = world_view.inventory.get("stone", 0)

        if wood < 3 or stone < 2:
            return Status.FAILURE

        # Only build if no campfire within 150px
        nearest = world_view.find_nearest_campfire()
        if nearest and world_view.distance_to(nearest.get("x", 0), nearest.get("y", 0)) < 150.0:
            return Status.FAILURE

        # Build campfire slightly offset from current position
        cf_x = round(world_view.x + 30.0)
        cf_y = round(world_view.y + 10.0)

        actions.append(BuildAction(structure_type="campfire", x=cf_x, y=cf_y))
        self.last_built_time = now
        return Status.SUCCESS


class AttackAndKiteAction(Node):
    """
    Tactical Combat Node:
    - Shoots projectile directly at nearest enemy.
    - Kites: retreats if enemy is too close, advances if too far, strafes if in optimal range.
    """

    def __init__(
        self,
        combat_range: float = 240.0,
        optimal_dist: float = 170.0,
        dist_tolerance: float = 35.0,
        name: Optional[str] = None
    ):
        super().__init__(name=name or "AttackAndKiteAction")
        self.combat_range = combat_range
        self.optimal_dist = optimal_dist
        self.dist_tolerance = dist_tolerance
        self.strafe_direction = 1.0
        self.last_strafe_switch = 0.0

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        enemy = world_view.find_nearest_enemy(max_range=self.combat_range)
        if not enemy:
            return Status.FAILURE

        ex, ey = float(enemy.get("x", 0)), float(enemy.get("y", 0))
        dist = world_view.distance_to(ex, ey)
        angle = world_view.angle_to(ex, ey)

        # 1. Fire projectile towards enemy
        actions.append(ShootAction(angle=angle))

        # 2. Movement tactical kite
        dx, dy = world_view.direction_to(ex, ey)

        # Switch strafe direction randomly every 1.5 seconds
        now = time.time()
        if now - self.last_strafe_switch > 1.5:
            self.strafe_direction = -self.strafe_direction if random.random() > 0.3 else self.strafe_direction
            self.last_strafe_switch = now

        if dist < (self.optimal_dist - self.dist_tolerance):
            # Enemy is too close -> Back up (retreat vector) with slight strafe
            perp_dx = -dy * self.strafe_direction * 0.5
            perp_dy = dx * self.strafe_direction * 0.5
            actions.append(MoveAction(dx=-dx + perp_dx, dy=-dy + perp_dy))
        elif dist > (self.optimal_dist + self.dist_tolerance):
            # Enemy is escaping -> Chase closer
            actions.append(MoveAction(dx=dx, dy=dy))
        else:
            # In sweet spot range -> Circle / strafe around enemy
            perp_dx = -dy * self.strafe_direction
            perp_dy = dx * self.strafe_direction
            actions.append(MoveAction(dx=perp_dx, dy=perp_dy))

        return Status.RUNNING


class HarvestNearestResourceAction(Node):
    """
    Finds closest resource (tree, rock, bush).
    Moves towards it if out of range, or performs HARVEST when close enough.
    """

    def __init__(self, harvest_range: float = 55.0, resource_type: Optional[str] = None, name: Optional[str] = None):
        super().__init__(name=name or f"HarvestResourceAction({resource_type or 'any'})")
        self.harvest_range = harvest_range
        self.resource_type = resource_type

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        target = world_view.find_nearest_resource(resource_type=self.resource_type)
        if not target:
            return Status.FAILURE

        tx, ty = float(target.get("x", 0)), float(target.get("y", 0))
        target_id = target.get("id")
        dist = world_view.distance_to(tx, ty)

        if dist <= self.harvest_range:
            # In range to mine/chop
            actions.append(MoveAction(dx=0.0, dy=0.0))  # Stop moving
            actions.append(HarvestAction(target_id=target_id))
            return Status.SUCCESS
        else:
            # Move towards the resource
            dx, dy = world_view.direction_to(tx, ty)
            actions.append(MoveAction(dx=dx, dy=dy))
            return Status.RUNNING


class WanderExploreAction(Node):
    """
    Wanders smoothly across the map, keeping within bounds.
    """

    def __init__(self, name: Optional[str] = None):
        super().__init__(name=name or "WanderExploreAction")
        self.current_dx = 0.0
        self.current_dy = 0.0
        self.change_time = 0.0

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        now = time.time()

        # Check map boundaries: if too close to border, head towards map center
        margin = 80.0
        cx = world_view.world_width / 2.0
        cy = world_view.world_height / 2.0

        if (world_view.x < margin or world_view.x > world_view.world_width - margin or
                world_view.y < margin or world_view.y > world_view.world_height - margin):
            dx, dy = world_view.direction_to(cx, cy)
            self.current_dx = dx
            self.current_dy = dy
            self.change_time = now
        elif now - self.change_time > 2.0:
            # Pick a new smooth wandering angle
            angle = random.uniform(0, 2 * math.pi)
            self.current_dx = math.cos(angle)
            self.current_dy = math.sin(angle)
            self.change_time = now

        actions.append(MoveAction(dx=self.current_dx, dy=self.current_dy))
        return Status.SUCCESS
