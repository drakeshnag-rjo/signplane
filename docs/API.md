# Signplane API Reference

Base URL: `http://<host>:4820`. All bodies are JSON. Roles: **admin** > **approver** > **viewer**.
With `auth_mode: off` (default, demo) every request acts as an implicit admin; with
`auth_mode: on`, dashboard/API calls need a session cookie (`signplane_session`) and the
listed role. **Agents never use sessions** — they authenticate per-call with `agent_id` + `agent_token`.

## Intent lifecycle

```
observed                    (observe mode: logged, not gated)
pending → approved → executed → rolled_back
pending → rejected
pending/scheduled → blocked (policy at proposal or at release)
approved(future) → scheduled → executed | pending (drift / TTL expiry)
executed → failed           (broker error)
```

---

## Authentication

| Method & path | Role | Body / notes |
|---|---|---|
| `GET /api/auth/me` | — | `{auth_mode, needs_setup, sso_enabled, user}` — call first; drives the login UI |
| `POST /api/auth/setup` | — | `{name, email, password}` — only while zero users exist; creates first admin + session |
| `POST /api/auth/login` | — | `{email, password}` → sets session cookie |
| `POST /api/auth/logout` | — | clears session |
| `GET /api/auth/oidc/login` | — | 302 → identity provider (requires OIDC configured) |
| `GET /api/auth/oidc/callback` | — | IdP redirect target; verifies id_token (JWKS RS256, iss/aud/exp/nonce), provisions user, sets session |

## Users (admin)

| | |
|---|---|
| `GET /api/users` | list (no password hashes) |
| `POST /api/users` | `{name, email, role, password?}` — role ∈ `admin·approver·viewer` |
| `PATCH /api/users/:id` | `{role}` |
| `DELETE /api/users/:id` | cannot delete yourself |

## Agents

| Method & path | Role | Notes |
|---|---|---|
| `POST /api/agents/register` | admin | `{name, owner, model?, environments?, expires_at?}` → response includes `token` — **the only time it is shown**; store it in your secret manager |
| `GET /api/agents` | viewer | tokens are never returned |
| `PATCH /api/agents/:id` | admin | `{status: "active" \| "suspended"}` — the kill switch; a suspended agent's next proposal is denied |

## The gateway

### `POST /api/gateway/propose` — no session; agent credentials in body

```json
{
  "agent_id": "agt_…", "agent_token": "…",
  "intent": "Scale prod batch workers; queue depth > 10k",
  "environment": "prod",
  "action": {
    "tool": "aws", "verb": "write", "resource": "ec2/run-instances",
    "resources_touched": ["ec2:batch-worker x2"],
    "cost_delta_usd_month": 15,
    "aws": { "service": "ec2", "operation": "run_instances", "params": { "MinCount": 2 } }
  },
  "schedule": { "not_before": "2026-08-16T02:00:00Z" }
}
```

- `action.verb` (`read`/`write`/`delete`) + `resource` + `environment` drive policy matching.
- `action.aws` (optional) makes execution **real**: on approval the broker runs the call,
  snapshots pre/post state, and stores a compensating rollback plan. Without it,
  execution is simulated (useful for observe-mode pilots).
- `intent` is the human-readable "why" — it's what approvers and auditors read.
- `schedule.not_before` (optional, ISO): approved changes wait and re-validate at release.

Responses:

| HTTP | Meaning | Key fields |
|---|---|---|
| `200` | executed (observe-mode log, or LOW auto-approve) | `status`, `would_have` (observe), `evidence_id` |
| `202` | `pending` (awaiting approval) or `scheduled` | `intent_id` to poll, `not_before` |
| `403` | blocked — policy or identity; **the cloud never saw it** | `reason`/`policy`, `evidence_id` |

## Intents & decisions

| Method & path | Role | Notes |
|---|---|---|
| `GET /api/intents?status=pending` | viewer | full objects, newest first |
| `GET /api/intents/:id` | viewer | poll target for agents' 202s |
| `POST /api/intents/:id/decision` | approver | `{decision: "approved"\|"rejected", comment?}` — approver identity comes from the session; approval gets a TTL (`valid_until`); future-dated intents move to `scheduled` |
| `POST /api/intents/:id/rollback` | approver | executes the stored compensating action; only when `status=executed` and `rollback=AVAILABLE` |

## Evidence

| | |
|---|---|
| `GET /api/evidence` | all ledger records, newest first |
| `GET /api/evidence/verify` | recompute the hash chain → `{valid, records, broken_at_index?}` (no auth — verification should be cheap) |
| `GET /api/evidence/export` | downloadable pack: records + chain verification + SOC 2 CC8.1 / SOX mapping |

## Policy, mode, settings

| Method & path | Role | Notes |
|---|---|---|
| `GET /api/policies` | viewer | current rule set (first match wins) |
| `PUT /api/policies` | admin | replace rule set; validated; change is evidence-logged |
| `GET /api/mode` · `POST /api/mode` | — / admin | `{mode: "observe"\|"enforce"}` — global gate switch |
| `PATCH /api/settings` | admin | `{auth_mode, first_admin?, oidc{issuer,client_id,client_secret,enabled}, base_url}` |
| `GET /api/integrations` | admin | `{kinds}` (available connectors + their config fields) and `{configured}` |
| `POST /api/integrations` | admin | `{kind, config, name?, enabled?}` — kinds: `slack`, `jira`, `servicenow`, `webhook` |
| `POST /api/integrations/:id/test` | admin | live connection test against the configured system |
| `PATCH /api/integrations/:id` · `DELETE` | admin | update config / enable / disable / remove |
| `GET /api/summary` | viewer | dashboard counters + mode + chain status |
| `GET /api/audit` | admin | last 100 audit events (logins, config changes, integration deliveries/failures) |

## Integration events

Enabled integrations receive: `intent.pending`, `intent.executed`, `intent.blocked`,
`intent.rejected`, `intent.rolled_back`, `intent.drift`, `intent.scheduled`, `mode.changed`.
Delivery is async and failure-isolated — connector errors never block the gateway; every
delivery and failure is recorded in the audit log.
