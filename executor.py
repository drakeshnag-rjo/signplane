#!/usr/bin/env python
"""
Signplane execution broker — performs REAL AWS API calls via boto3.

Endpoint-agnostic: point AWS_ENDPOINT_URL at moto (http://localhost:5000),
Floci/LocalStack (http://localhost:4566), or unset it for real AWS.
Reads one JSON command on stdin, writes one JSON result on stdout.

Commands:
  {"op":"describe","service":"ec2|s3"}                          -> state inventory (snapshots)
  {"op":"execute","service":..,"operation":..,"params":{..}}    -> real API call + rollback plan
"""

import json
import os
import re
import sys

import boto3
from botocore.config import Config


def snake(name):
    s1 = re.sub("(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub("([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


def client(service, endpoint, region):
    kwargs = {}
    if endpoint and "AWS_ACCESS_KEY_ID" not in os.environ:
        # Emulator target with no real credentials configured: any key works.
        kwargs = {"aws_access_key_id": "signplane", "aws_secret_access_key": "signplane"}
    # Real AWS (endpoint=None): let boto3's default chain resolve credentials —
    # env vars, shared config, or the VM's IAM instance profile.
    return boto3.client(
        service,
        endpoint_url=endpoint or None,
        region_name=region,
        config=Config(retries={"max_attempts": 1}, connect_timeout=5, read_timeout=20),
        **kwargs,
    )


def describe(c, service):
    if service == "ec2":
        instances = []
        for res in c.describe_instances().get("Reservations", []):
            for i in res.get("Instances", []):
                instances.append({
                    "id": i["InstanceId"],
                    "type": i.get("InstanceType"),
                    "state": i.get("State", {}).get("Name"),
                    "tags": {t["Key"]: t["Value"] for t in i.get("Tags", [])},
                })
        return {"instances": instances}
    if service == "s3":
        return {"buckets": [b["Name"] for b in c.list_buckets().get("Buckets", [])]}
    return {}


def rollback_plan(service, op, params, result):
    """Compensating action for operations we know how to safely undo."""
    if service == "ec2" and op == "run_instances":
        ids = [i["InstanceId"] for i in result.get("Instances", [])]
        return {"service": "ec2", "operation": "terminate_instances", "params": {"InstanceIds": ids}}
    if service == "s3" and op == "create_bucket":
        return {"service": "s3", "operation": "delete_bucket", "params": {"Bucket": params.get("Bucket")}}
    if service == "ec2" and op == "create_security_group":
        return {"service": "ec2", "operation": "delete_security_group", "params": {"GroupId": result.get("GroupId")}}
    return None


def summarize(service, op, params, result):
    if op == "run_instances":
        return "launched " + ", ".join(i["InstanceId"] for i in result.get("Instances", []))
    if op == "terminate_instances":
        return "terminated " + ", ".join(i["InstanceId"] for i in result.get("TerminatingInstances", []))
    if op == "create_bucket":
        return "created bucket " + str(params.get("Bucket"))
    if op == "delete_bucket":
        return "deleted bucket " + str(params.get("Bucket"))
    if op == "describe_instances":
        n = sum(len(r.get("Instances", [])) for r in result.get("Reservations", []))
        return f"{n} instance(s) described"
    return op + " ok"


def main():
    req = json.loads(sys.stdin.read().lstrip('\ufeff'))
    endpoint = req.get("endpoint") or os.environ.get("AWS_ENDPOINT_URL") or "http://localhost:5000"
    if str(endpoint).lower() in ("aws", "real", "default"):
        endpoint = None  # real AWS default endpoints
    region = req.get("region") or os.environ.get("AWS_REGION") or "us-east-1"
    op = req.get("op")
    service = req.get("service")
    try:
        c = client(service, endpoint, region)
        if op == "describe":
            print(json.dumps({"ok": True, "result": describe(c, service)}, default=str))
            return
        if op == "execute":
            operation = snake(req["operation"])
            params = req.get("params") or {}
            result = getattr(c, operation)(**params)
            result.pop("ResponseMetadata", None)
            plan = rollback_plan(service, operation, params, result)
            print(json.dumps({
                "ok": True,
                "result": result,
                "summary": summarize(service, operation, params, result),
                "rollback_available": plan is not None,
                "rollback_plan": plan,
            }, default=str))
            return
        print(json.dumps({"ok": False, "error": "unknown op: " + str(op)}))
    except Exception as e:  # noqa: BLE001 — everything must come back as JSON
        print(json.dumps({"ok": False, "error": str(e)[:500]}))


if __name__ == "__main__":
    main()
