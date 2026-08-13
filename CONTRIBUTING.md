# Contributing to Signplane

Thanks for helping make AI agents safe to run against real infrastructure.

## Ground rules

- **License**: Signplane is AGPL-3.0. By contributing you agree your changes are
  licensed the same way. We use the [Developer Certificate of Origin](https://developercertificate.org/) —
  sign your commits with `git commit -s`.
- **Zero-dependency discipline**: the server runs on Node built-ins only (the
  broker uses Python + boto3). PRs adding npm dependencies need a very good
  reason — small, auditable code is a product feature here.
- **Tests are the contract**: `node --test "test/*.test.js"` must stay green.
  New connectors and policy features come with tests against local mocks (see
  `test/integrations.test.js` and `test/auth.test.js` for the pattern — mock IdP,
  mock Jira/ServiceNow, no external calls in CI).

## Good first contributions

- New integration connectors (Teams, PagerDuty, Datadog Events) — follow the
  connector shape in `lib/integrations.js`: `configFields`, `events`, `send`, `test`.
- Policy engine matchers (tags, resource patterns, cost thresholds).
- Cloud coverage in `executor.py` (more services, more rollback plans — a rollback
  plan must be *provably safe* or it doesn't ship).
- Docs and translations of the install guide.

## What stays out of the open repo

The hosted-cloud billing/portal code and customer configurations. Everything the
product *does* — gateway, policy, evidence, SSO, RBAC, integrations — is here,
open, with no open-core feature gates.

## Security issues

Please don't open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
