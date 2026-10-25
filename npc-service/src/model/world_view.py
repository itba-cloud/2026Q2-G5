"""
WorldView: Spatial and entity representation of the game world as perceived by the bot.
Maintains synchronized local state and exposes query helpers for the Behavior Tree.
"""

import math
from typing import Any, Dict, List, Optional, Tuple


class WorldView:
    def __init__(self, bot_id: str = "", bot_name: str = ""):
        self.bot_id: str = bot_id
        self.bot_name: str = bot_name

        # Bot self state
        self.x: float = 500.0
        self.y: float = 500.0
        self.hp: float = 100.0
        self.max_hp: float = 100.0
        self.is_dead: bool = False
        self.inventory: Dict[str, int] = {"wood": 0, "stone": 0, "food": 0}

        # World parameters
        self.world_width: float = 1000.0
        self.world_height: float = 1000.0
        self.seed: int = 0

        # Entities in the world
        self.players: Dict[str, Dict[str, Any]] = {}
        self.resources: Dict[str, Dict[str, Any]] = {}
        self.structures: Dict[str, Dict[str, Any]] = {}
        self.projectiles: List[Dict[str, Any]] = []

        # Internal tick tracking
        self.last_tick: int = 0
        self.last_sync_timestamp: float = 0.0

    def update_from_init(self, init_data: Dict[str, Any]) -> None:
        """Hydrates the initial world state from the server's INIT packet."""
        self.bot_id = init_data.get("playerId", self.bot_id)
        self.world_width = float(init_data.get("worldWidth", 1000))
        self.world_height = float(init_data.get("worldHeight", 1000))
        self.seed = int(init_data.get("seed", 0))

        # Self player info
        self_data = init_data.get("player")
        if self_data:
            self.x = float(self_data.get("x", self.x))
            self.y = float(self_data.get("y", self.y))
            self.hp = float(self_data.get("hp", self.hp))
            self.max_hp = float(self_data.get("maxHp", self.max_hp))
            self.inventory = dict(self_data.get("inventory", self.inventory))

        # Resources
        raw_resources = init_data.get("resources", [])
        self.resources = {r["id"]: r for r in raw_resources if "id" in r}

        # Structures
        raw_structures = init_data.get("structures", [])
        self.structures = {s["id"]: s for s in raw_structures if "id" in s}

        # Other players
        raw_players = init_data.get("players", [])
        self.players = {p["id"]: p for p in raw_players if "id" in p and p["id"] != self.bot_id}

    def update_from_sync(self, sync_data: Dict[str, Any]) -> None:
        """Synchronizes world state from continuous STATE_SYNC broadcast."""
        self.last_tick = sync_data.get("tick", self.last_tick)
        self.last_sync_timestamp = float(sync_data.get("timestamp", 0))

        # 1. Update players
        synced_players = sync_data.get("players", [])
        new_players_map: Dict[str, Dict[str, Any]] = {}

        for p in synced_players:
            p_id = p.get("id")
            if not p_id:
                continue

            if p_id == self.bot_id:
                # Update self state
                self.x = float(p.get("x", self.x))
                self.y = float(p.get("y", self.y))
                self.hp = float(p.get("hp", self.hp))
                self.max_hp = float(p.get("maxHp", self.max_hp))
                self.is_dead = bool(p.get("isDead", False))
                if "inventory" in p and isinstance(p["inventory"], dict):
                    self.inventory = dict(p["inventory"])
            else:
                new_players_map[p_id] = p

        self.players = new_players_map

        # 2. Update structures
        synced_structures = sync_data.get("structures", [])
        self.structures = {s["id"]: s for s in synced_structures if "id" in s}

        # 3. Update projectiles
        self.projectiles = sync_data.get("projectiles", [])

    def handle_resource_harvested(self, resource_id: str, player_inventory: Optional[Dict[str, int]] = None) -> None:
        """Removes depleted resource and updates inventory if harvested by this bot."""
        if resource_id in self.resources:
            del self.resources[resource_id]
        if player_inventory is not None:
            self.inventory = dict(player_inventory)

    def handle_structure_built(self, structure: Dict[str, Any], player_inventory: Optional[Dict[str, int]] = None) -> None:
        """Registers a newly built structure."""
        if "id" in structure:
            self.structures[structure["id"]] = structure
        if player_inventory is not None:
            self.inventory = dict(player_inventory)

    def handle_structure_destroyed(self, structure_id: str) -> None:
        """Removes a destroyed structure."""
        if structure_id in self.structures:
            del self.structures[structure_id]

    # --- Spatial Query Helpers ---

    def distance_to(self, target_x: float, target_y: float) -> float:
        """Euclidean distance from bot to given point."""
        return math.hypot(target_x - self.x, target_y - self.y)

    def angle_to(self, target_x: float, target_y: float) -> float:
        """Angle in radians from bot to given point (suitable for SHOOT)."""
        return math.atan2(target_y - self.y, target_x - self.x)

    def direction_to(self, target_x: float, target_y: float) -> Tuple[float, float]:
        """Normalized (dx, dy) vector from bot to given point."""
        dist = self.distance_to(target_x, target_y)
        if dist < 1e-4:
            return 0.0, 0.0
        return (target_x - self.x) / dist, (target_y - self.y) / dist

    def find_nearest_resource(self, resource_type: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Returns the closest active resource, optionally filtered by type ('tree', 'rock', 'bush')."""
        candidates = [
            r for r in self.resources.values()
            if resource_type is None or r.get("type") == resource_type
        ]
        if not candidates:
            return None
        return min(candidates, key=lambda r: self.distance_to(r.get("x", 0), r.get("y", 0)))

    def find_nearest_enemy(self, max_range: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """Returns the closest alive other player within max_range."""
        alive_players = [
            p for p in self.players.values()
            if not p.get("isDead", False)
        ]
        if not alive_players:
            return None

        nearest = min(alive_players, key=lambda p: self.distance_to(p.get("x", 0), p.get("y", 0)))
        dist = self.distance_to(nearest.get("x", 0), nearest.get("y", 0))

        if max_range is not None and dist > max_range:
            return None
        return nearest

    def find_nearest_campfire(self) -> Optional[Dict[str, Any]]:
        """Returns the closest campfire structure."""
        campfires = [s for s in self.structures.values() if s.get("type") == "campfire"]
        if not campfires:
            return None
        return min(campfires, key=lambda s: self.distance_to(s.get("x", 0), s.get("y", 0)))

    def is_under_threat(self, threat_radius: float = 200.0) -> bool:
        """Evaluates whether the bot is currently in imminent danger (enemy player or incoming projectiles)."""
        nearest_enemy = self.find_nearest_enemy(max_range=threat_radius)
        if nearest_enemy is not None:
            return True

        # Check for projectiles traveling towards bot
        for proj in self.projectiles:
            if proj.get("shooterId") == self.bot_id:
                continue
            dist = self.distance_to(proj.get("x", 0), proj.get("y", 0))
            if dist < 120.0:
                return True
        return False
