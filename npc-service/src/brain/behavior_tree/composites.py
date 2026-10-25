"""
Composite Behavior Tree nodes: Selector, Sequence, and Parallel.
"""

from typing import List, Optional
from src.brain.behavior_tree.core import Node, Status
from src.model.world_view import WorldView
from src.model.actions import Action


class Selector(Node):
    """
    Selector (Fallback) Node.
    Executes children in order until one returns SUCCESS or RUNNING.
    Returns FAILURE only if all children fail.
    Used for expressing prioritized alternatives.
    """

    def __init__(self, children: List[Node], name: Optional[str] = None):
        super().__init__(name=name or "Selector")
        self.children: List[Node] = children

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        for child in self.children:
            status = child.tick(world_view, actions)
            if status != Status.FAILURE:
                return status
        return Status.FAILURE

    def reset(self) -> None:
        for child in self.children:
            child.reset()


class Sequence(Node):
    """
    Sequence Node.
    Executes children in order until one returns FAILURE or RUNNING.
    Returns SUCCESS only if all children succeed.
    Used for multi-step goals where all steps must pass.
    """

    def __init__(self, children: List[Node], name: Optional[str] = None):
        super().__init__(name=name or "Sequence")
        self.children: List[Node] = children

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        for child in self.children:
            status = child.tick(world_view, actions)
            if status != Status.SUCCESS:
                return status
        return Status.SUCCESS

    def reset(self) -> None:
        for child in self.children:
            child.reset()


class Parallel(Node):
    """
    Parallel Node.
    Executes all children and returns SUCCESS if a threshold of children succeed.
    """

    def __init__(self, children: List[Node], require_all: bool = True, name: Optional[str] = None):
        super().__init__(name=name or "Parallel")
        self.children: List[Node] = children
        self.require_all: bool = require_all

    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        success_count = 0
        failure_count = 0

        for child in self.children:
            status = child.tick(world_view, actions)
            if status == Status.SUCCESS:
                success_count += 1
            elif status == Status.FAILURE:
                failure_count += 1

        if self.require_all:
            if failure_count > 0:
                return Status.FAILURE
            if success_count == len(self.children):
                return Status.SUCCESS
            return Status.RUNNING
        else:
            if success_count > 0:
                return Status.SUCCESS
            if failure_count == len(self.children):
                return Status.FAILURE
            return Status.RUNNING

    def reset(self) -> None:
        for child in self.children:
            child.reset()
