"""
KinesisTelemetryPublisher: pushes bot telemetry to the Kinesis pipeline.

Every interval it emits one `npc` record per world that has a bot pool and one
`npc-service` heartbeat for this replica (see .docs/telemetry-pipeline.md). Each world
has a single owning replica, so world records never collide; heartbeats carry the
replica's instanceId and the reader sums them. The NPC used to be scraped
by the metrics service; reporting itself lets that service run stateless in both AZs.

Publishing is best-effort: failures are logged and retried on the next tick. boto3
is blocking, so the call runs in the default executor to keep the bot loops smooth.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("Telemetry")

SERVICE_PARTITION_KEY_PREFIX = "npc-service#"
FAILURE_LOG_EVERY = 12


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_records(status: Dict[str, Any], timestamp: Optional[str] = None,
                  instance_id: str = "unknown") -> List[Dict[str, Any]]:
    """
    Turns BotManager.get_status() into the Kinesis records of the contract.

    Returns a list of {"Data": bytes, "PartitionKey": str} ready for put_records.
    The heartbeat always goes; a world record goes per world with a pool.
    """
    ts = timestamp or _utc_now_iso()
    worlds = status.get("worlds") or {}

    records: List[Dict[str, Any]] = []
    for world_id, summary in worlds.items():
        latency = summary.get("aiLatency") or {}
        record = {
            "type": "npc",
            "schemaVersion": 1,
            "worldId": world_id,
            "timestamp": ts,
            "botCount": int(summary.get("botCount") or 0),
            "aiLatency": {
                "avgMs": latency.get("avgMs"),
                "p95Ms": latency.get("p95Ms"),
                "maxMs": latency.get("maxMs"),
                "decisions": int(latency.get("decisions") or 0),
            },
        }
        records.append({"Data": _encode(record), "PartitionKey": world_id})

    heartbeat = {
        "type": "npc-service",
        "schemaVersion": 1,
        "instanceId": instance_id,
        "timestamp": ts,
        "totalBots": int(status.get("totalBotsCount") or 0),
        "activeWorlds": int(status.get("activeWorldsCount") or len(worlds)),
    }
    records.append({"Data": _encode(heartbeat), "PartitionKey": SERVICE_PARTITION_KEY_PREFIX + instance_id})
    return records


def _encode(record: Dict[str, Any]) -> bytes:
    return json.dumps(record, separators=(",", ":")).encode("utf-8")


class KinesisTelemetryPublisher:
    """Periodic publisher. `client` is injectable so tests never touch AWS."""

    def __init__(
        self,
        stream_name: str,
        get_status,
        region: str = "us-east-1",
        interval_seconds: float = 5.0,
        client=None,
        instance_id: str = "unknown",
    ):
        if not stream_name:
            raise ValueError("TELEMETRY_STREAM_NAME is required when TELEMETRY_MODE=kinesis.")
        self.stream_name = stream_name
        self.get_status = get_status
        self.interval_seconds = interval_seconds
        self.instance_id = instance_id
        self.client = client or self._create_client(region)
        self.consecutive_failures = 0
        self.published_batches = 0
        self._task: Optional[asyncio.Task] = None

    @staticmethod
    def _create_client(region: str):
        import boto3  # Imported lazily: local development does not need it installed.

        return boto3.client("kinesis", region_name=region)

    def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._run(), name="telemetry-publisher")
        logger.info(
            f"Publishing bot telemetry to Kinesis stream '{self.stream_name}' every {self.interval_seconds}s."
        )

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        while True:
            await self.publish()
            await asyncio.sleep(self.interval_seconds)

    async def publish(self) -> bool:
        """Sends one batch. Returns True on success; never raises."""
        try:
            records = build_records(self.get_status(), instance_id=self.instance_id)
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.client.put_records(StreamName=self.stream_name, Records=records),
            )
            failed = int(response.get("FailedRecordCount") or 0)
            if failed:
                raise RuntimeError(f"{failed} of {len(records)} records rejected by Kinesis")
            if self.consecutive_failures >= FAILURE_LOG_EVERY:
                logger.info(
                    f"Kinesis stream '{self.stream_name}' reachable again after {self.consecutive_failures} failed attempts."
                )
            self.consecutive_failures = 0
            self.published_batches += 1
            return True
        except Exception as exc:  # noqa: BLE001 - telemetry must never crash the service
            self.consecutive_failures += 1
            if self.consecutive_failures == 1 or self.consecutive_failures % FAILURE_LOG_EVERY == 0:
                logger.warning(
                    f"Failed to publish to Kinesis stream '{self.stream_name}' "
                    f"({self.consecutive_failures} in a row): {exc}"
                )
            return False
