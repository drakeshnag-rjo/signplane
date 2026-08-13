# Signplane Pilot Runbook — dev/tst first, prod when proven

The evaluation path an org follows from zero to enforced production. Four phases,
each with an explicit gate. Everything runs **inside the org's own environment** —
cloud credentials never leave their network; Signplane's state (SQLite + evidence
ledger) lives on their host.

## Phase 0 — Install & setup (day 1, ~1 hour)

1. **Host**: one VM or container the platform team controls. Node 18+, Python 3.10+
   with `boto3`. Copy the Signplane release; `node server.js`.
2. **Cloud scope**: give the executor an IAM role restricted to the **dev/test
   accounts only** (deny prod by policy). Set `AWS_ENDPOINT_URL` only if targeting
   an emulator; unset = real AWS via the role's credentials.
3. **Auth on**: Settings → Auth & SSO → enable, create the first admin. Add
   approvers/viewers, or connect the org's IdP dev tenant via OIDC.
4. **Environments & policies**: edit `policies.json` to match their environment
   names (`dev`, `tst`, `stg`, `prod`) and their real risk lines — which verbs, in
   which envs, need whose approval, in which windows.
5. **Register the first agent**, scoped to `dev`/`tst` **only** — prod isn't in its
   scope, so even a bug can't propose there.

*Gate: dashboard up, auth enforced, one agent registered. (PRD activation target:
first agent governed on day 1.)*

## Phase 1 — Observe-only in dev/tst (week 1)

1. Mode: **observe**. Wire one real agent or existing automation through
   `POST /api/gateway/propose` (pattern: `examples/guarded_agent.py` — ~60 lines).
2. Let it run. The dashboard fills with risk-scored proposals and *would-have*
   outcomes; nothing is gated, nothing about the agent's behavior changes.
3. Tune policies against reality: too many HIGHs that should be routine? Wrong
   window? Edit and iterate — every policy change is itself evidence-logged.
4. Connect integrations to sandboxes: Slack test channel, Jira sandbox project,
   ServiceNow dev instance. Press **Test** on each.

*Gate: a week of observed traffic, policies the platform team agrees look right,
and — usually — at least one "would have blocked" row that makes the case.*

## Phase 2 — Enforce in dev/tst (week 2)

1. Flip **enforce**. Low-risk flows auto-approve; approvals land in the dashboard
   and Slack; Jira/ServiceNow records open per pending change.
2. Run the four drills, deliberately:
   - **Block drill**: propose a destructive change → confirm 403, evidence recorded.
   - **Approval drill**: normal change → approver decides from risk + blast radius.
   - **Schedule drill**: future-dated change → make an out-of-band edit → watch the
     drift guard bounce it back for re-approval.
   - **Kill-switch drill**: suspend an agent → its next proposal is denied.
3. Optional but recommended: apply **credential starvation** in the dev OU — an SCP
   denying writes except from the Signplane broker role. Proves the enforcement
   story cloud-side before prod ever sees it.
4. Watch the human factors: approval latency, false-positive blocks, whether
   approvers have what they need on the card to decide in under a minute.

*Gate: all four drills pass; a week of enforced dev/tst with no workflow damage;
approvers comfortable. Sign-off from platform lead + security.*

## Phase 3 — Prod, observe-only (weeks 3–4)

1. Register prod-scoped agents (or widen scope of proven ones). Mode for prod
   traffic: **observe** — zero enforcement risk, full visibility.
2. Run the **auditor test**: export the evidence pack, hand it to the compliance
   team, ask "would our auditor accept this as change-management evidence?"
3. Review the visibility gap: what changed in prod that *didn't* come through an
   agent — the baseline for reconciliation later.

*Gate: prod visibility accepted, evidence pack passes the compliance sniff test,
approver on-call rota agreed for enforcement.*

## Phase 4 — Prod enforcement (the go/no-go)

Checklist before the flip:
- [ ] Policies reviewed by security; CRITICAL lines confirmed (what must never happen)
- [ ] Approval TTLs and maintenance windows match the org's change calendar
- [ ] Approver rota covers the hours agents operate (agents don't sleep)
- [ ] Rollback scope agreed — which operations get one-click undo, which get
      "compensating action suggested, human executes"
- [ ] Failure mode chosen per environment: fail-closed (prod) vs fail-open (dev)
- [ ] Kill-switch drill re-run against a prod-scoped agent
- [ ] Backout plan: enforcement off = one mode toggle; Signplane keeps observing

Then flip **enforce** env-by-env, least-critical prod services first. Widen as
confidence grows. From here the SCP/credential-starvation rollout makes the
gateway the only path with keys.

## Success metrics (from the PRD)

First agent governed ≤ 1 day · first enforced action ≤ 14 days · ≥ 1 blocked or
flagged risky change per month · evidence query < 5 minutes.
