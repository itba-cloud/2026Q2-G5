"""Reads the probe secrets and reports only their shape, never their values."""
import ipaddress
import json
import os
import socket

import boto3
from botocore.config import Config

REGION = os.environ["AWS_REGION"]
CLIENT = boto3.client(
    "secretsmanager",
    config=Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 1}),
)


def _endpoint_addresses():
    host = f"secretsmanager.{REGION}.amazonaws.com"
    addresses = sorted({info[4][0] for info in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)})
    network = ipaddress.ip_network(os.environ["VPC_CIDR"])
    return {"host": host, "all_in_vpc": all(ipaddress.ip_address(a) in network for a in addresses), "count": len(addresses)}


def _internet_egress():
    # A public AWS host with no endpoint in this VPC; success would mean a route out.
    try:
        socket.create_connection((f"sts.{REGION}.amazonaws.com", 443), timeout=5).close()
        return "reachable"
    except OSError as error:
        return f"unreachable ({type(error).__name__})"


def _check(secret_id):
    try:
        value = CLIENT.get_secret_value(SecretId=secret_id)
    except Exception as error:  # noqa: BLE001 - the probe reports any failure
        code = getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__)
        return {"result": "FAIL", "error": code}
    try:
        data = json.loads(value["SecretString"])
    except (KeyError, ValueError):
        return {"result": "FAIL", "error": "SecretString is not JSON"}
    keys_ok = isinstance(data, dict) and all(isinstance(data.get(k), str) and data[k] for k in ("username", "password"))
    return {"result": "PASS" if keys_ok else "FAIL", "keys": sorted(data) if isinstance(data, dict) else []}


def handler(event, context):
    secrets = json.loads(os.environ["SECRET_IDS"])
    report = {
        "endpoint_dns": _endpoint_addresses(),
        "internet_egress": _internet_egress(),
        "secrets": {name: _check(arn) for name, arn in secrets.items()},
    }
    print(json.dumps(report))
    return report
