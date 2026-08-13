#!/usr/bin/env python
"""
Signplane execution broker — performs REAL cloud API calls, multi-provider.

Providers:
  aws    boto3. Endpoint-agnostic: AWS_ENDPOINT_URL can be an emulator
         (moto/Floci/LocalStack) or the sentinel 'aws' for real endpoints.
         Credentials: env keys or boto3's default chain (instance profile).
  azure  Azure SDK (lazy import). Credentials: DefaultAzureCredential
         (az login / managed identity / env). Needs AZURE_SUBSCRIPTION_ID.
         operation is a dotted path on the mgmt client, e.g.
         "virtual_machines.begin_deallocate".
  gcp    googleapiclient discovery (lazy import). Credentials: Application
         Default Credentials (gcloud auth application-default login / SA key).
         operation is a dotted resource path, e.g. "instances.stop".

Reads one JSON command on stdin, writes one JSON result on stdout:
  {"op":"describe","provider":"aws","service":"ec2"}
  {"op":"execute","provider":"gcp","service":"compute","operation":"instances.stop","params":{...}}

SDKs for unused providers are not required: imports are lazy and a missing SDK
returns a clean, actionable error instead of a crash.
"""

import json
import os
import re
import sys


def snake(name):
    s1 = re.sub("(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub("([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


def ok(**kw):
    print(json.dumps({"ok": True, **kw}, default=str))


def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)[:500]}))


# ---------------------------------------------------------------- AWS

def aws_client(service, endpoint, region):
    import boto3
    from botocore.config import Config
    kwargs = {}
    if endpoint and "AWS_ACCESS_KEY_ID" not in os.environ:
        kwargs = {"aws_access_key_id": "signplane", "aws_secret_access_key": "signplane"}
    return boto3.client(
        service, endpoint_url=endpoint or None, region_name=region,
        config=Config(retries={"max_attempts": 1}, connect_timeout=5, read_timeout=20),
        **kwargs,
    )


def aws_describe(c, service):
    if service == "ec2":
        instances = []
        for res in c.describe_instances().get("Reservations", []):
            for i in res.get("Instances", []):
                instances.append({
                    "id": i["InstanceId"], "type": i.get("InstanceType"),
                    "state": i.get("State", {}).get("Name"),
                    "tags": {t["Key"]: t["Value"] for t in i.get("Tags", [])},
                })
        return {"instances": instances}
    if service == "s3":
        return {"buckets": [b["Name"] for b in c.list_buckets().get("Buckets", [])]}
    return {}


def aws_rollback_plan(service, op, params, result):
    if service == "ec2" and op == "run_instances":
        ids = [i["InstanceId"] for i in result.get("Instances", [])]
        return {"provider": "aws", "service": "ec2", "operation": "terminate_instances", "params": {"InstanceIds": ids}}
    if service == "s3" and op == "create_bucket":
        return {"provider": "aws", "service": "s3", "operation": "delete_bucket", "params": {"Bucket": params.get("Bucket")}}
    if service == "ec2" and op == "create_security_group":
        return {"provider": "aws", "service": "ec2", "operation": "delete_security_group", "params": {"GroupId": result.get("GroupId")}}
    return None


def aws_summarize(op, params, result):
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


def run_aws(req):
    endpoint = req.get("endpoint") or os.environ.get("AWS_ENDPOINT_URL") or "http://localhost:5000"
    if str(endpoint).lower() in ("aws", "real", "default"):
        endpoint = None
    region = req.get("region") or os.environ.get("AWS_REGION") or "us-east-1"
    service = req.get("service")
    c = aws_client(service, endpoint, region)
    if req["op"] == "describe":
        return ok(result=aws_describe(c, service))
    operation = snake(req["operation"])
    params = req.get("params") or {}
    result = getattr(c, operation)(**params)
    if isinstance(result, dict):
        result.pop("ResponseMetadata", None)
    plan = aws_rollback_plan(service, operation, params, result)
    ok(result=result, summary=aws_summarize(operation, params, result),
       rollback_available=plan is not None, rollback_plan=plan)


# ---------------------------------------------------------------- Azure

AZURE_CLIENTS = {
    "compute": ("azure.mgmt.compute", "ComputeManagementClient"),
    "network": ("azure.mgmt.network", "NetworkManagementClient"),
    "storage": ("azure.mgmt.storage", "StorageManagementClient"),
    "resource": ("azure.mgmt.resource", "ResourceManagementClient"),
}


