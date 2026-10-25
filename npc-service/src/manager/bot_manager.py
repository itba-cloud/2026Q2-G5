"""
BotManager: Coordinates and manages dynamic concurrent NPC bot client instances across multiple worlds.
"""

import asyncio
from collections import defaultdict
import logging
import time
from typing import Dict, List, Any, Optional
from src.network.client import NPCNetworkClient
from src.brain.behavior_tree.npc_tree import BehaviorTreeBrain

logger = logging.getLogger("BotManager")


class WorldBotPool:
    """Represents the pool of active bots running in a specific world."""

    def __init__(self, world_id: str, ws_url: str, runtime_id: Optional[str] = None):
        self.world_id: str = world_id
        self.ws_url: str = ws_url
        self.runtime_id: Optional[str] = runtime_id
        self.clients: List[NPCNetworkClient] = []
        self.tasks: List[asyncio.Task] = []
        self.created_at: float = time.time()

    def add_bot(self, client: NPCNetworkClient, task: asyncio.Task) -> None:
        self.clients.append(client)
        self.tasks.append(task)

    async def stop(self) -> None:
        """Stops and cancels all bots in this pool."""
        for client in self.clients:
            await client.stop()
        for task in self.tasks:
            if not task.done():
                task.cancel()
        self.clients.clear()
        self.tasks.clear()

    def get_ai_latency(self) -> Dict[str, Any]:
        """
        Aggregates Brain decision latency across every bot in this world.

        avgMs is weighted by each bot's sample count. A plain mean of per-bot means
        would let a bot that has only just connected, with a single slow first
        decision, dominate the reading of a world where every other bot is healthy.

        p95 is taken as the worst per-bot p95 rather than a pooled percentile: with a
        handful of bots that is both cheap and the more useful signal, since it surfaces
        the single slowest decision path instead of averaging it away.
        """
        per_bot = [c.get_ai_latency_stats() for c in self.clients]
        with_samples = [s for s in per_bot if s["samples"] > 0]

        if not with_samples:
            return {
                "avgMs": None, "p95Ms": None, "maxMs": None, "peakMs": None,
                "decisions": 0, "botsReporting": 0,
            }

        total_samples = sum(s["samples"] for s in with_samples)
        weighted_sum = sum(s["avgMs"] * s["samples"] for s in with_samples)

        return {
            "avgMs": round(weighted_sum / total_samples, 3),
            "p95Ms": round(max(s["p95Ms"] for s in with_samples), 3),
            "maxMs": round(max(s["maxMs"] for s in with_samples), 3),
            "peakMs": round(max(s["peakMs"] for s in per_bot if s["peakMs"] is not None), 3),
            "decisions": sum(s["decisions"] for s in per_bot),
            "botsReporting": len(with_samples),
        }

    def get_summary(self) -> Dict[str, Any]:
        return {
            "worldId": self.world_id,
            "wsUrl": self.ws_url,
            "runtimeId": self.runtime_id,
            "botCount": len(self.clients),
            "createdAt": self.created_at,
            "uptimeSeconds": round(time.time() - self.created_at, 1),
            "aiLatency": self.get_ai_latency(),
            "bots": [
                {
                    "name": c.bot_name,
                    "id": c.world_view.bot_id or "unassigned",
                    "status": c.status,
                    "hp": c.world_view.hp,
                    "isDead": c.world_view.is_dead,
                    "aiLatency": c.get_ai_latency_stats(),
                }
                for c in self.clients
            ]
        }


class BotManager:
    """
    Central manager for on-demand dynamic bot pools across multiple game worlds.
    """

    def __init__(self):
        self.pools: Dict[str, WorldBotPool] = {}
        self._world_locks = defaultdict(asyncio.Lock)

    async def spawn_bots_for_world(self, world_id, ws_url, count=2,
                                   name_prefix="[NPC] Guardian", tick_rate_hz=10.0,
                                   reconnect_delay=3.0, runtime_id=None):
        async with self._world_locks[world_id]:
            return await self._spawn_bots_for_world(world_id, ws_url, count, name_prefix,
                                                     tick_rate_hz, reconnect_delay, runtime_id)

    async def despawn_bots_for_world(self, world_id):
        async with self._world_locks[world_id]:
            return await self._despawn_bots_for_world(world_id)

    async def _spawn_bots_for_world(
        self,
        world_id: str,
        ws_url: str,
        count: int = 2,
        name_prefix: str = "[NPC] Guardian",
        tick_rate_hz: float = 10.0,
        reconnect_delay: float = 3.0,
        runtime_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Spawns and launches `count` bots connecting to `ws_url` for the given `world_id`.
        If bots already exist for this world, despawns them first to re-provision cleanly.
        """
        if world_id in self.pools:
            logger.info(f"[BotManager] World '{world_id}' already has an active bot pool. Despawning previous bots first...")
            await self._despawn_bots_for_world(world_id)

        if count <= 0:
            logger.info(f"[BotManager] Spawn requested with count <= 0 for world '{world_id}'. No bots created.")
            return []

        pool = WorldBotPool(world_id=world_id, ws_url=ws_url, runtime_id=runtime_id)
        self.pools[world_id] = pool

        logger.info(f"[BotManager] Spawning {count} bot(s) for world '{world_id}' at '{ws_url}'...")

        spawned_bots_summary = []

        for i in range(count):
            bot_name = f"{name_prefix} {i + 1}" if count > 1 else name_prefix
            brain = BehaviorTreeBrain()
            client = NPCNetworkClient(
                server_url=ws_url,
                bot_name=bot_name,
                world_id=world_id,
                brain=brain,
                tick_rate_hz=tick_rate_hz,
                reconnect_delay_sec=reconnect_delay,
            )
            task = asyncio.create_task(client.start(), name=f"BotTask-{world_id}-{bot_name}")
            pool.add_bot(client, task)

            spawned_bots_summary.append({
                "name": bot_name,
                "worldId": world_id,
                "status": "CONNECTING"
            })

        logger.info(f"[BotManager] Successfully spawned {count} bot(s) for world '{world_id}'.")
        return spawned_bots_summary

    async def _despawn_bots_for_world(self, world_id: str) -> int:
        """
        Stops and removes all bots assigned to `world_id`.
        Returns the number of bots despawned.
        """
        pool = self.pools.pop(world_id, None)
        if not pool:
            logger.info(f"[BotManager] Despawn called for world '{world_id}', but no active bot pool was found.")
            return 0

        bot_count = len(pool.clients)
        logger.info(f"[BotManager] Despawning {bot_count} bot(s) from world '{world_id}'...")
        await pool.stop()
        logger.info(f"[BotManager] World '{world_id}' bot pool cleared.")
        return bot_count

    def get_world_bots(self, world_id: str) -> Optional[Dict[str, Any]]:
        """Returns status summary for a specific world."""
        pool = self.pools.get(world_id)
        return pool.get_summary() if pool else None

    def get_status(self) -> Dict[str, Any]:
        """Returns status summary for all active worlds and bots."""
        total_bots = sum(len(p.clients) for p in self.pools.values())
        return {
            "status": "ok",
            "activeWorldsCount": len(self.pools),
            "totalBotsCount": total_bots,
            "worlds": {
                w_id: pool.get_summary()
                for w_id, pool in self.pools.items()
            }
        }

    async def stop_all(self) -> None:
        """Gracefully stops all managed bot instances across all worlds."""
        logger.info("[BotManager] Shutting down all active bot pools...")
        for world_id in list(self.pools.keys()):
            await self.despawn_bots_for_world(world_id)
        logger.info("[BotManager] All bot pools stopped cleanly.")
