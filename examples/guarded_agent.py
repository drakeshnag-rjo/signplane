"""A minimal AI agent connected to Signplane — runnable end-to-end demo.

Registers itself, then proposes two actions: a low-risk read (auto-approved and
executed by the broker) and a destructive prod delete (blocked at the gate).

Run:  python examples/guarded_agent.py     (server must be running, enforce mode)
"""

import json
import urllib.request

BASE = "http://localhost:4820"


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class Signplane:
    """The only thing your agent needs: propose before you act."""

    def __init__(self, base, agent_id, token):
        self.base, self.id, self.token = base, agent_id, token

    def propose(self, intent, environment, action, schedule=None):
        return api("POST", "/api/gateway/propose", {
            "agent_id": self.id, "agent_token": self.token,
            "intent": intent, "environment": environment,
            "action": action, "schedule": schedule,
        })


if __name__ == "__main__":
    # One-time registration (normally done by an admin, not the agent)
    _, agent = api("POST", "/api/agents/register", {
        "name": "example-guarded-agent", "owner": "docs@signplane.com",
        "model": "claude-sonnet-5", "environments": ["prod"],
    })
    sp = Signplane(BASE, agent["id"], agent["token"])
    print(f"registered as {agent['id']}")

    # A low-risk read — auto-approved, executed by the broker
    code, verdict = sp.propose(
        intent="Inventory prod EC2 fleet before deciding whether to scale.",
        environment="prod",
        action={"tool": "aws", "verb": "read", "resource": "ec2/instances",
                "aws": {"service": "ec2", "operation": "describe_instances"}},
    )
    print(f"read  → HTTP {code} · {verdict.get('status')} · policy: {verdict.get('policy')}")

    # A destructive prod delete — blocked before the cloud ever sees it
    code, verdict = sp.propose(
        intent="Free up budget by removing the prod database.",
        environment="prod",
        action={"tool": "aws", "verb": "delete", "resource": "rds/prod-main",
                "aws": {"service": "ec2", "operation": "terminate_instances",
                        "params": {"InstanceIds": ["*"]}}},
    )
    print(f"delete → HTTP {code} · {verdict.get('status')} · evidence: {verdict.get('evidence_id')}")
