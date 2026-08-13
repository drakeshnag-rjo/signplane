# Signplane Configuration Reference

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4820` | HTTP port for the dashboard + API |
| `AWS_ENDPOINT_URL` | `http://localhost:5000` | Cloud API target: an emulator URL (moto/Floci/LocalStack), or the sentinel **`aws`** for real AWS default endpoints |
| `AWS_REGION` | `us-east-1` | Region for broker calls |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | Optional. If unset and targeting real AWS, boto3's standard chain applies (shared config, **IAM instance profile** — recommended) |
| `SIGNPLANE_DATA_DIR` | `./data` | Where all state lives |

## Multi-cloud provider credentials

The broker resolves credentials per provider — all standard chains, nothing Signplane-specific:

| Provider | Setup | Env |
|---|---|---|
| **AWS** | emulator (no creds), env keys, or IAM instance profile | `AWS_ENDPOINT_URL`, `AWS_REGION` |
| **Azure** | `pip install azure-identity azure-mgmt-compute azure-mgmt-network azure-mgmt-storage azure-mgmt-resource`; then `az login` (or managed identity / env service principal) | `AZURE_SUBSCRIPTION_ID` (required) |
| **GCP** | `pip install google-api-python-client google-auth`; then `gcloud auth application-default login` (or a service-account key via `GOOGLE_APPLICATION_CREDENTIALS`) | `GOOGLE_CLOUD_PROJECT` (default project) |

Scope the identities you hand the broker exactly as you would any operator: dev/test subscriptions
and projects first, production denied until Phase 4 of the [pilot runbook](pilot-runbook.md).

## Data files (everything Signplane stores)

| File | Contents |
|---|---|
| `data/signplane.db` | SQLite: users, sessions, agents, intents, integrations, settings, audit events |
| `data/evidence.jsonl` | The evidence ledger — append-only JSON lines, each record hash-chained to the previous. Deliberately a flat file: independently readable, verifiable, and backupable |

**Backup** = copy `data/`. **Uninstall** = delete the directory. Nothing else is written anywhere.

## policies.json

An ordered array — **first matching rule wins, top to bottom**. Ships with safe defaults; edit to your environments and restart.

```jsonc
{
  "id": "pol-maintenance-window",                  // stable id, appears in evidence
  "name": "Prod writes inside the window need only team approval",
  "match": {
    "environment": "prod",                          // omit = any environment
    "verbs": ["write"],                             // read | write | delete; omit = any
    "resource_pattern": "^ec2/",                    // optional regex on action.resource
    "window": {                                     // optional change window (server-local time)
      "days": ["sat", "sun"],                       // omit = every day
      "start": "02:00", "end": "06:00"              // supports overnight ranges (e.g. 22:00–04:00)
    }
  },
  "risk": "MEDIUM",                                 // LOW | MEDIUM | HIGH | CRITICAL (display + routing)
  "action": "approve",                              // allow | approve | block
  "required_role": "team",                          // label shown to approvers (approve only)
  "approval_ttl_minutes": 240                       // how long an approval stays valid (default 240)
}
```

Anything matching **no** rule requires team approval at MEDIUM — the default is human review, not silence. Policy updates via `PUT /api/policies` are themselves evidence-logged.

## Authentication modes

| `auth_mode` | Behavior |
|---|---|
| `off` (default) | Demo mode: every request acts as an implicit admin. For evaluation only. |
| `on` | Sessions + RBAC enforced. First run shows a create-admin screen (or `POST /api/auth/setup`). |

Roles: **viewer** (read everything) → **approver** (+ decide and roll back) → **admin** (+ users, agents, policies, mode, integrations, settings). Agents are unaffected by `auth_mode` — they always authenticate with their own token, and approval identity always comes from the approver's session.

### OIDC SSO

Settings → Auth & SSO (or `PATCH /api/settings`): `{ "oidc": { "issuer", "client_id", "client_secret", "enabled": true } }`.
Standard authorization-code flow with discovery, JWKS RS256 verification, and nonce/state checks. Redirect URI to register at your IdP: `<base_url>/api/auth/oidc/callback`. Works with Okta, Azure AD / Entra, Google, Auth0. First-ever user becomes admin; later SSO users join as viewers until promoted.

## Integration connector configs

| Kind | Config fields | What it does |
|---|---|---|
| `slack` | `webhook_url` | Approval/blocked/drift/rollback cards via incoming webhook |
| `jira` | `base_url`, `email`, `api_token`, `project_key`, `issue_type?` | Issue per pending approval; outcome commented on the same issue |
| `servicenow` | `instance_url`, `username`, `password` | `change_request` per pending approval (risk-mapped), closed with notes on the outcome |
| `webhook` | `url`, `auth_header?`, `auth_value?` | Every governance event as JSON — Splunk HEC, Datadog, or any sink |

Each configured integration has a **Test** button (`POST /api/integrations/:id/test`) that performs a real call against the target system.

## Running behind a proxy

Serve the dashboard via your reverse proxy with TLS and set `base_url` in settings
(`PATCH /api/settings {"base_url": "https://signplane.internal.example.com"}`) so links in
Slack/Jira notifications and the OIDC redirect are correct. Keep the port off the public internet.
