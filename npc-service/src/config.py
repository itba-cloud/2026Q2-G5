"""
Configuration module for NPC Bot Service.
Loads configuration from environment variables or .env file.
"""

import os
from pathlib import Path
from dataclasses import dataclass

# Search and load .env in hierarchical order without overriding existing env vars
_current_dir = Path(__file__).resolve().parent
_module_env = _current_dir.parent / ".env"
_root_env = _current_dir.parent.parent / ".env"

try:
    from dotenv import load_dotenv
    if _root_env.exists():
        load_dotenv(dotenv_path=_root_env, override=False)
    if _module_env.exists():
        load_dotenv(dotenv_path=_module_env, override=False)
    load_dotenv(override=False)
except ImportError:
    pass


@dataclass(frozen=True)
class Config:
    # HTTP REST API Settings
    HTTP_PORT: int = int(os.getenv("NPC_HTTP_PORT", os.getenv("PORT", "5001")))
    HTTP_HOST: str = os.getenv("NPC_HTTP_HOST", "0.0.0.0")

    # World Service WebSocket Connection (Default fallback)
    WORLD_WS_URL: str = os.getenv("WORLD_WS_URL", "ws://localhost:8001")
    AUTO_SPAWN_DEFAULT_WORLD: bool = os.getenv("AUTO_SPAWN_DEFAULT_WORLD", "false").lower() == "true"
    
    # Bot identity & scaling
    BOT_NAME_PREFIX: str = os.getenv("BOT_NAME_PREFIX", "[NPC] Guardian")
    BOT_COUNT: int = int(os.getenv("BOT_COUNT", "2"))
    
    # Tick rates and timeouts
    DECISION_TICK_RATE_HZ: float = float(os.getenv("DECISION_TICK_RATE_HZ", "10"))
    RECONNECT_DELAY_SECONDS: float = float(os.getenv("RECONNECT_DELAY_SECONDS", "3.0"))
    
    # Bot Combat & Tactical Parameters
    COMBAT_RANGE: float = float(os.getenv("BOT_COMBAT_RANGE", "240.0"))
    OPTIMAL_DISTANCE: float = float(os.getenv("BOT_OPTIMAL_DISTANCE", "170.0"))
    FLEE_HEALTH_THRESHOLD: float = float(os.getenv("BOT_FLEE_HEALTH_THRESHOLD", "35.0"))
    HEAL_HEALTH_THRESHOLD: float = float(os.getenv("BOT_HEAL_HEALTH_THRESHOLD", "80.0"))
    HARVEST_MAX_RANGE: float = float(os.getenv("BOT_HARVEST_MAX_RANGE", "55.0"))
    
    # 'leases': claim worlds through RDS leases (see manager/reconciler.py), the AWS
    # mode. 'standalone': no database, only AUTO_SPAWN_DEFAULT_WORLD. Explicit on
    # purpose: DB_* is shared with the Lobby in the root .env, so its presence alone
    # must not switch the NPC to leases while the Lobby keeps its JSON store.
    ASSIGNMENT_MODE: str = os.getenv("NPC_ASSIGNMENT_MODE", "standalone").lower()
    DB_HOST: str = os.getenv("DB_HOST", "localhost")
    DB_PORT: int = int(os.getenv("DB_PORT", "5432"))
    DB_NAME: str = os.getenv("DB_NAME", "cloudgame")
    DB_USER: str = os.getenv("DB_USER", "dbadmin")
    DB_PASSWORD: str = os.getenv("DB_PASSWORD", "")
    DB_SECRET_ARN: str = os.getenv("DB_SECRET_ARN", "")
    DB_CA_FILE: str = os.getenv("DB_CA_FILE", "")
    RECONCILE_INTERVAL_SECONDS: float = float(os.getenv("RECONCILE_INTERVAL_SECONDS", "3"))
    LEASE_TTL_SECONDS: float = float(os.getenv("LEASE_TTL_SECONDS", "15"))
    MAX_WORLDS_PER_TASK: int = int(os.getenv("MAX_WORLDS_PER_TASK", "10"))
    CLAIM_BATCH: int = int(os.getenv("CLAIM_BATCH", "2"))

    # Telemetry push to the Kinesis pipeline (see .docs/telemetry-pipeline.md)
    TELEMETRY_MODE: str = os.getenv("TELEMETRY_MODE", "none").lower()
    TELEMETRY_STREAM_NAME: str = os.getenv("TELEMETRY_STREAM_NAME", "")
    TELEMETRY_INTERVAL_SECONDS: float = float(os.getenv("TELEMETRY_INTERVAL_SECONDS", "5"))
    AWS_REGION: str = os.getenv("AWS_REGION", "us-east-1")

    # Log Level
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")


config = Config()
