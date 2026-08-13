"""Signplane client — drop this single file into your agent project.

Stdlib only (urllib). Usage:

    from signplane import Signplane, Blocked

    sp = Signplane(agent_id="agt_...", token="...")   # url defaults to localhost:4820

    verdict = sp.propose(
        intent="Scale batch workers; queue depth > 10k",
        environment="dev",
        verb="write", resource="ec2/run-instances",
        cloud={"provider": "aws", "service": "ec2", "operation": "run_instances",
               "params": {"ImageId": "ami-12c6146b", "InstanceType": "t3.micro",
                          "MinCount": 1, "MaxCount": 1}},
    )
    if verdict.executed:  print("done:", verdict.summary)
    elif verdict.pending: verdict = sp.wait(verdict, timeout=600)   # blocks for approval

A Blocked exception means policy said no — the cloud never saw the request and
the attempt is already on the evidence record. Don't retry; surface the reason.
"""

import json
import os
import time
import urllib.error
import urllib.request

__all__ = ["Signplane", "Verdict", "Blocked"]


class Blocked(Exception):
    """Raised when the gateway blocks a proposal (policy or identity)."""
    def __init__(self, reason, intent_id=None, evidence_id=None):
        super().__init__(reason)
        self.reason, self.intent_id, self.evidence_id = reason, intent_id, evidence_id


class Verdict:
    def __init__(self, data):
        self.data = data

    intent_id = property(lambda s: s.data.get("intent_id") or s.data.get("id"))
    status = property(lambda s: s.data.get("status"))
    executed = property(lambda s: s.data.get("status") == "executed")
    pending = property(lambda s: s.data.get("status") == "pending")
    scheduled = property(lambda s: s.data.get("status") == "scheduled")
    rejected = property(lambda s: s.data.get("status") == "rejected")
    observed = property(lambda s: "would_have" in s.data or s.data.get("status") == "observed")
    would_have = property(lambda s: s.data.get("would_have"))
    risk = property(lambda s: s.data.get("risk"))
    policy = property(lambda s: s.data.get("policy") or s.data.get("policy_name"))
    evidence_id = property(lambda s: s.data.get("evidence_id"))

    @property
    def summary(self):
        execution = self.data.get("execution") or {}
        return execution.get("aws") or self.data.get("status")

    def __repr__(self):
        return f"<Verdict {self.status} risk={self.risk} intent={self.intent_id}>"


class Signplane:
    def __init__(self, agent_id=None, token=None, url=None):
        self.url = (url or os.environ.get("SIGNPLANE_URL") or "http://localhost:4820").rstrip("/")
        self.agent_id = agent_id or os.environ.get("SIGNPLANE_AGENT_ID")
        self.token = token or os.environ.get("SIGNPLANE_AGENT_TOKEN")
        if not self.agent_id or not self.token:
            raise ValueError("agent_id and token required (or SIGNPLANE_AGENT_ID / SIGNPLANE_AGENT_TOKEN env)")

    def _request(self, method, path, body=None):
        req = urllib.request.Request(
            self.url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def propose(self, intent, verb, resource, environment=None, cloud=None,
                resources_touched=None, cost_delta_usd_month=None, not_before=None):
        action = {"tool": (cloud or {}).get("provider", "generic"), "verb": verb, "resource": resource}
        if resources_touched:
            action["resources_touched"] = resources_touched
        if cost_delta_usd_month is not None:
            action["cost_delta_usd_month"] = cost_delta_usd_month
        if cloud:
            action["cloud"] = cloud
        status, body = self._request("POST", "/api/gateway/propose", {
            "agent_id": self.agent_id, "agent_token": self.token,
            "intent": intent,
            "environment": environment or os.environ.get("SIGNPLANE_ENVIRONMENT", "dev"),
            "action": action,
            "schedule": {"not_before": not_before} if not_before else None,
        })
        if status == 403:
            raise Blocked(body.get("reason") or body.get("policy") or "blocked",
                          body.get("intent_id"), body.get("evidence_id"))
        return Verdict(body)

    def status(self, intent_id):
        _, body = self._request("GET", f"/api/intents/{intent_id}")
        return Verdict(body)

    def wait(self, verdict, timeout=600, poll=3):
        """Block until a pending/scheduled intent reaches a terminal state."""
        deadline = time.time() + timeout
        current = verdict
        while time.time() < deadline:
            current = self.status(verdict.intent_id)
            if current.status not in ("pending", "scheduled", "approved"):
                if current.status == "blocked":
                    raise Blocked(current.policy, current.intent_id, current.evidence_id)
                return current
            time.sleep(poll)
        raise TimeoutError(f"intent {verdict.intent_id} still {current.status} after {timeout}s")
