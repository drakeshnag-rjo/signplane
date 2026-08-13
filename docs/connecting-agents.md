# Connecting AI Agents to Signplane

## The model

An agent never calls your cloud directly. Instead it **proposes** the change to the
gateway and acts on the verdict:

```
Agent decides "scale the node pool"
   │
   ▼
POST /api/gateway/propose          (authenticated with agent_id + agent_token)
   │
   ├─ 200 executed   → Signplane executed it (low-risk auto-approve); result inside
   ├─ 202 pending    → a human is deciding; poll GET /api/intents/{id}
   ├─ 202 scheduled  → approved for a future window; Signplane releases it after re-validation
   └─ 403 blocked    → policy or identity said no; the cloud never saw it
```

Two execution styles, both supported today:

- **Broker mode (recommended):** the proposal carries the exact cloud call
  (`action.aws = {service, operation, params}`). On approval, **Signplane executes
  it** through the execution broker, captures pre/post state snapshots, and stores
  the compensating rollback action. The agent never holds cloud credentials.
- **Observe mode (pilot entry):** the gateway logs, risk-scores, and evidences the
  proposal but the response says `enforced: false` — the agent proceeds on its own.
  Zero behavior change; full visibility. This is how every pilot starts.

## 1. Register the agent (once, by an admin)

```bash
curl -X POST http://localhost:4820/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name":"cost-optimizer","owner":"priya@corp.io","model":"claude-sonnet-5","environments":["staging","prod"]}'
```

The response contains `id` and `token` — that pair **is** the agent's identity.
Scope it to the environments it may touch; suspend it any time
(`PATCH /api/agents/{id} {"status":"suspended"}`) and its next proposal is denied.

## 2. Guard the agent's actions

Minimal Python client (see `examples/guarded_agent.py` for the runnable version):

```python
import requests

class Signplane:
    def __init__(self, base, agent_id, token):
        self.base, self.id, self.token = base, agent_id, token

    def propose(self, intent, environment, action, schedule=None):
        r = requests.post(f"{self.base}/api/gateway/propose", json={
            "agent_id": self.id, "agent_token": self.token,
            "intent": intent, "environment": environment,
            "action": action, "schedule": schedule,
        })
        return r.status_code, r.json()

sp = Signplane("http://localhost:4820", AGENT_ID, AGENT_TOKEN)

code, verdict = sp.propose(
    intent="Scale prod batch workers; queue depth > 10k",
    environment="prod",
    action={
        "tool": "aws", "verb": "write", "resource": "ec2/run-instances",
        "resources_touched": ["ec2:batch-worker x2"], "cost_delta_usd_month": 15,
        "aws": {"service": "ec2", "operation": "run_instances",
                "params": {"ImageId": "ami-12c6146b", "InstanceType": "t3.micro",
                           "MinCount": 2, "MaxCount": 2}},
    },
)

if code == 200:   ...  # executed — verdict["evidence_id"] is your receipt
elif code == 202: ...  # pending/scheduled — poll /api/intents/{verdict["intent_id"]}
elif code == 403: ...  # blocked — log it, move on; the attempt is already in evidence
```

### Wiring it into an agent framework

Wherever your agent framework defines its infrastructure *tools* (an MCP tool, a
LangChain tool, a function the LLM calls), replace the body that would call
boto3/kubectl with a `sp.propose(...)` call. The LLM's stated reason becomes the
`intent` string — that's what approvers and auditors read. One tool wrapper
typically covers every action the agent can take.

## 3. What each field buys you

| Field | Who consumes it |
|---|---|
| `intent` (plain English) | The approver's Slack/Jira card and the auditor's evidence pack |
| `action.verb` + `resource` | Policy matching (read/write/delete × environment × window) |
| `resources_touched`, `cost_delta_usd_month` | Blast-radius display on the approval card |
| `action.aws` | Broker execution + snapshots + automatic rollback plan |
| `schedule.not_before` | Change-window scheduling with drift re-validation at release |

## Enforcing adoption — how orgs make Signplane non-optional

Developers bypass optional gates. Enforcement lives in layers no agent code can route around:

1. **Credential starvation (works today, broker mode).** No agent holds cloud write
   credentials — the Signplane broker owns the only IAM role that can mutate prod,
   enforced by an AWS SCP / Azure deny assignment. A direct `boto3` write returns
   `AccessDenied`; the gateway is the only door that opens.
2. **Platform chokepoints (roadmap).** K8s admission webhook (cluster rejects
   mutations without a Signplane approval token), CI/CD required check (apply creds
   exist only in the runner), MCP proxy (interception in transit).
3. **Bypass detection.** Reconcile CloudTrail against the evidence ledger — any
   cloud mutation without a matching intent is flagged as an out-of-band change.
   Same machinery as the drift guard, pointed at audit logs.
4. **The paved road.** A one-line SDK, golden agent templates, and the developer's
   real incentive: when a governed change goes wrong, the approval chain shows who
   signed off — the developer doesn't own the blame.

> One-liner: "You don't force the developer — you force the credentials."

## Interception roadmap (no agent code changes)

For agents you can't modify, the PRD's transparent interception points are the
roadmap: an **MCP proxy** (point the agent's MCP config at Signplane; tool calls
are intercepted in flight), a **Terraform plan hook** (plans become proposals),
and a **Kubernetes admission webhook** (catches anything reaching the cluster,
whatever produced it). Today's HTTP gateway is the contract all three will feed.
