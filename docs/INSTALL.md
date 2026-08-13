# Signplane — Self-Service Installation Guide

This guide assumes **you are installing Signplane yourselves, with no vendor
access to your systems**. That is the intended deployment model, not a
compromise: Signplane runs entirely inside your network, on a host you control.

## What this software does and does not do

- Runs as a single local service (Node.js) with a Python execution broker.
- Stores all state locally: a SQLite database and an append-only evidence ledger,
  both in the `data/` directory on your host. Nothing is sent to Signplane the
  company. **There is no telemetry, no license check, no phone-home.**
- Makes outbound connections only to endpoints **you configure**: your cloud API,
  and optionally your Slack/Jira/ServiceNow/SIEM.
- Needs no inbound access from the internet. The dashboard is for your team,
  behind your own proxy/VPN.

You can verify all of this: the codebase is small (~2,500 lines, no npm
dependencies), and `CHECKSUMS.txt` lists a SHA-256 for every file in this bundle.

## Choose your track

| | Track A — Sandbox | Track B — Dev/test pilot |
|---|---|---|
| Cloud credentials needed | **None** | Dev/test-scoped IAM role |
| Touches your infrastructure | **No** — local AWS emulator | Dev/test accounts only |
| Time | ~30 minutes | ~1 hour |
| Good for | Seeing the full product safely | Real evaluation with your agents |

---

## Track A — Sandbox evaluation (no cloud access at all)

Everything runs on one VM or laptop against a local AWS emulator. Signplane
never touches your real cloud.

```bash
# 1. Runtimes: Node >= 22.5 and Python 3.10+
node --version   # install Node 24 LTS if missing
python3 --version

# 2. Emulator + broker library
pip3 install "moto[server]" boto3

# 3. Start the local "AWS" (terminal 1)
python3 -m moto.server -p 5000

# 4. Start Signplane (terminal 2, from the bundle directory)
node server.js
# → dashboard at http://localhost:4820
```

Now exercise the whole governance loop with the included demo traffic:

```bash
node demo-agent-aws.js          # 4 proposals: auto-approve, 2 approvals, 1 block
```

In the dashboard: switch to **ENFORCE**, re-run the demo, approve the pending
changes (real instances launch — in the emulator), click **↩ Roll back**, export
the evidence pack, and try the tamper test: edit one character in
`data/evidence.jsonl` and watch the chain flip to BROKEN. `demo-agent-scheduled.js`
demonstrates scheduled changes and the drift guard.

When the product has made its case, move to Track B.

---

## Track B — Dev/test pilot (your cloud, your rules)

### B1 · Host and runtimes

Ubuntu 22.04/24.04 (or Windows Server) VM inside your network:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip
sudo pip3 install boto3
```

Unpack this bundle to `/opt/signplane`.

### B2 · Credentials — scoped by *you*

Attach an IAM instance profile to the VM (preferred — no keys on disk). Scope it
yourself: allow only the services you want governed, **only in dev/test
accounts**, and add an explicit Deny for your production account. A sample
policy is in `docs/install-phase0.md`. Signplane can only do what this role
allows — that boundary is enforced by your cloud, not by our code.

### B3 · Run as a service

Use the systemd unit in `docs/install-phase0.md` §4. The two environment
variables that matter:

```
AWS_ENDPOINT_URL=aws       # real AWS endpoints (or an emulator URL)
AWS_REGION=<your region>
```

Put the dashboard behind your reverse proxy with TLS. Keep port 4820 internal.

### B4 · Lock it down (5 minutes, in the browser)

Settings → **Auth & SSO → Turn auth ON** → create your admin. Add approvers and
viewers, or point OIDC at your IdP (issuer + client id/secret). From this moment
every dashboard action requires a signed-in user with the right role, and every
approval is stamped with the approver's identity from their session.

### B5 · Make the policies yours

Edit `policies.json`: your environment names, your "never" lines (CRITICAL
blocks), who approves what, approval TTLs, maintenance windows. Restart the
service. The **⛨ Policy gate** panel shows the live rule set — review it with
your security team before enforcing anything.

### B6 · Register your first agent

```bash
curl -s -c /tmp/sp.jar -X POST localhost:4820/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"<admin>","password":"<pw>"}'
curl -s -b /tmp/sp.jar -X POST localhost:4820/api/agents/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"first-agent","owner":"platform@you.io","environments":["dev","tst"]}'
```

Store the returned `id` + `token` in your secret manager; wire your agent
through the gateway using `examples/guarded_agent.py` as the template (~60
lines, any language with HTTP). Full integration guide:
`docs/connecting-agents.md`.

### B7 · Validate, then follow the runbook

```bash
python3 examples/guarded_agent.py            # one executed, one blocked
curl -s localhost:4820/api/evidence/verify   # {"valid": true}
```

From here, `docs/pilot-runbook.md` takes you through observe-only → enforced
dev/test → prod observe → prod enforcement, with a gate at each step.

---

## Operations

- **Backup**: copy the `data/` directory (SQLite DB + evidence ledger).
- **Upgrade**: replace the code files, keep `data/` and `policies.json`, restart.
- **Uninstall**: stop the service, delete the directory. No registry entries, no
  system hooks, nothing else to clean.
- **Getting help without granting access**: if you want support, you choose what
  to share — typically the evidence export (JSON you can read line by line) or
  service logs. Screen-share works too. We never need credentials or inbound
  access to assist.
