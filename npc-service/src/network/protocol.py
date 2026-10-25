"""
Protocol definitions and message schemas for communication with World Service.
Matches the protocol in world-service/src/network/protocol.js.
"""

import json
from typing import Any, Dict, Optional, Tuple


class MessageTypes:
    # Client -> Server
    JOIN = "JOIN"
    MOVE = "MOVE"
    SHOOT = "SHOOT"
    HARVEST = "HARVEST"
    BUILD = "BUILD"
    USE_ITEM = "USE_ITEM"
    CHAT_NPC = "CHAT_NPC"

    # Server -> Client
    INIT = "INIT"
    STATE_SYNC = "STATE_SYNC"
    PLAYER_JOINED = "PLAYER_JOINED"
    PLAYER_LEFT = "PLAYER_LEFT"
    RESOURCE_HARVESTED = "RESOURCE_HARVESTED"
    RESOURCE_DAMAGED = "RESOURCE_DAMAGED"
    STRUCTURE_BUILT = "STRUCTURE_BUILT"
    STRUCTURE_DESTROYED = "STRUCTURE_DESTROYED"
    PLAYER_HIT = "PLAYER_HIT"
    PLAYER_DIED = "PLAYER_DIED"
    PLAYER_RESPAWNED = "PLAYER_RESPAWNED"
    NPC_RESPONSE = "NPC_RESPONSE"
    ERROR = "ERROR"
    TOAST = "TOAST"


def parse_incoming_message(raw_data: str | bytes) -> Optional[Tuple[str, Dict[str, Any]]]:
    """
    Parses and validates an incoming JSON message from World Service.
    Returns (type, payload) tuple or None if invalid.
    """
    try:
        text = raw_data.decode("utf-8") if isinstance(raw_data, (bytes, bytearray)) else raw_data
        parsed = json.loads(text)
        if not isinstance(parsed, dict) or "type" not in parsed:
            return None
        return parsed["type"], parsed.get("payload", {})
    except Exception:
        return None


def create_message(msg_type: str, payload: Optional[Dict[str, Any]] = None) -> str:
    """
    Serializes a message dictionary into a JSON string to be sent over WebSocket.
    """
    return json.dumps({
        "type": msg_type,
        "payload": payload or {}
    })
