"""
Action Value Objects produced by the Brain / Behavior Tree.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Action:
    """Base class for all bot actions."""
    pass


@dataclass(frozen=True)
class MoveAction(Action):
    """Commands the bot to move in the given normalized direction (dx, dy)."""
    dx: float
    dy: float


@dataclass(frozen=True)
class ShootAction(Action):
    """Commands the bot to shoot a projectile at the specified angle (in radians)."""
    angle: float


@dataclass(frozen=True)
class HarvestAction(Action):
    """Commands the bot to harvest / mine a target resource."""
    target_id: Optional[str] = None


@dataclass(frozen=True)
class BuildAction(Action):
    """Commands the bot to build a structure ('wall', 'campfire', 'turret') at coordinates (x, y)."""
    structure_type: str
    x: float
    y: float


@dataclass(frozen=True)
class UseItemAction(Action):
    """Commands the bot to consume an inventory item ('food')."""
    item: str = "food"


@dataclass(frozen=True)
class IdleAction(Action):
    """Commands the bot to stand still / do nothing."""
    pass
