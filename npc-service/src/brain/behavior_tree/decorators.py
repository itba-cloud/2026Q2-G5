"""
Decorator Behavior Tree nodes: Inverter and Cooldown.
"""

import time
from typing import Optional
from src.brain.behavior_tree.core import Node, Status
from src.model.world_view import WorldView
from src.model.actions import Action


class Inverter(Node):
    """
    Inverts the result of its child node:
    - SUCCESS -> FAILURE
    - FAILURE -> SUCCESS
    - RUNNING -> RUNNING
    """

    def __init__(self, child: Node, name: Optional[str] = None):
        super().__init__(name=name or f"Inverter({child.name})")
        self.child: Node = child

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        status = self.child.tick(world_view, actions)
        if status == Status.SUCCESS:
            return Status.FAILURE
        if status == Status.FAILURE:
            return Status.SUCCESS
        return Status.RUNNING

    def reset(self) -> None:
        self.child.reset()


class Cooldown(Node):
    """
    Prevents child from executing until cooldown_seconds have elapsed since last SUCCESS/RUNNING.
    Returns FAILURE during cooldown period.
    """

    def __init__(self, child: Node, cooldown_seconds: float, name: Optional[str] = None):
        super().__init__(name=name or f"Cooldown({child.name}, {cooldown_seconds}s)")
        self.child: Node = child
        self.cooldown_seconds: float = cooldown_seconds
        self.last_execution_time: float = 0.0

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        now = time.time()
        if now - self.last_execution_time < self.cooldown_seconds:
            return Status.FAILURE

        status = self.child.tick(world_view, actions)
        if status in (Status.SUCCESS, Status.RUNNING):
            self.last_execution_time = now
        return status

    def reset(self) -> None:
        self.last_execution_time = 0.0
        self.child.reset()
