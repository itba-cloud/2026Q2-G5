"""
Abstract Base Class for NPC Decision Brains (Strategy Pattern).
Allows swapping Behavior Trees with Neural Networks / RL in the future.
"""

from abc import ABC, abstractmethod
from typing import List
from src.model.world_view import WorldView
from src.model.actions import Action


class Brain(ABC):
    """
    Abstract interface for NPC decision-making engine.
    Receives current WorldView and returns a list of actions to execute this tick.
    """

    @abstractmethod
    def decide_actions(self, world_view: WorldView) -> List[Action]:
        """
        Evaluates current perception and generates actions.
        Can return 0, 1, or multiple actions (e.g. Move + Shoot in the same tick).
        """
        pass
