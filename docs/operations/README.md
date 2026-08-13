# Capstone Chat operations

The active provisional Phase 8 path is one DigitalOcean App Platform source-built service in
managed region `ric`, one source-built `PRE_DEPLOY` migration job, paid Dedicated Egress, and one
PlanetScale Postgres PS-5 ARM Single Node cluster in AWS `us-east-1`. App Platform owns ingress,
managed TLS, readiness-gated replacement, and its Cloudflare-backed edge. PlanetScale accepts
direct `verify-full` port-5432 connections only from both exclusive egress IPv4 `/32`s and the
exact role being used.

The service candidate is one `apps-s-1vcpu-1gb-fixed` instance; the job is
`apps-s-1vcpu-0.5gb` and exists only during deployment. The live DigitalOcean account currently
labels both slugs feature preview. The owner explicitly accepted the selected slugs' current
preview status for production on August 13, 2026; a later size change still requires a new
capacity decision and evidence on that size.

GitHub Actions validates every release. App Platform builds `apps/api/Dockerfile` from the
protected `app-platform-production` pointer with autodeploy disabled. A release is authoritative
only when service/job `source_commit_hash` and public readiness match the exact green commit.
Earlier Render, raw-Droplet, and GHCR/digest paths are historical only.

## Authority and privacy

Repository implementation never authorizes an external mutation. Creating/deleting an App,
egress pair, database branch/role, domain, Uptime check, credential, backup, or other paid resource
requires a fresh grant naming target, maximum spend, lifetime, data class, and cleanup scope.
Production DNS, credentials/data, deployment, email, paid inference, and PITR cutover remain
separately gated.

Bitwarden Teams in the Capstone organization is the recoverable secret source. One
company-controlled owner has MFA and a sealed offline kit; the deferred second owner is a visible
launch risk. DigitalOcean, PlanetScale, GitHub, DNS, New Relic, Resend, OpenRouter, Bitwarden, and
the administrator mailbox use company ownership and MFA where supported.

Never put credentials, employee content, raw provider bodies, secret-bearing App captures,
database URLs, or identity-action links in tasks, arguments, logs, screenshots, CI artifacts, or
evidence. App Platform/Cloudflare can process plaintext traffic under the owner's August 12, 2026
acceptance; do not describe the path as end-to-end encrypted to the container.

## Routine inspection

Before/after each deploy, daily during launch week, and weekly thereafter inspect:

- App Platform build/deployment/job/domain/readiness, source commit, CPU, memory, restart, request,
  latency, egress pair, encrypted-variable scope, and independent Uptime;
- PlanetScale CPU/RAM, connections, locks, I/O, storage, WAL, backup schedule, oldest PITR point,
  Query Insights, roles, and database-wide IP restrictions;
- New Relic readiness/5xx/latency, response-start, generation outcomes, budgets, reconciliation,
  pool waiting, Resend categories, OTLP, and bounded direct-log-mirror delivery/drop counts; and
- protected-main/production-pointer state, CI result, offline Git bundle, Bitwarden recovery,
  provider billing, and live cost estimates.

Storage warns before 60% and requires action before the provider's 70% growth threshold; the hard
ceiling is 15 GB. Resource exhaustion triggers an explicit sizing decision—not automatic resize,
new services, or relaxed gates.

## Runbooks

- [Provision and deploy](./provision-and-deploy.md)
- [Deploy and rollback](./deploy-and-rollback.md)
- [Incident response](./incident-response.md)
- [Database recovery](./database-recovery.md)
- [Providers and budget](./providers-and-budget.md)
- [Secret rotation](./secret-rotation.md)
- [Employee access](./employee-access.md)
- [Domain and TLS](./domain-and-tls.md)

The four non-secret contracts and read-only validator live in `deploy/app-platform/`. The operator
must preserve exact protected Git commits, the source-controlled Dockerfile/contracts, an encrypted
offline Git bundle, Bitwarden, and PlanetScale recovery material within the four-hour controlled
recovery target.

Evidence contains UTC timestamps, full source revision, deployment/build IDs, migration number,
safe outcome, duration, provider sizes/regions, and operator role only. Stop if any step would
change locked privacy, security, cost, retention, model, availability, or recovery policy.