def run_azure(req):
    try:
        import importlib
        from azure.identity import DefaultAzureCredential
    except ImportError:
        return fail("Azure SDK not installed. pip install azure-identity azure-mgmt-compute "
                    "azure-mgmt-network azure-mgmt-storage azure-mgmt-resource")
    sub = os.environ.get("AZURE_SUBSCRIPTION_ID")
    if not sub:
        return fail("AZURE_SUBSCRIPTION_ID is not set")
    service = req.get("service", "compute")
    if service not in AZURE_CLIENTS:
        return fail(f"unsupported azure service '{service}' (supported: {', '.join(AZURE_CLIENTS)})")
    mod_name, cls_name = AZURE_CLIENTS[service]
    try:
        mod = importlib.import_module(mod_name)
    except ImportError:
        return fail(f"pip install {mod_name.replace('.', '-')}")
    client = getattr(mod, cls_name)(DefaultAzureCredential(), sub)

    def serialize(obj):
        if hasattr(obj, "as_dict"):
            return obj.as_dict()
        return obj

    if req["op"] == "describe":
        if service == "compute":
            vms = [{"name": v.name, "location": v.location,
                    "size": getattr(getattr(v, "hardware_profile", None), "vm_size", None),
                    "state": getattr(v, "provisioning_state", None)}
                   for v in client.virtual_machines.list_all()]
            return ok(result={"virtual_machines": vms})
        return ok(result={})

    # operation is a dotted path on the client: "virtual_machines.begin_deallocate"
    target = client
    for part in req["operation"].split("."):
        target = getattr(target, part)
    result = target(**(req.get("params") or {}))
    if hasattr(result, "result"):          # LRO poller → wait for completion
        result = result.result()
    ok(result=serialize(result), summary=f"azure {req['operation']} ok",
       rollback_available=False, rollback_plan=None)


# ---------------------------------------------------------------- GCP

GCP_VERSIONS = {"compute": "v1", "storage": "v1", "sqladmin": "v1", "container": "v1"}


def run_gcp(req):
    try:
        from googleapiclient import discovery
        import google.auth
    except ImportError:
        return fail("GCP SDK not installed. pip install google-api-python-client google-auth")
    try:
        creds, default_project = google.auth.default()
    except Exception as e:
        return fail(f"GCP credentials unavailable ({e}). Run: gcloud auth application-default login")
    service = req.get("service", "compute")
    svc = discovery.build(service, GCP_VERSIONS.get(service, "v1"), credentials=creds, cache_discovery=False)
    project = (req.get("params") or {}).get("project") or os.environ.get("GOOGLE_CLOUD_PROJECT") or default_project

    if req["op"] == "describe":
        if service == "compute" and project:
            agg = svc.instances().aggregatedList(project=project).execute()
            instances = []
            for scope in (agg.get("items") or {}).values():
                for i in scope.get("instances", []) or []:
                    instances.append({"name": i.get("name"), "zone": i.get("zone", "").split("/")[-1],
                                      "type": i.get("machineType", "").split("/")[-1], "status": i.get("status")})
            return ok(result={"instances": instances})
        return ok(result={})

    # operation is a dotted resource path: "instances.stop"
    parts = req["operation"].split(".")
    resource = svc
    for part in parts[:-1]:
        resource = getattr(resource, part)()
    params = dict(req.get("params") or {})
    if "project" not in params and project:
        params["project"] = project
    result = getattr(resource, parts[-1])(**params).execute()
    ok(result=result, summary=f"gcp {req['operation']} ok",
       rollback_available=False, rollback_plan=None)


# ---------------------------------------------------------------- main

def main():
    req = json.loads(sys.stdin.read().lstrip("﻿"))
    provider = (req.get("provider") or "aws").lower()
    try:
        if provider == "aws":
            run_aws(req)
        elif provider == "azure":
            run_azure(req)
        elif provider == "gcp":
            run_gcp(req)
        else:
            fail(f"unknown provider '{provider}' (aws | azure | gcp)")
    except Exception as e:  # noqa: BLE001 — everything must come back as JSON
        fail(e)


if __name__ == "__main__":
    main()
