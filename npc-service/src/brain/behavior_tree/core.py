"""
Core Behavior Tree constructs: Status enum and base Node class.
"""

from abc import ABC, abstractmethod
from enum import Enum, auto
from typing import List, Optional
from src.model.world_view import WorldView
from src.model.actions import Action


class Status(Enum):
    SUCCESS = auto()
    FAILURE = auto()
    RUNNING = auto()


class Node(ABC):
    """
    Base node in a Behavior Tree.
    """

    def __init__(self, name: Optional[str] = None):
        self.name: str = name or self.__class__.__name__

    @abstractmethod
    def tick(self, world_view: WorldView, actions: List[Action]) -> Status:
        """
        Executes the logic of this node.
        Appends any intended actions to the `actions` list.
        Returns Status.SUCCESS, Status.FAILURE, or Status.RUNNING.
        """
        pass

    def reset(self) -> None:
        """Resets any internal state of the node."""
        pass

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(name='{self.name}')"
