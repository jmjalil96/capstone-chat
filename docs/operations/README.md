# Capstone Chat operations

These runbooks describe the one active provisional Phase 8 path: one DigitalOcean App Platform
dynamic service in managed region `ric`, one `PRE_DEPLOY` migration job, Dedicated Egress, and one
PlanetScale Postgres PS-5 ARM Single Node cluster in AWS `us-east-1`. App Platform owns ingress,
managed TLS, readiness-gated rolling replacement, and the Cloudflare-backed edge. PlanetScale
accepts direct `verify-full` port-5432 connections only from both exclusive egress IPv4 `/32`s and
the exact role being used.

The service candidate is `apps-s-1vcpu-1gb-fixed`, one instance, with no autoscaling or scale to
zero. The migration job is `apps-s-1vcpu-0.5gb` and exists only as a deployment phase. App Platform
and PlanetScale remain unaccepted until every managed network, privacy, load, stream, deployment,
and recovery gate passes. Earlier Render and raw-Droplet plans remain historical evidence only;
their commands are not an operator fallback.

Run repository commands from the exact reviewed revision. Run provider mutations only through the
source-controlled App Platform workflow or its named, separately authorized operator entry point.
Never paste credentials, employee content, provider payloads, secret-bearing App specs, raw URLs,
or identity-action links into a task, shell argument, log, screenshot, CI artifact, or evidence
file.

Repository implementation does not authorize a managed rehearsal or production action. Creating or
deleting an App, egress pair, database branch, role, domain, Uptime check, credential, backup, or
other paid resource requires a fresh grant naming target, maximum spend, lifetime, data class, and
cleanup scope. Production DNS, credentials/data, deployment, email, paid inference, and PITR
cutover remain separately gated.

## Ownership and recovery

Bitwarden Teams in the Capstone organization is the recoverable source for production credentials.
The `Production` collection has one company-controlled owner with MFA and a sealed offline recovery
kit stored away from the operator's computer and phone. The second recovery owner is explicitly
deferred. Treat that as a visible single-person launch risk and never claim two-owner recovery until
an independent second company account has tested access.

DigitalOcean, PlanetScale, GitHub, DNS, New Relic, Resend, OpenRouter, Bitwarden, and the
administrator mailbox must use company-controlled ownership and MFA where supported. Keep Capstone
in a dedicated DigitalOcean team containing no unrelated App because the steady deploy token is
team-scoped. Keep a content-free UTC change record outside the repository for every external
mutation. The operator must be able to recover Bitwarden, exact GHCR digests, the non-secret App
contract, and PlanetScale recovery material within the four-hour controlled-recovery RTO.

## Routine inspection

Inspect the following before and after each deploy, daily during launch week, and weekly thereafter:

- App Platform deployment, pre-deploy job, domain, readiness, CPU, memory, restart, request,
  latency, egress-pair, and encrypted-variable contract, plus the independent Uptime check;
- PlanetScale CPU/RAM, connections, locks, I/O, storage, WAL, backup schedule, oldest selectable
  PITR point, Query Insights, roles, and database-wide IP restrictions;
- New Relic application readiness/5xx/latency, response-start, generation outcomes, budgets,
  reconciliation, pool waiting, Resend categories, OTLP delivery, and bounded direct-log-mirror
  delivery/drop counts; and
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

The active provider contract and mutation tools live in `deploy/app-platform/`. The digest-free
contracts contain no credential, encrypted provider value, or release placeholder. Historical
Render and Droplet records remain in `docs/implementation/` and Git history only.

## Evidence rules

Record UTC timestamps, full deployment revision, immutable image digest, migration number, safe
outcome, duration, provider sizes/regions, and operator. Before attaching output, scan it for email
addresses, cookies, authorization headers, database URLs, IPs not required by the evidence contract,
prompts, responses, summaries, searches, titles, drafts, provider bodies, raw model identifiers, and
identity-action URLs.

Stop if a step would change the locked privacy, security, cost, retention, model, availability, or
recovery policy. Do not improvise a second steady service, queue, cache, worker, open database rule,
VPC, Volume, alternate edge/provider, automatic resize, native rollback, or unreviewed control-panel
App-spec edit. App Platform's managed Cloudflare edge is an accepted conditional processor only
after the separate DPA/subprocessor/region/log-retention/access/deletion/breach gate succeeds.
