# Security Policy

Signplane is a security-relevant product: it gates changes to production
infrastructure and produces audit evidence. We treat vulnerability reports with
corresponding seriousness.

## Reporting a vulnerability

Email **security@signplane.com** (PGP key on signplane.com/security). Please do
not open public GitHub issues for suspected vulnerabilities.

We aim to acknowledge within 48 hours and to ship a fix or mitigation for
confirmed issues within 14 days. Reporters are credited in release notes unless
they prefer otherwise.

## Scope of interest

Especially: evidence-ledger integrity (hash-chain forgery or silent mutation),
authentication/RBAC bypass, OIDC verification flaws, agent-token handling,
policy-engine bypass (a proposal executing without matching policy outcome), and
executor privilege issues.

## Supported versions

The latest minor release receives security fixes. Self-hosted deployments should
track releases; the bundle's `CHECKSUMS.txt` and release SHA-256 allow supply-chain
verification.
