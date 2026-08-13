# Phase 0 install — step by step (VM is ready)

Target: Ubuntu 22.04/24.04 VM inside the customer's network, outbound access to
their cloud APIs and (optionally) Slack/Jira/ServiceNow. Everything below is
copy-paste. Windows Server works too (same steps, PowerShell equivalents).

## 1 · Install runtimes (~5 min)

```bash
# Node 24 (Signplane needs >= 22.5 for built-in SQLite)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip
sudo pip3 install boto3
node --version && python3 --version && python3 -c "import boto3; print('boto3', boto3.__version__)"
```

## 2 · Install Signplane (~2 min)

```bash
sudo mkdir -p /opt/signplane && sudo chown $USER /opt/signplane
# copy the release bundle we provide (or clone the repo), then:
cd /opt/signplane && ls
# expected: server.js  lib/  executor.py  policies.json  public/  examples/  docs/
```

## 3 · Cloud credentials — dev/test scope only (~10 min, their cloud admin)

Preferred: attach an **IAM instance profile** to the VM (no keys on disk).
The role's policy allows the services agents will govern, **in the dev/test
account only**, with an explicit prod guard. Minimal example:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "GovernDevTest", "Effect": "Allow",
      "Action": ["ec2:Describe*", "ec2:RunInstances", "ec2:TerminateInstances",
                 "ec2:CreateTags", "s3:ListAllMyBuckets", "s3:CreateBucket", "s3:DeleteBucket"],
      "Resource": "*" },
    { "Sid": "NeverProd", "Effect": "Deny", "Action": "*",
      "Resource": "*", "Condition": { "StringEquals": { "aws:ResourceAccount": "<PROD_ACCOUNT_ID>" } } }
  ]
}
```

(Alternative: `aws configure` with an access key for the same role — the executor
uses boto3's standard credential chain either way.)

## 4 · Configure and start the service (~5 min)

```bash
sudo tee /etc/systemd/system/signplane.service > /dev/null <<'EOF'
[Unit]
Description=Signplane control plane
After=network-online.target

[Service]
WorkingDirectory=/opt/signplane
Environment=PORT=4820
Environment=AWS_ENDPOINT_URL=aws
Environment=AWS_REGION=us-east-1
ExecStart=/usr/bin/node server.js
Restart=always
User=signplane
DynamicUser=yes
StateDirectory=signplane

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now signplane
curl -s localhost:4820/api/summary | head -c 300   # expect JSON with "mode": "observe"
```

Notes:
- `AWS_ENDPOINT_URL=aws` = real AWS default endpoints. Point it at an emulator URL
  instead if this pilot starts against moto/Floci/LocalStack.
- Expose the dashboard to the team via their standard reverse proxy (nginx/Caddy)
  with TLS; keep 4820 off the public internet.

## 5 · First-boot security (~5 min, in the browser)

1. Open `https://<vm>/` → dashboard loads in demo mode.
2. **⚙ Settings → Auth & SSO → Turn auth ON** → create the first admin.
   Reload → login screen is now enforced.
3. Add approvers and viewers (Settings → Users), or configure **OIDC** (issuer,
   client id/secret from their IdP) so the team signs in with SSO.

## 6 · Fit policies to their environments (~10 min)

Edit `/opt/signplane/policies.json`: rename environments to theirs
(`dev`, `tst`, `stg`, `prod`), set the CRITICAL "never" lines, the approval roles,
TTLs, and maintenance windows. Then `sudo systemctl restart signplane`.
The **⛨ Policy gate** panel shows the result — walk it with their platform lead.

## 7 · Register the first agent (~2 min)

With auth on, registration needs an admin session:

```bash
# login, keep the session cookie
curl -s -c /tmp/sp.jar -X POST localhost:4820/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@customer.io","password":"<password>"}'

# register, scoped to dev/tst ONLY — prod is structurally out of reach
curl -s -b /tmp/sp.jar -X POST localhost:4820/api/agents/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"their-first-agent","owner":"platform@customer.io",
       "model":"claude-sonnet-5","environments":["dev","tst"]}'
# → save the returned id + token: that pair goes to the agent's runtime secret store
```

## 8 · Validate (~5 min)

```bash
# the 60-line reference agent exercises the whole loop
python3 examples/guarded_agent.py
# expect: read → executed · destructive delete → blocked

curl -s localhost:4820/api/evidence/verify    # {"valid": true, ...}
```

Phase 0 exit checklist:
- [ ] `systemctl status signplane` active; survives a VM reboot
- [ ] Auth ON, admin + approvers exist (or SSO working)
- [ ] Policies renamed to their environments, reviewed on the Policy gate panel
- [ ] First agent registered, scoped to dev/tst
- [ ] Validation script: one executed, one blocked, chain verified
- [ ] Dashboard reachable for the team over TLS

→ Continue with Phase 1 (observe-only) in [pilot-runbook.md](pilot-runbook.md).
