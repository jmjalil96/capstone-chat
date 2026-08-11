# Capstone Chat operations

These runbooks operate the approved provisional Phase 8 topology: one USD 6 DigitalOcean Basic
shared-CPU Droplet with one vCPU and 1 GiB RAM in RIC1, one encrypted 1 GiB Volume, and one USD 5
PlanetScale Postgres PS-5 ARM Single Node cluster in AWS `us-east-1`. Caddy exposes one origin;
exactly one application slot is active for new traffic. PostgreSQL uses a fixed-source public route
restricted to the Droplet `/32` and protected by `verify-full` TLS.

Run commands from the repository root at the exact deployed revision, or through the audited host
entry point identified by the DigitalOcean deployment artifacts. Replace angle-bracket placeholders
locally. Never paste credentials, employee content, provider payloads, raw URLs, or token-bearing
identity links into an issue, task, shell argument, log, screenshot, or committed evidence file.

Repository implementation is authorized. DigitalOcean, PlanetScale, GitHub Packages, DNS, Resend,
New Relic, OpenRouter, paid rehearsal, inference, production deployment, and PITR resource actions
remain separately authorized external changes. A runbook describes the procedure; it does not grant
permission to execute it.

## Ownership and recovery

Bitwarden Teams in the Capstone organization is the recoverable source for production credentials.
The `Production` collection has one company-controlled owner with MFA and a sealed offline recovery
kit stored away from the operator's computer and phone. The second recovery owner is explicitly
deferred. Treat that as a visible single-person launch risk and never claim two-owner recovery until
an independent second company account has tested access.

DigitalOcean, PlanetScale, GitHub, DNS, New Relic, Resend, OpenRouter, Bitwarden, and the
administrator mailbox must use company-controlled ownership and MFA where supported. Keep a
content-free UTC change record outside the repository for every external mutation. The operator
must be able to recover Bitwarden and rebuild a fresh encrypted Volume within the four-hour RTO.

## Routine inspection

Inspect the following before and after each deploy, daily during launch week, and weekly thereafter:

- DigitalOcean CPU/load, RAM, disk, network, restarts, firewall, reserved-IP routing, TLS/readiness,
  security-update state, and Volume attachment;
- PlanetScale CPU/RAM, connections, locks, I/O, storage, WAL, backup schedule, oldest selectable
  PITR point, Query Insights, roles, and database-wide IP restrictions;
- New Relic application readiness/5xx/latency, response-start, generation outcomes, budgets,
  reconciliation, pool waiting, Resend categories, and Fluent Bit/OTLP delivery; and
- GHCR current/previous protected digests, CI result, Bitwarden seat count, live cost estimates,
  and provider billing alerts.

PlanetScale storage warns before 60% and requires operator action before the provider's 70% growth
threshold; the source-controlled ceiling is 15 GB. Resource exhaustion triggers an explicit
source-controlled sizing decision, not an automatic resize, new service, or relaxed gate.

## Runbooks

- [Provision and deploy](./provision-and-deploy.md)
- [Deploy and rollback](./deploy-and-rollback.md)
- [Incident response](./incident-response.md)
- [Database recovery](./database-recovery.md)
- [Providers and budget](./providers-and-budget.md)
- [Secret rotation](./secret-rotation.md)
- [Employee access](./employee-access.md)
- [Domain and TLS](./domain-and-tls.md)

The provider-specific host files and their installation/verification contract live in
`deploy/digitalocean/`. Historical Render plans remain evidence only and are not operator
instructions.

## Evidence rules

Record UTC timestamps, full deployment revision, immutable image digest, migration number, safe
outcome, duration, provider sizes/regions, and operator. Before attaching output, scan it for email
addresses, cookies, authorization headers, database URLs, IPs not required by the evidence contract,
prompts, responses, summaries, searches, titles, drafts, provider bodies, raw model identifiers, and
identity-action URLs.

Stop if a step would change the locked privacy, security, cost, retention, model, availability, or
recovery policy. Do not improvise a second service, queue, cache, worker, public application port,
open database rule, proxy/CDN, alternate provider, automatic resize, or secret on the Droplet's
unencrypted root disk.
