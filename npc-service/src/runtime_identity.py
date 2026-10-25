"""
Stable identity of this NPC replica, used as the lease owner and in telemetry.

On ECS it is the task id (the last segment of the task ARN), read from the task
metadata endpoint. Outside ECS it falls back to the hostname.
"""

import json
import logging
import os
import socket
import urllib.request

logger = logging.getLogger("RuntimeIdentity")


def resolve_instance_id(env=None, fetch_json=None) -> str:
    env = os.environ if env is None else env
    if env.get("NPC_INSTANCE_ID"):
        return env["NPC_INSTANCE_ID"]

    metadata_uri = env.get("ECS_CONTAINER_METADATA_URI_V4")
    if metadata_uri:
        try:
            task = (fetch_json or _fetch_json)(f"{metadata_uri}/task")
            return task["TaskARN"].rsplit("/", 1)[-1]
        except Exception as exc:  # noqa: BLE001 - the hostname still identifies the task
            logger.warning(f"Could not read the ECS task ARN ({exc}); using the hostname.")

    return socket.gethostname()


def _fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=2) as response:
        return json.loads(response.read().decode("utf-8"))
