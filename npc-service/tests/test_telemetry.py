"""
Unit tests for the Kinesis telemetry publisher. A fake client stands in for boto3,
so nothing here needs AWS access or network.
"""

import asyncio
import json
import pytest

from src.telemetry.publisher import KinesisTelemetryPublisher, build_records, SERVICE_PARTITION_KEY_PREFIX


class FakeKinesisClient:
    def __init__(self):
        self.calls = []
        self.fail_next = 0
        self.reject_next = 0

    def put_records(self, StreamName, Records):
        if self.fail_next > 0:
            self.fail_next -= 1
            raise RuntimeError("EndpointConnectionError")
        self.calls.append({"StreamName": StreamName, "Records": Records})
        if self.reject_next > 0:
            self.reject_next -= 1
            return {"FailedRecordCount": 1, "Records": []}
        return {"FailedRecordCount": 0, "Records": []}


def _status():
    return {
        "activeWorldsCount": 2,
        "totalBotsCount": 3,
        "worlds": {
            "world-01": {
                "worldId": "world-01",
                "botCount": 2,
                "aiLatency": {"avgMs": 1.8, "p95Ms": 4.2, "maxMs": 9.0, "decisions": 120},
            },
            "world-02": {
                "worldId": "world-02",
                "botCount": 1,
                "aiLatency": {"avgMs": None, "p95Ms": None, "maxMs": None, "decisions": 0},
            },
        },
    }


def _decode(record):
    return json.loads(record["Data"].decode("utf-8"))


def test_build_records_emits_one_per_world_plus_heartbeat():
    records = build_records(_status(), timestamp="2026-10-15T12:00:00.000Z", instance_id="task-a")
    assert len(records) == 3

    by_key = {r["PartitionKey"]: _decode(r) for r in records}
    assert set(by_key) == {"world-01", "world-02", SERVICE_PARTITION_KEY_PREFIX + "task-a"}

    w1 = by_key["world-01"]
    assert w1["type"] == "npc" and w1["schemaVersion"] == 1
    assert w1["worldId"] == "world-01" and w1["timestamp"] == "2026-10-15T12:00:00.000Z"
    assert w1["botCount"] == 2
    assert w1["aiLatency"] == {"avgMs": 1.8, "p95Ms": 4.2, "maxMs": 9.0, "decisions": 120}

    w2 = by_key["world-02"]
    assert w2["aiLatency"]["avgMs"] is None and w2["aiLatency"]["decisions"] == 0

    hb = by_key[SERVICE_PARTITION_KEY_PREFIX + "task-a"]
    assert hb["type"] == "npc-service" and hb["totalBots"] == 3 and hb["activeWorlds"] == 2
    assert hb["instanceId"] == "task-a"


def test_build_records_with_no_worlds_still_sends_heartbeat():
    records = build_records({"activeWorldsCount": 0, "totalBotsCount": 0, "worlds": {}})
    assert len(records) == 1
    hb = _decode(records[0])
    assert hb["type"] == "npc-service" and hb["totalBots"] == 0 and hb["activeWorlds"] == 0
    assert hb["timestamp"].endswith("Z")


def test_publisher_requires_stream_name():
    with pytest.raises(ValueError):
        KinesisTelemetryPublisher(stream_name="", get_status=_status, client=FakeKinesisClient())


@pytest.mark.asyncio
async def test_publish_sends_batch_to_configured_stream():
    client = FakeKinesisClient()
    publisher = KinesisTelemetryPublisher(
        stream_name="elastic-worlds-telemetry", get_status=_status, client=client
    )

    assert await publisher.publish() is True
    assert len(client.calls) == 1
    assert client.calls[0]["StreamName"] == "elastic-worlds-telemetry"
    assert len(client.calls[0]["Records"]) == 3
    assert publisher.published_batches == 1


@pytest.mark.asyncio
async def test_publish_failures_are_isolated_and_counted():
    client = FakeKinesisClient()
    publisher = KinesisTelemetryPublisher(stream_name="s", get_status=_status, client=client)

    client.fail_next = 2
    assert await publisher.publish() is False
    assert await publisher.publish() is False
    assert publisher.consecutive_failures == 2

    client.reject_next = 1
    assert await publisher.publish() is False, "Partially rejected batches count as failures"
    assert publisher.consecutive_failures == 3

    assert await publisher.publish() is True
    assert publisher.consecutive_failures == 0
    assert publisher.published_batches == 1


@pytest.mark.asyncio
async def test_start_and_stop_manage_background_task():
    client = FakeKinesisClient()
    publisher = KinesisTelemetryPublisher(
        stream_name="s", get_status=_status, client=client, interval_seconds=60
    )
    publisher.start()
    assert publisher._task is not None
    # Let the first iteration run.
    for _ in range(5):
        if client.calls:
            break
        await asyncio.sleep(0.01)
    assert len(client.calls) == 1
    await publisher.stop()
    assert publisher._task is None

