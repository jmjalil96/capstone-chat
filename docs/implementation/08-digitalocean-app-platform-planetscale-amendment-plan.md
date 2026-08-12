# Phase 8 Amendment — DigitalOcean App Platform and PlanetScale PostgreSQL Baseline

Status: amendment approved and repository implementation authorized on 2026-08-11; repository
implementation is complete and independently reviewed; the bounded disposable managed rehearsal
was authorized on 2026-08-12 and is in progress; candidate acceptance and every external
production action remain unauthorized

External authorization: one temporary `ric` App Platform App with Dedicated Egress, one temporary
PlanetScale PS-5 database in `us-east`, `rehearsal.chat.capstone.com.ec`, fake model behavior,
disabled email, synthetic `.test` identities, content-free telemetry, and an external load
generator, with at most USD 20 of provider usage, a maximum ten-day lifetime, and mandatory
cleanup. Production DNS/data/identity, Resend, paid OpenRouter inference, candidate acceptance,
production provisioning, and destructive cleanup remain unauthorized. The first bootstrap attempt
against revision `c67600b4b577d56f9c826ce335eee2b3d4e2df0d` failed before App creation because
DigitalOcean omitted the empty `apps` collection from a valid zero-total response; no App or other
provider resource was created. A corrected revision/digest requires renewed exact-artifact
authority before retry.

### Provider and authorization record — 2026-08-12

- The owner accepted the current USD 44 operational baseline before taxes, variable overage,
  temporary rehearsal resources, and separately capped model use. The live DigitalOcean account
  exposed `ric`, `apps-s-1vcpu-1gb-fixed` at USD 10/month, and
  `apps-s-1vcpu-0.5gb` at USD 5/month. PlanetScale `us-east` and PS-5 remain live creation gates.
- The owner accepted DigitalOcean App Platform and its Cloudflare-backed edge as content-bearing
  processors, including the documented residual uncertainty around internal edge-log retention and
  employee access. This is not end-to-end encryption to the container.
- The owner retained the four-hour controlled-recovery RTO and approved a best-effort maximum
  24-hour exception only for accidental App deletion while its custom domain remains attached.
- The owner reported that the abandoned Droplet project contained no remaining resource. The
  scoped DigitalOcean provisioning token can create/read/update Apps and read regions, sizes, and
  actions, but cannot delete an App or access its console. A distinct seven-day GitHub credential
  grants only `read:packages` for the private GHCR pull.
- The bounded managed rehearsal authorization permits at most USD 20 of provider usage for ten
  days and requires cleanup. Production authority remains unchanged.

## Planning record

This amendment responds to the user's explicit 2026-08-11 choice to stop treating a raw
DigitalOcean Droplet as the preferred production path and instead plan:

- one DigitalOcean App Platform dynamic service;
- one steady DigitalOcean App Platform `PRE_DEPLOY` migration job plus one temporary first-run
  initialization job;
- App Platform-managed ingress, TLS, health routing, and rolling replacement;
- the paid App Platform Dedicated Egress feature; and
- the already selected PlanetScale Postgres PS-5 Single Node database.

The choice follows a disposable Droplet rehearsal that proved the source-IP mismatch was
diagnosable but also demonstrated the operating burden of synchronizing cloud firewall rules,
UFW, SSH, systemd socket activation, Caddy, Docker, a reserved address, and recovery-console
access. App Platform is selected to remove that host-operating boundary, not because the
application or PlanetScale failed.

The repository baseline for this plan is the clean tree at commit
`4172169833f23d88b1f10a56f6a032251ac83945` on 2026-08-11. The accepted Phase 8 implementation,
Minimal Render amendment, and DigitalOcean Droplet/PlanetScale amendment remain historically
accurate. Their measurements and implementation records must not be rewritten or relabeled as App
Platform evidence.

The existing Droplet candidate is not silently promoted, repurposed, or destroyed by this plan.
Its NYC3 authorization was action-specific and does not transfer to App Platform. If this plan is
approved, repository implementation and external cleanup remain separate grants.

## Authority and amendment semantics

Read this document with:

- `AGENTS.md`;
- `docs/prd/README.md` and all six locked PRDs;
- the accepted Phase 1–8 implementation records;
- the Minimal Render and DigitalOcean Droplet amendments as historical evidence;
- the current production image, migrations, CI workflow, load harness, operations audit, and
  runbooks; and
- the current official DigitalOcean App Platform and PlanetScale contracts linked below.

If approved, this amendment supersedes only the following active Phase 8 choices:

| Active Droplet choice | Proposed App Platform replacement |
|---|---|
| One DigitalOcean Basic Droplet in RIC1 | One App Platform dynamic service in the `ric` App Platform region |
| One shared vCPU / 1 GiB Droplet plus host services | One `apps-s-1vcpu-1gb-fixed` service container, one instance, no autoscaling or scale-to-zero |
| Reserved IPv4 used for ingress and one outbound `/32` | App Platform managed ingress plus both exclusive IPv4 addresses assigned by Dedicated Egress |
| PlanetScale permits the Droplet `/32` | PlanetScale permits exactly the two App Platform egress `/32`s for the application and migration roles |
| Cloud Firewall, UFW, and SSH operator boundary | No public SSH or host firewall; App Platform exposes only the managed HTTP service |
| Host Docker container with read-only rootfs, dropped capabilities, `no-new-privileges`, PID limit, and systemd confinement | App Platform-managed gVisor sandbox with no host controls exposed, non-root UID 1000, and an ephemeral writable filesystem that carries no authoritative state |
| Caddy terminates TLS and proxies to a loopback slot | App Platform/Cloudflare terminates public TLS and forwards to one container on `0.0.0.0:3000` |
| Capstone-controlled Caddy is the only content-bearing TLS edge | DigitalOcean App Platform and its Cloudflare-backed edge become approved content-bearing processors for prompts, responses, cookies, and identity links under the owner's August 12, 2026 privacy-boundary acceptance |
| Caddy overwrites `X-Capstone-Client-IP` | App Platform supplies `do-connecting-ip`; Fastify validates that exact header in a provider-specific mode |
| Root-owned secret files on an encrypted Volume | Component-scoped App Platform encrypted `SECRET` environment variables; Bitwarden remains the recoverable source |
| Vendor-neutral deployment contract | Portable OCI/application/PostgreSQL boundaries plus one intentionally provider-specific App Platform operations adapter and runtime ingress/secret mode |
| One direct migration container invoked by the host operator | One 512 MiB `PRE_DEPLOY` job using the exact release image and only the migration credential |
| Same-host blue/green slots and an atomic Caddy switch | App Platform readiness-gated rolling replacement with explicit drain and termination grace |
| Host Fluent Bit forwards application logs | One bounded in-process HTTPS mirror forwards allowlisted content-free Pino records to New Relic; App Platform retains live/crash stdout visibility |
| DigitalOcean Monitoring owns host signals | App Platform Insights/alerts own deploy, domain, job, CPU, memory, restart, request, and latency signals; one DigitalOcean Uptime check independently owns public readiness/TLS/latency |
| Cold Droplet rebuild and reserved-IP reassignment | Exact app-spec recreation, immutable-image deployment, fresh dedicated-egress allocation, and PlanetScale allowlist replacement |
| DNS-only `A` record to the reserved IPv4 | DNS-only custom-domain mapping to App Platform managed ingress, with `chat.capstone.com.ec` primary and the starter domain redirected |
| USD 11.10 infrastructure / USD 15.10 operational base | USD 40–41 infrastructure / USD 44–45 operational base before variable items |
| Source-controlled Droplet/Caddy/systemd artifacts | Source-controlled App Platform contract, deploy/rollback tooling, provider audit, and recovery instructions |

The `ric` App Platform region is a managed regional product, not the RIC1 Droplet datacenter. It
preserves the approved geographic production area without claiming that Droplet capacity evidence
applies. Live availability, scheduling, Ecuador latency, and `ric`-to-PlanetScale latency remain
fresh acceptance gates.

Dedicated Egress currently assigns **two** exclusive IPv4 addresses to one App. Both must be
recorded as individual `/32`s. This is the provider's security-equivalent replacement for the one
Droplet `/32`; omitting the feature or accepting changing default egress would be a separate
security and cost decision. App Platform VPC integration is prohibited because it cannot coexist
with Dedicated Egress and does not create a private path to PlanetScale.

This explicitly amends PRD 02's sentence that the deployment contract remains vendor-neutral. The
container artifact, business modules, browser/API protocol, PostgreSQL contract, health routes,
and graceful-shutdown behavior remain portable. The production binding, trusted ingress header,
secret delivery, app spec, deployment workflow, and live audit become one small App
Platform-specific adapter. The implementation must not build a provider abstraction or keep a
second active provider path merely to simulate neutrality; another provider move would require a
new explicit amendment.

This also consciously replaces the host hardening controls that App Platform does not expose.
DigitalOcean documents a gVisor runtime and an ephemeral local filesystem, but Capstone cannot
configure the Droplet path's read-only root filesystem, capability drop, `no-new-privileges`, PID
limit, UFW, or systemd sandbox. The repository retains non-root UID 1000, no embedded secrets, no
authoritative filesystem writes, bounded memory/work, and exact-image verification. The managed
sandbox substitution is part of plan approval, not evidence that the controls are identical.

The managed edge is also a material privacy-boundary change. TLS terminates before the request
reaches Fastify, so DigitalOcean and its Cloudflare-backed edge can technically process plaintext
application content and authentication material. On August 12, 2026, the owner accepted those
processors after reviewing the current public DPA, subprocessor list, processing and support
regions, edge/request logging and retention, employee access, deletion, breach-notification, and
incident terms. That acceptance explicitly includes the residual uncertainty that public material
does not quantify every internal edge-log retention and employee-access detail. Material term
changes require re-review; never claim end-to-end encryption to the container.

Every other product, privacy, data, model, email, budget, capacity, latency, and recovery decision
remains locked. In particular, this amendment does not change:

- the modular monolith, one employee-facing origin, one OCI application artifact, one steady-state
  application instance, one database, and no queue, cache, worker, Redis, or microservice;
- `https://chat.capstone.com.ec`, Better Auth, Resend, OpenRouter, Zero Data Retention, model
  mappings, prompts, output limits, accounting, reservations, or privacy attestations;
- PostgreSQL as the source of truth, direct port 5432, `verify-full` TLS, separate application,
  migration, and recovery roles, and no transaction held across a network wait;
- PlanetScale PS-5 ARM Single Node in AWS `us-east-1`, 10 GB initial storage, a hard 15 GB ceiling,
  no HA, no read replica, and no automatic failover;
- backups every 12 hours retained for 84 hours, at least 72 continuously accessible hours of PITR,
  RPO at most 15 minutes, RTO at most four hours, isolated restore, and irreversible active-data
  deletion;
- expand/contract migrations before new code receives traffic and compatibility with the
  immediately previous web build;
- the USD 100 monthly workspace model budget, two employee chat workflows, and one active workflow
  per conversation;
- the 20-registered/20-signed-in/40-stream launch workload and every existing correctness and
  isolation gate;
- ordinary API p95 at most 300 ms and p99 at most 750 ms, admitted send through
  `response.started` p95 at most 500 ms, chunk-to-browser presentation p95 at most 100 ms,
  backend cancellation p95 at most 500 ms, and Ecuador authenticated usability p95 within two
  seconds;
- 10 seconds to upstream headers, 60 seconds to the first visible model event, 45 seconds without
  an upstream stream event, five minutes total generation duration, a 15-second content-free
  heartbeat, and the browser's 35-second downstream-silence watchdog;
- content-free logs, traces, metrics, load evidence, and recovery evidence; and
- the explicitly accepted one-owner Bitwarden recovery risk. This plan does not claim a second
  recovery owner.

Approval and authorization remain separate:

1. approving this document freezes the intended App Platform design;
2. explicitly authorizing repository implementation permits source-controlled changes only;
3. creating a disposable managed rehearsal requires a fresh authorization with region, resources,
   maximum prorated spend, lifetime, data class, and cleanup scope;
4. production provisioning, secrets, DNS, data, email, paid inference, and recovery mutation each
   require their own authorization; and
5. candidate acceptance occurs only after every managed and manual gate passes and a final review
   finds no unresolved P1/P2 defect.

## Current provider contracts

Provider prices and behavior are not application constants. Recheck every item immediately before
provisioning and record material drift before acting.

### DigitalOcean App Platform

- [App Platform pricing](https://docs.digitalocean.com/products/app-platform/details/pricing/)
  currently lists `apps-s-1vcpu-1gb-fixed` at USD 10/month and
  `apps-s-1vcpu-0.5gb` at USD 5/month. Services are billed by the second. Jobs are billed only while
  running, with the documented minimum.
- The same pricing contract lists Dedicated Egress at up to USD 25/month, billed by the second.
- [Dedicated Egress](https://docs.digitalocean.com/products/app-platform/how-to/add-ip-address/)
  assigns two exclusive IPv4 addresses to one App, persists them across ordinary deployments, and
  permanently releases them if the feature is disabled or the App is destroyed. Every automated
  spec update must retain `egress.type: DEDICATED_IP`.
- [App Platform limits](https://docs.digitalocean.com/products/app-platform/details/limits/)
  prohibit persistent Volumes, limit the ephemeral filesystem, require AMD64 Linux images, expose
  no SSH/SFTP port, and state that HA requires two or more containers. This plan intentionally uses
  one container and accepts no steady-state HA.
- [App Platform availability](https://docs.digitalocean.com/products/app-platform/details/availability/)
  currently lists the managed `ric` region. Provider documentation does not replace the required
  live scheduling and latency proof.
- The [App specification reference](https://docs.digitalocean.com/products/app-platform/reference/app-spec/)
  is the live schema authority for component sizes, image digests, jobs, environment scope,
  ingress, domains, health checks, termination, edge settings, alerts, and egress.
- [Container-image deployment](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/)
  supports private GHCR images and recommends immutable SHA digests. GHCR does not auto-deploy;
  this plan intentionally uses a protected explicit deployment.
- [Deployment jobs](https://docs.digitalocean.com/products/app-platform/how-to/manage-jobs/)
  support `PRE_DEPLOY` and block the release when the job fails. The migration job never runs in
  API startup.
- [Deployment rollback](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/)
  retains the ten most recent successful deployments and restores code, configuration, and app
  spec without restoring database data. Because that can also restore stale encrypted variables,
  Capstone does not use the native rollback action in production.
- [Termination settings](https://docs.digitalocean.com/products/app-platform/how-to/configure-termination/)
  permit up to 110 seconds of edge drain before `SIGTERM` and up to 600 seconds between `SIGTERM`
  and `SIGKILL`.
- [Health checks](https://docs.digitalocean.com/products/app-platform/how-to/manage-health-checks/)
  distinguish readiness, which removes traffic, from liveness, which restarts the component.
- [Edge settings](https://docs.digitalocean.com/products/app-platform/how-to/configure-edge-settings/)
  expose cache, email-obfuscation, and threat-control switches that must be explicit for this
  authenticated streaming service.
- [Client-address guidance](https://docs.digitalocean.com/support/where-can-i-find-the-client-ip-address-of-a-request-connecting-to-my-app/)
  designates `do-connecting-ip` as the original client address and says `x-forwarded-for` identifies
  DigitalOcean ingress instead.
- [Domain management](https://docs.digitalocean.com/products/app-platform/how-to/manage-domains/)
  provides managed TLS, primary-domain routing, starter-domain redirection, and component routing,
  but does not support attaching DNSSEC-enabled domains. If CAA is present, it must authorize both
  `letsencrypt.org` and `pki.goog`. Deleting an App before detaching its domain can leave that domain
  bound to the deleted App for up to 24 hours.
- [Encrypted environment variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/)
  are decrypted in the runtime and remain visible to trusted team members who can access the
  console or change code/configuration. Provider roles, MFA, and repository review remain part of
  the secret boundary.
- [Runtime log forwarding](https://docs.digitalocean.com/products/app-platform/how-to/forward-logs/)
  supports OpenSearch, Datadog, and Better Stack, but not New Relic. Adding a second log vendor is
  out of scope; the bounded application-owned New Relic mirror below preserves the approved
  destination without a host agent.
- [Runtime log viewing](https://docs.digitalocean.com/products/app-platform/how-to/view-logs/)
  provides live runtime and crash logs, while retained runtime history requires forwarding.
  Build/deploy history is provider-retained separately.
- [App Platform alerts](https://docs.digitalocean.com/products/app-platform/how-to/create-alerts/)
  cover deployment/domain/job events and component metrics but not independent public endpoint
  uptime. One [DigitalOcean Uptime](https://docs.digitalocean.com/products/uptime/details/pricing/)
  check supplies the public readiness/TLS/latency signal; its current first-check allowance and
  otherwise USD 1/month price must be reverified in the live team.
- [Component console access](https://docs.digitalocean.com/products/app-platform/how-to/console/)
  is an ephemeral running-container shell, not persistent storage or a deployment mechanism.

### PlanetScale Postgres

- [Postgres pricing](https://planetscale.com/docs/postgres/pricing) currently lists PS-5 Single
  Node at USD 5/month with 512 MiB RAM and 10 GB included storage.
- [IP restrictions](https://planetscale.com/docs/postgres/connecting/ip-restrictions) accept
  individual `/32`s and can scope rules by role. Changes affect new connections only, so every
  restriction test and rotation must force pool reconnection.
- [Postgres connections](https://planetscale.com/docs/postgres/connecting) require TLS. The Node
  application retains direct port 5432 and `sslmode=verify-full` without an undocumented root
  certificate path.
- Single Node remains a deliberately accepted no-HA database. Application health cannot imply
  database failover that the provider does not supply.
- [PlanetScale backups](https://planetscale.com/docs/postgres/backups) remain the authority for
  scheduling, retention, PITR, restored-branch billing, and the settings/credentials/extensions
  that a restore does not recreate. The approved 12-hour/84-hour schedule, restored-branch
  preparation, storage ceiling, and PITR requirements from the Droplet amendment remain unchanged
  and must be re-proved in the new managed topology.

### GitHub and New Relic

- GitHub Actions remains the authoritative code and image gate. It publishes exactly one non-root
  AMD64 image only after the exact revision passes every required check.
- App Platform receives a dedicated read-only GHCR credential. GitHub Actions receives a distinct
  DigitalOcean token using the documented [App update scope](https://docs.digitalocean.com/reference/api/scopes/app/update/)
  with exactly `app:update`, `app:read`, `regions:read`, `sizes:read`, and
  `actions:read` in a protected production environment. DigitalOcean scopes those permissions by
  resource type across the current team, not by App ID, so Capstone uses a dedicated DigitalOcean
  team containing no unrelated App and the workflow also fences every request to the one recorded
  production App ID. The token excludes `app:create`, `app:delete`, and `app:access_console`.
- New Relic remains the sole external application telemetry destination. Fastify continues direct
  vendor-neutral OTLP traces and metrics; the new log mirror uses New Relic's HTTPS Log API without
  a proprietary agent or SDK.

## Proposed production topology

```text
Internet
  |
  | HTTPS https://chat.capstone.com.ec
  v
DigitalOcean App Platform managed Cloudflare edge
  |-- managed custom-domain TLS
  |-- starter domain redirects to the primary origin
  |-- edge cache and email transformation disabled
  |-- Dedicated Egress: two exclusive IPv4 addresses
  |
  `-- one dynamic service in App Platform region `ric`
        apps-s-1vcpu-1gb-fixed
        one shared vCPU / 1 GiB / one instance
        no autoscaling / no scale-to-zero / no VPC
        exact immutable GHCR digest, AMD64, non-root UID 1000
        binds 0.0.0.0:3000
        serves Vite assets and /api/* from one origin
        readiness: /api/health/ready
        liveness:  /api/health/live
        stdout -> App Platform live/crash logs
        bounded content-free log mirror -> New Relic Log API
        OTLP traces/metrics -> New Relic

Deployment of the same exact digest
  |
  |-- PRE_DEPLOY migration job
  |     apps-s-1vcpu-0.5gb, billed only while running
  |     migration DATABASE_URL only
  |     direct 5432 / verify-full
  |     failure blocks rollout
  |
  `-- readiness-gated rolling service replacement
        110-second edge drain
        SIGTERM
        300-second grace before SIGKILL

Both dedicated App Platform egress IPv4 /32s
  |
  | public TLS, sslmode=verify-full, direct port 5432
  v
PlanetScale AWS us-east-1
  `-- PostgreSQL PS-5 ARM Single Node
        512 MiB / no HA / no replica
        10 GB initial storage / hard 15 GB ceiling
        application role: runtime DML only
        migration role: PRE_DEPLOY DDL only
        recovery role: absent from steady-state App configuration
        backups every 12 hours retained 84 hours

Independent public availability
  `-- one DigitalOcean Uptime check
        https://chat.capstone.com.ec/api/health/ready
        TLS validity + latency + external reachability

Native operational signals
  `-- App Platform Insights and alerts
        deploy/domain/job outcomes, CPU, memory, restarts, requests, latency
```

The pre-deploy job is a deployment step, not a worker or persistent second service. During a
rollout, old and new service containers may overlap only while App Platform proves readiness and
drains the old container. One instance remains the steady-state capacity and availability posture.

Use one stable naming set so scripts and evidence never guess a target:

| Resource | Planned identity |
|---|---|
| DigitalOcean team | `Capstone Chat Production`, containing no unrelated App |
| DigitalOcean project | `capstone-chat-production` |
| App Platform App | `capstone-chat-production` plus its provider App ID as deployment authority |
| Service component | `capstone-chat` |
| Steady migration job | `capstone-migrate` |
| Temporary initialization job | `capstone-initialize` |
| DigitalOcean Uptime check | `capstone-chat-readiness` |
| PlanetScale database/cluster display name | `capstone-chat-production` |
| PostgreSQL database | `capstone_chat` |

Provider-generated credential/role identifiers remain recorded evidence rather than assumptions in
source. The App ID, not the editable display name, fences deployments.

## Cost statement

The proposed steady-state estimate is:

| Component | Candidate | Monthly estimate |
|---|---|---:|
| DigitalOcean App Platform service | `apps-s-1vcpu-1gb-fixed`, one instance | USD 10.00 |
| DigitalOcean Dedicated Egress | Two exclusive IPv4s for one App | USD 25.00 |
| App Platform ingress, managed TLS, and outbound transfer | Service contributes 100 GiB to the team-wide pooled allowance | USD 0.00 base before pooled overage |
| DigitalOcean Uptime | One public readiness/TLS/latency check | USD 0.00 if the current included check is available; otherwise USD 1.00 |
| PlanetScale Postgres | PS-5 ARM Single Node, initial included 10 GB | USD 5.00 |
| GitHub Container Registry | Current container-registry pricing | USD 0.00 |
| **Candidate base infrastructure** | | **USD 40.00–41.00/month** |
| Bitwarden Teams | One company-controlled owner, billed annually | USD 4.00 |
| **Candidate operational base** | Infrastructure plus one Bitwarden owner | **USD 44.00–45.00/month** |
| Configured database storage ceiling | Prior approved estimate for growth from 10 GB to 15 GB | **USD 44.625–45.625/month operational total (USD 44.63–45.63 rounded)** |

The migration job is billed only while it runs and is not represented as a permanent USD 5 line
item. The one-time initialization job is also billed only while it runs. Their live invocation
estimates must be recorded during rehearsal. App Platform and PlanetScale transfer, PlanetScale
backup/WAL storage beyond included allowances, temporary rehearsal and recovery resources, DNS,
taxes, provider price changes, and support are variable. New Relic and Resend remain assumed within
their approved free allowances and must be verified in their live accounts. OpenRouter spend
remains separate and hard-capped by the application at USD 100/month.

The 100 GiB transfer allowance is pooled across every App in the DigitalOcean team and is not
reserved for Capstone Chat. DigitalOcean does not currently expose cumulative accrued App Platform
transfer usage, so the monthly billing review must include every team App and current overage. The
dedicated-team boundary above prevents an unrelated application from silently consuming this
candidate's assumed headroom.

The 512 MiB App Platform service would reduce the operational base to USD 39–40/month, but it is not
the proposed launch candidate. It is below the application's current 640 MiB production envelope,
and historical 0.5 CPU/512 MiB evidence did not pass the experimental response-start objective
twice. It may be considered only through a later explicit amendment and complete managed
qualification.

Grouping future unrelated applications inside this App to share Dedicated Egress is outside this
plan. It would couple deployment, secrets, domains, spend, and failure boundaries. A future
multi-application decision requires its own architecture and isolation review.

## Scope

### In scope

- Create this amendment and, after approval, explicitly amend PRD 02, PRD 06, the PRD index, the
  active Phase 8 records, README, and every operations runbook without rewriting history.
- Replace the active Droplet/Caddy/systemd/UFW/Volume/Fluent Bit deployment artifacts with a narrow
  App Platform contract, audit, deployment workflow, rollback workflow, and recovery procedure.
- Preserve the exact non-root GHCR artifact and change only the platform-facing runtime contract.
- Add one explicit App Platform configuration mode: `0.0.0.0:3000`,
  `do-connecting-ip`, and component-scoped platform secrets.
- Add one exact-digest 512 MiB `PRE_DEPLOY` migration job with only the migration database role.
- Add one temporary exact-digest initialization job for first provisioning only; it runs migration,
  database-only identity bootstrap, and model-policy bootstrap in order behind a durable latch,
  uses only revocable bootstrap credentials, sends no email, and is absent from the accepted
  steady-state spec.
- Preserve both assigned dedicated egress IPv4s on every spec update and allowlist both `/32`s in
  PlanetScale.
- Preserve New Relic OTLP and replace Fluent Bit with one bounded, content-free, no-disk New Relic
  Log API mirror inside the existing API process.
- Map the existing readiness, liveness, graceful shutdown, stream recovery, and expand/contract
  behavior onto App Platform's health and termination contracts.
- Rehearse exact image deployment, migration failure, readiness failure, active-stream drain,
  rollback, egress persistence, secret rotation, cold recreation, and PlanetScale PITR before
  candidate acceptance.
- Remove the now-dead host operator path after its historical record and the new path are complete.

### Out of scope

- Provisioning, credentials, DNS, production data, paid model inference, recovery branches, or
  resource deletion during plan or repository implementation.
- A raw Droplet, Kubernetes, DOKS, Terraform, Pulumi, Ansible, Coolify, Dokploy, Docker Compose in
  production, a self-hosted runner, or a second deployment control plane.
- Multiple steady-state instances, autoscaling, scale-to-zero, HA, a load balancer selected by us,
  a PlanetScale replica, a database pooler, Redis, a queue, a cache, or a worker.
- DigitalOcean Managed PostgreSQL, App Platform development databases, VPC integration, Volumes,
  Spaces, DOCR, or a second log/metrics vendor.
- Sharing this App or its egress pair with another product.
- Lowering workload, latency, privacy, isolation, memory-cleanup, streaming, cancellation, backup,
  RPO, or RTO gates to make the candidate pass.
- Treating provider documentation, local Docker evidence, Render evidence, or Droplet evidence as
  managed App Platform evidence.
- Product features, protocol changes, UI redesign, model-policy changes, or unrelated refactoring.

## Required repository changes

### 1. Amend authority without erasing history

After this plan is approved for implementation:

- update `docs/prd/README.md` with the App Platform amendment pointer;
- replace only the enumerated provider/operations/cost clauses in PRD 02 and PRD 06;
- add prominent supersession notices to the Render and Droplet Phase 8 amendments while retaining
  their complete implementation and measurement records;
- keep the original Phase 8 hardening record intact except for an active-provider pointer; and
- update README and the operations index so there is exactly one active production path.

The new authority text must say **two** dedicated egress `/32`s, not “one static IP.” It must also
record the Cloudflare-backed managed edge, encrypted environment secrets, direct log mirror,
managed rolling deployment, `ric` App Platform region, and USD 44–45 operational base.

### 2. Replace host artifacts with one App Platform contract

Add `deploy/app-platform/` with narrowly focused artifacts:

```text
deploy/app-platform/
  README.md
  app.contract.yaml
  bootstrap.contract.yaml
  egress.contract.yaml
  domain.contract.yaml
  initialization.contract.yaml
  contract.mjs
  provisioning.mjs
  provision.mjs
  deploy.mjs
  rollback.mjs
  configuration.mjs
  configure.mjs
  operator-console.mjs
  console.mjs
  live-contract.mjs
  ghcr-retention.py
  ghcr-retention.test.py
  fixtures/
```

`app.contract.yaml` is the source-controlled non-secret contract. It describes:

- App name and `ric` region;
- `egress.type: DEDICATED_IP`;
- one `apps-s-1vcpu-1gb-fixed` service and no autoscaling;
- one `apps-s-1vcpu-0.5gb` `PRE_DEPLOY` job;
- one required immutable-image input shared by the service and job, without storing a release
  digest or placeholder in the repository contract;
- component-scoped environment-key names and classifications, but no values or provider-encrypted
  ciphertext;
- port 3000 and a root ingress rule preserving the full path;
- readiness and liveness checks;
- `drain_seconds: 110` and `grace_period_seconds: 300`;
- `disable_edge_cache: true` and `disable_email_obfuscation: true`;
- enhanced threat control disabled until its effect on the authenticated streaming contract is
  separately measured;
- exactly `domains: [{ domain: chat.capstone.com.ec, type: PRIMARY,
  minimum_tls_version: "1.2" }]`, with no DigitalOcean-managed DNS `zone`, plus a starter-domain
  redirect rule whose authority is the fetched provider `DEFAULT` domain and whose 308 HTTPS
  target is `chat.capstone.com.ec`; and
- deploy/domain/CPU/memory/restart alerts supported by the live account.

The contract is a digest-free structural schema and policy, not a per-release App spec. A renderer
requires one full `sha256:` digest plus the matching full revision, validates the image, and then
combines those inputs with the fetched live encrypted values in memory or a protected temporary
file. It refuses a missing, mutable, or placeholder image input. The repository contract therefore
does not drift on every release and remains impossible to mistake for a secret-bearing directly
applicable spec. Neither the renderer nor the live updater emits a secret-bearing spec to stdout,
logs, CI artifacts, caches, or the repository.

`bootstrap.contract.yaml`, `egress.contract.yaml`, `domain.contract.yaml`, and
`initialization.contract.yaml` are also digest-free structural contracts. The separate egress and
domain files make the required provider ordering executable: the database is not opened before
the assigned egress pair exists, and the initialization job is not introduced before database and
domain gates pass. `provision.mjs` creates or advances only these adjacent reviewed states through
the provider API and validates each result. The final live validator rejects every transient mode.

App Platform permits Dedicated Egress only after an initial successful deployment. The bootstrap
contract therefore runs the same reviewed production image through a narrow `egress-bootstrap`
entrypoint that:

- requires no runtime application, model, email, authentication, telemetry, or database secret;
- uses one dedicated private-GHCR pull credential only in the service image source contract, never
  as a container environment variable;
- binds only the App Platform service port;
- returns 200 for the two health endpoints and 404 everywhere else;
- emits only fixed content-free lifecycle logs;
- has no product, authentication, database, model, or email behavior; and
- is forbidden by the final live-contract audit.

The real production service cannot perform first initialization after it becomes ready: its
existing readiness contract correctly rejects an absent or incompatible model policy. A separate
temporary initialization contract therefore keeps the runtime-secret-free bootstrap service
active and adds one exact-image 512 MiB `PRE_DEPLOY` job. That job:

- receives short-lived initialization-only migration and application database roles under separate
  keys, plus one short-lived OpenRouter catalog key;
- receives no final application/migration credential, Better Auth secret, Resend key, or New Relic
  ingest credential;
- reads one schema-versioned canonical initialization document of at most 32 KiB UTF-8, computes
  its SHA-256 hash, and stores only that hash and phase metadata in a singleton durable
  initialization latch;
- runs migrations, checks or creates the latch before any provider network request, performs the
  database-only identity authority bootstrap, fetches and validates the model catalog without
  holding a database connection, and then commits model policy sequentially through one narrow
  entrypoint;
- records phase completion transactionally so the exact same document is a safe repeat, a
  different document fails before provider work, and a completed latch makes every later replay a
  content-free `already-complete` result;
- creates the canonical administrator approval but deliberately sends no invitation while the
  bootstrap service still returns 404 for product routes;
- emits only content-free phase/outcome evidence; and
- is removed, together with all initialization-only variables, before the steady-state service is
  activated.

Multiple pre-deploy jobs are not used for first initialization because App Platform does not
provide the required migration-before-bootstrap ordering between independent jobs.

Empty-database first provisioning follows this fail-closed sequence:

1. deploy the bootstrap contract without the production domain or any runtime secret;
2. enable Dedicated Egress and record the two assigned IPv4s;
3. create PlanetScale restrictions for both `/32`s and the exact roles;
4. configure and verify the custom domain, managed TLS, exact primary/starter-domain behavior, and
   maintenance posture while every product route remains unavailable;
5. install encrypted variables only on the temporary initialization job and run the sequential
   migration/identity/policy initialization contract;
6. verify its latch, canonical database state, and content-free evidence; remove the temporary job
   and every initialization-only variable; then revoke both temporary database roles and the
   temporary OpenRouter key;
7. install the distinct steady component-scoped service and migration variables;
8. render and deploy the full live candidate from the structural contract and exact digest;
9. verify release identity, readiness, database authority, egress, and absence of initialization
   configuration;
10. redeploy that unchanged exact final candidate through the provider-supported deployment action
    until the fetched ten-deployment history contains no pre-egress or initialization spec;
11. only after that history gate, install the steady deploy token and pinned App ID in the protected
    GitHub environment, then revoke the provisioning credential;
12. from the verified ready service instance, run one bounded application-role invitation command
    using the final Resend configuration and the already committed administrator approval; and
13. verify delivery before allowing the administrator to follow the production-origin link.

No step temporarily opens PlanetScale to `0.0.0.0/0` or an unbounded provider range.

DigitalOcean retains the successful initialization deployment among its recent deployment
history even after the live spec removes the job. The plan does not claim that procedure disables
native rollback or erases provider-retained encrypted configuration. Revoked bootstrap credentials
and the durable completed latch make an accidental replay unable to mutate canonical state; a
managed negative rehearsal must attempt the old deployment and prove that it fails safely. The
provider-retained encrypted initialization document remains subject to the approved App Platform
privacy/retention terms until DigitalOcean expires it.

The earlier successful egress-bootstrap deployment is more dangerous: its historical spec has no
`egress.type: DEDICATED_IP`, and native rollback could restore that spec and permanently release the
pair. In the disposable rehearsal, explicitly attempt that rollback and record whether DigitalOcean
blocks it, preserves egress, or releases/replaces the pair. Before production candidate acceptance,
use provider-supported exact-final-spec redeployments until both the pre-egress and initialization
deployments have fallen outside the ten rollbackable successful deployments, then fetch the
history and prove neither is selectable. Every eviction deployment uses the same accepted digest,
current encrypted values, steady migration job, and final spec through the documented
create-deployment action that redeploys an unchanged digest; it is not fabricated release evidence
and is labeled `bootstrap-history-eviction`, not a new release. If the provider cannot prove the
unsafe specs are no longer selectable, this candidate fails rather than relying on operator
procedure alone.

Cold App recreation or PITR cutover against an already initialized production database is a
different path. It never receives the original PII-bearing initialization document, never adds the
temporary initialization job or its roles/key, never rewrites the latch, and never sends an initial
administrator invitation. It:

1. validates the isolated/restored database's completed initialization latch, one canonical
   workspace/administrator authority, compatible model policy, migrations, and integrity before
   it can become a cutover target;
2. creates the runtime-secret-free App bootstrap only to obtain the new App ID and egress pair;
3. recreates or rotates the steady application and migration roles, allowlists both new `/32`s, and
   keeps the product domain in maintenance while the old authority is fenced;
4. installs only the steady service/migration variables and exact image credentials;
5. deploys the steady migration job and service through readiness;
6. verifies existing identity, session, policy, accounting, and application behavior without
   creating or emailing an administrator;
7. evicts the new pre-egress bootstrap deployment from rollbackable history using unchanged final
   redeployments; and
8. replaces the protected GitHub App ID/token only after that gate, revokes provisioning authority,
   and completes the controlled domain cutover and smoke.

A missing, incomplete, or conflicting latch on a purported production restore fails recovery and
requires investigation. It does not silently convert recovery into first initialization. Only a
genuinely empty new database under first-provisioning authorization uses the preceding
initialization/invitation sequence.

Once the App Platform implementation and runbooks are accepted, delete the active
`deploy/digitalocean/` host artifacts rather than maintaining two production systems. The Droplet
plan remains the historical explanation of those removed files.

### 3. Make the production runtime platform-explicit

Extend the typed configuration with one deployment target and one secret-source contract. Proposed
values are:

```text
DEPLOYMENT_TARGET=digitalocean-app-platform
CAPSTONE_SECRET_SOURCE=platform-environment
CLIENT_ADDRESS_SOURCE=digitalocean-app-platform
HOST=0.0.0.0
PORT=3000
```

In production:

- the deployment target is required and accepts only the approved App Platform value;
- App Platform requires `HOST=0.0.0.0`; loopback remains the development default;
- `trustProxy` remains false so arbitrary forwarding headers never become Fastify authority;
- the server accepts direct secret variables only when the secret source and deployment target are
  the exact approved pair;
- `CAPSTONE_SECRET_FILE` and direct secret variables are mutually exclusive;
- the server and migration entrypoints reject the old Caddy target;
- `PUBLIC_ORIGIN`, Resend sender, model gateway, New Relic endpoint, production database TLS,
  deployment revision, and web-build validation remain fail closed; and
- fake model/email providers remain prohibited in production.

The existing secret-file reader may remain only for offline recovery tooling that demonstrably
uses it. It must not remain a second production server path. If no accepted recovery command needs
it after refactoring, remove it and its tests completely.

The OCI image keeps its non-root `node` user, static assets, migrations, and single default server
command. The already validated build argument becomes both the OCI revision label and an immutable
runtime `DEPLOYMENT_REVISION` environment value in the image. The App spec is forbidden from
overriding it, so health responses, telemetry, the embedded web revision, and the image label have
one release authority. The image default may remain conservative; the App contract supplies the
explicit bind and provider mode. No secret becomes an image build argument or layer.

### 4. Replace the Caddy client-address boundary exactly

Add `digitalocean-app-platform` to the client-address source enum and keep the resolver small:

1. capture `do-connecting-ip` before deleting forwarding headers;
2. reject arrays, comma-separated values, whitespace ambiguity, and invalid IPv4/IPv6 whenever the
   header is present;
3. normalize IPv6 exactly as the current resolver does;
4. delete `do-connecting-ip`, `Forwarded`, every `X-Forwarded-*`, `X-Real-IP`,
   `CF-Connecting-IP`, and the retired `X-Capstone-Client-IP` before application code runs;
5. store either the validated address or an explicit missing sentinel in the existing
   request-scoped `WeakMap`;
6. permit a missing address only on `/api/health/live` and `/api/health/ready`, because provider
   health probes are not guaranteed to send the public-edge header; and
7. require the stored validated address on every other public route and never fall back to
   `request.ip`, the App Platform ingress address, or an attacker header in production.

Unlike the Caddy path, the application cannot identify one stable loopback peer. Its trust boundary
is that App Platform containers are reachable publicly only through managed ingress and the
provider injects the documented header. That boundary is not accepted from documentation alone.
The managed rehearsal must prove provider health probes succeed without the header; invalid present
headers still fail; ordinary public requests cannot omit or spoof the value; and forged,
duplicated, comma-joined, IPv4, and IPv6 values through the public edge leave the employee-visible
rate-limit and audit address equal to the real client. If App Platform preserves an
attacker-selected value, this candidate fails pending a new edge decision; it does not fall back to
`X-Forwarded-For`.

### 5. Move runtime secrets to component scope

Bitwarden Teams remains the recoverable source. App Platform stores runtime copies as encrypted
`SECRET` variables.

The service receives only:

```text
BETTER_AUTH_SECRET
DATABASE_URL                 application role
OPENROUTER_API_KEY
OTEL_EXPORTER_OTLP_HEADERS
RESEND_API_KEY
```

The pre-deploy job receives only:

```text
DATABASE_URL                 migration role
```

During first provisioning only, the temporary initialization job receives:

```text
CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL    temporary initialization migration role
CAPSTONE_BOOTSTRAP_DATABASE_URL              temporary initialization application role
OPENROUTER_API_KEY                           short-lived initialization provider key
CAPSTONE_INITIALIZATION_DOCUMENT             encrypted JSON, at most 32 KiB UTF-8
```

Its non-secret runtime values include the exact provider mode and schema version; it has no email
mode or sender. The initialization document contains only the workspace identifier, administrator
identity, locked budget/concurrency/output values, and approved privacy attestation. It is treated
as `SECRET` because it contains PII and operational evidence, is never printed, and is deleted from
the live App spec immediately after the successful initialization deployment. Its canonical hash,
not its contents, is persisted in the initialization latch. The temporary job does not receive the
Better Auth, Resend, or New Relic credential. The two temporary database roles and OpenRouter key
are revoked after success and are never reused as steady credentials. The job code can call only
the catalog client; the provider key uses a zero spend limit if current OpenRouter behavior permits
catalog access with it, otherwise the smallest explicit temporary limit accepted during the
separately authorized bootstrap. That key is not described as provider-scope-enforced unless
OpenRouter actually exposes such a scope.

Non-secret configuration is explicit and component-scoped where scopes differ. Secrets are not
declared at App level, because that would give the migration job model, email, authentication, and
telemetry credentials it does not need. The recovery credential is never installed in the normal
App spec.

The App Platform private-GHCR credential is a separate read-only package credential and is not a
runtime environment variable. Each newly added image-bearing component has no encrypted field yet,
so its separately authorized first renderer submission must accept the source `username:token`
through protected input, place it only in that component's `image.registry_credentials`, submit it
without printing it, and immediately fetch and validate DigitalOcean's encrypted `EV[...]`
replacement. That applies first to the bootstrap service, then to the temporary initialization job,
and finally to the steady migration job when each is introduced. Existing component fields retain
their current encrypted values byte-for-byte. After a field has an encrypted representation, no
ordinary update substitutes plaintext.

Registry rotation submits the new read-only value to every image-bearing block in one protected
spec update, proves the exact image can be pulled into a fresh replacement, fetches the new
encrypted representation, and revokes the previous GitHub credential only after the candidate is
ready. Forward rollback preserves the current registry credential. The source credential and
recovery metadata remain in Bitwarden; provider-encrypted `EV[...]` values are not source copies.

The GitHub deployment workflow uses a separate DigitalOcean token limited to the required App
operations.

The live-contract audit proves:

- every expected secret key is present in the correct component;
- no unexpected secret key exists;
- every secret is provider-classified `SECRET` and runtime-only;
- every image-bearing block has a provider-encrypted representation of the one approved GHCR
  source credential, preserved byte-for-byte per field and classified separately from runtime
  `SECRET` environment variables;
- plaintext and resolved values are never printed;
- migration and service credentials are distinct;
- the recovery role is absent; and
- only named trusted DigitalOcean team members can access console or configuration.

The accepted final audit additionally proves that the initialization job, both
`CAPSTONE_BOOTSTRAP_*_DATABASE_URL` variables, and `CAPSTONE_INITIALIZATION_DOCUMENT` are absent
from the live spec; every bootstrap credential is revoked; and no runbook treats native rollback as
safe. Provider deployment history may still contain encrypted old initialization configuration,
so the completed latch is tested against an attempted historical replay rather than claiming that
the platform makes replay impossible.

Rotation uses overlap only where the provider requires it. Updating a secret triggers a managed
deployment, so the runbook must account for old/new container overlap, force PostgreSQL pool
reconnection after IP or role changes, verify readiness, and revoke the prior credential only after
the new release is authoritative.

### 6. Preserve exact-image CI and make deployment explicit

Keep the current CI quality, Playwright, image-content, non-root, revision, migration, secret-scan,
and GHCR publication gates. Harden any remaining Docker-context or publish-stage omissions before
using the image in App Platform.

Add a protected production deployment workflow or an equivalent named-operator command. The
recommended flow is a manual GitHub Actions `workflow_dispatch` using a protected `production`
environment. Its long-lived deploy token has exactly `app:update`, `app:read`, `regions:read`,
`sizes:read`, and `actions:read`; it has no create, delete, or console permission. Because
DigitalOcean scopes the token to every App in a team rather than one App ID, production uses a
dedicated team containing only Capstone Chat and every workflow request must match the one pinned
production App ID before it can read or update state. The normal release entrypoint accepts only a
strict forward candidate: exactly the current protected `main` HEAD, different from and descended
from the active accepted revision. An older commit merely reachable from `main`, an equal commit,
or a divergent commit is not a normal deployment. Same-digest history eviction has its own
no-spec-change action, and selecting the immediately previous accepted digest is reserved for
`rollback.mjs`. The separately authorized first steady deployment has no active ancestor; it still
must equal the protected `main` HEAD and becomes the ancestry baseline only after candidate
acceptance.

The long-lived token is not installed while a pre-egress or initialization deployment remains
rollbackable. First provisioning and cold App recreation use the short-lived provisioning token
through final-spec history eviction; only then is the pinned App ID plus steady token installed in
the protected environment and the provisioning token revoked. Thus the steady `app:update` token
never coexists with an unsafe native-rollback target.

A normal release then:

1. resolve and record the current protected `main` HEAD and active accepted release;
2. require the candidate's full 40-character revision to equal that HEAD, verify the active
   revision is its strict ancestor when one exists, and verify the candidate's required GitHub
   checks passed;
3. resolve the full-SHA GHCR tag to an immutable digest;
4. pull and inspect the image revision, non-root user, runtime contents, migration set, and embedded
   web revision;
5. fetch the current App Platform spec without printing it;
6. verify the complete non-secret live contract and the presence of Dedicated Egress;
7. preserve provider-encrypted secret values byte-for-byte;
8. change only the service/job digest; the revision is immutable image metadata, not a mutable App
   variable;
9. re-resolve protected `main`, re-fetch the App/deployment fingerprint, fail if either moved, then
   submit the update and record the App deployment ID, revision, digest, migration result, and final
   status;
10. poll boundedly until the pre-deploy job and service deployment succeed or fail;
11. verify the resulting live spec, then verify public readiness reports the exact revision and run
    content-free smoke checks; and
12. retain only safe release evidence.

Broad bootstrap/delete/console authority is not bundled into one credential. Separately authorized
guided operations mint distinct shortest-lived credentials:

- provisioning uses only `app:create`, `app:read`, `app:update`, `regions:read`, `sizes:read`, and
  `actions:read`, covering creation and Dedicated Egress enablement but not delete or console;
- a console operation uses exactly `app:access_console`, `app:read`, `regions:read`, `sizes:read`,
  and `actions:read`;
- teardown creates a distinct credential with exactly `app:delete`, `app:read`, `regions:read`,
  `sizes:read`, and `actions:read` only after the custom domain is detached and provider release is
  verified; and
- the one Uptime check is created through an explicit owner control-panel step, so no Uptime token
  is stored or combined with deployment authority.

None is installed in GitHub. Each is revoked immediately after its bounded operation and cannot be
substituted for the steady deploy token. A recovery operation creates fresh operation-scoped
credentials under its own authorization rather than retaining broad dormant authority.

Release, forward rollback, maintenance, and domain workflows use one shared GitHub Actions
concurrency group, `capstone-chat-production-app-spec`, with `cancel-in-progress: false`, and one
`mutate-app.mjs` helper. Runtime-secret and registry rotation deliberately remain operator-local so
GitHub never becomes a third plaintext-secret store: the operator freezes those workflows, proves
the checkout equals protected `main`, supplies the freshly reviewed active deployment ID as a
one-use base fence, reads replacement values from an owner-only mode-0600 file, applies the same
mutation helper, and revokes the short-lived update token before unfreezing. A retry with the stale
base is rejected after provider activation. The DigitalOcean control panel is read-only for App
configuration after acceptance; a guided teardown first freezes these workflows. Console commands
and the Uptime control-panel step do not mutate the App spec.

The helper captures a canonical SHA-256 fingerprint of the complete fetched spec, App ID, active
deployment ID, egress pair, and provider update timestamp before planning. Immediately before PUT,
it re-fetches those values and refuses any mismatch; it also refuses while another deployment is
in progress. After submission it fetches again and proves that the resulting live spec equals the
expected prior fingerprint plus only the reviewed patch, then associates the new deployment ID.
DigitalOcean currently documents no atomic ETag/`If-Match` update for this endpoint, so the plan
does not falsely call the API itself compare-and-swap: the shared writer lock prevents authorized
races and the double-read fingerprint detects out-of-band drift. Any control-panel mutation or
unexpected post-submit difference is an incident and blocks further writes rather than being
overwritten again.

The fetched live spec is sensitive operational material even when secret values are provider
encrypted. Tooling disables shell tracing, writes it only to a mode-0600 file in a fresh temporary
directory, installs cleanup for every exit path, and never places it in Actions output, cache, an
artifact, or the repository.

The first private-GHCR credential is handled by the same protected temporary-input boundary even
though there is no live encrypted spec to fetch yet. The bootstrap command accepts it from a
mode-0600 input or secret stream, never a command argument, validates that the submitted spec
contains it only in `image.registry_credentials`, and deletes the plaintext buffer/file on every
exit. Its first post-create read must return an encrypted representation before any further App
mutation is allowed.

The deploy tool refuses:

- a mutable image tag;
- different service and migration digests;
- a digest/OCI-label/runtime-revision/web-revision mismatch;
- missing or changed Dedicated Egress;
- region, size, instance-count, domain, ingress, health, termination, or secret-scope drift;
- a migration failure;
- a readiness failure;
- a non-main revision;
- a historical, equal, or divergent revision presented to the normal deploy entrypoint;
- a protected `main` HEAD that changes between validation and submission;
- a changed live-spec/deployment fingerprint or concurrent in-progress deployment;
- absent required CI evidence; or
- a response that would write a plaintext or encrypted secret into logs or artifacts.

App Platform maintenance restarts of the same digest are platform lifecycle events, not new
Capstone releases. Alerts and evidence distinguish a same-artifact restart from an operator-approved
revision change.

Do not delete the tested GHCR retention safety with the host artifacts. Relocate and narrowly
adapt `deploy/digitalocean/ghcr-retention.py` and its tests into `deploy/app-platform/` before the
old tree is removed. Both phases use the same production concurrency group as deployment so a
release cannot begin between retention revalidation and deletion. The platform version remains a
deliberate two-step protected workflow, not an automatic post-deploy cleanup:

1. query the complete bounded GHCR version inventory;
2. protect the digest from the provider's active serving deployment, the current desired App spec,
   and any in-progress deployment; a mismatch is visible evidence, never a reason to discard one;
3. protect the immediately previous compatible release and five most recent accepted distinct
   digests from successful GitHub production Deployment records explicitly typed `release`,
   cross-checked against exact CI evidence and GHCR full-SHA tags; history-eviction redeployments,
   provider restarts, and failed candidates never enter that release set;
4. protect every recovery-pinned revision from one bounded operator input recovered from the sealed
   Bitwarden kit; missing or conflicting pin authority makes deletion impossible;
5. leave unknown, unaccepted, malformed, or beyond-pagination-bound versions untouched;
6. write a content-free dry-run plan and SHA-256 plan hash, then stop for human review;
7. on a separate authorized delete invocation, re-fetch the live App spec, accepted deployments,
   recovery pins, and GHCR inventory; and
8. delete only if the recomputed plan is byte-for-byte identical and the supplied plan hash
   matches.

The package-delete credential lives only in that protected GitHub environment, has the minimum
current GitHub package permission, and is distinct from the App Platform GHCR pull credential. It
is never installed in DigitalOcean. The refactor preserves the existing plan-hash/TOCTOU tests and
adds App-spec drift, production-deployment drift, recovery-pin drift, pagination, API failure, and
partial-delete evidence cases. Active-serving, desired, in-progress, previous, recent-five, and
recovery-pinned digests remain non-deletable invariants.

### 7. Run migrations as the one pre-deploy job

This section describes every ordinary deployment after first initialization. The temporary
initialization job from section 2 replaces this job for its one provisioning deployment and runs
the same migration operation before any identity or policy write. The final contract contains only
the migration job below.

The job uses the same exact image digest as the candidate service and overrides the command with:

```text
node apps/api/dist/entrypoint.js migrate
```

It has one 512 MiB shared-vCPU instance, one migration connection, direct PlanetScale port 5432,
`verify-full`, the migration role, and a bounded provider deployment timeout. It receives no
runtime application secret.

The job must complete before App Platform begins service replacement. A failed migration leaves
the current release serving. The deployment record captures migration success/failure metadata but
never SQL containing employee content, a connection URL, or a credential.

Expand/contract remains mandatory. Platform rollback changes application code and configuration,
not database state. A destructive migration is never paired with the release that stops using the
old schema.

### 8. Map readiness, liveness, streaming, and termination to App Platform

The proposed App contract uses:

| Control | Value | Purpose |
|---|---:|---|
| Service HTTP port | 3000 | Existing single-origin container port |
| Readiness path | `/api/health/ready` | DB and runtime-policy readiness; removes new traffic |
| Readiness initial delay | 5 seconds | Allow process initialization |
| Readiness period / timeout | 10 / 3 seconds | Bounded route eligibility |
| Readiness success / failure threshold | 2 / 3 | Avoid one-sample activation or removal |
| Liveness path | `/api/health/live` | Process-only health; no external dependency |
| Liveness initial delay | 15 seconds | Avoid startup restart loops |
| Liveness period / timeout | 10 / 3 seconds | Detect a genuinely stuck process |
| Liveness failure threshold | 18 | Do not restart a stream for a brief pressure event |
| Platform edge drain | 110 seconds | Maximum no-new-traffic period before `SIGTERM` |
| Post-`SIGTERM` grace | 300 seconds | Contains the existing bounded application shutdown |

The current application shutdown maximum remains below 300 seconds: ordinary work drains first,
active streams receive their approved 240-second grace, remaining streams become durable
incomplete responses, provider work is aborted, and database/telemetry resources close boundedly.
Tests must derive the platform value from the same shutdown-budget contract rather than duplicating
an unexplained number.

Documentation is not proof that the managed edge preserves streaming. The managed rehearsal must
verify:

- `application/x-ndjson` arrives incrementally without buffering or transformation;
- edge HTTP/2 or HTTP/3 to browser and HTTP/1.1 to the container preserves event boundaries;
- the 15-second heartbeat crosses the edge during a quiet provider interval;
- a stream can remain connected through the application's five-minute generation ceiling;
- the browser's 35-second silence recovery still works on truncation;
- Stop and browser disconnect propagate to Fastify and OpenRouter cancellation;
- a slow reader remains bounded and cannot exhaust process memory;
- completion is emitted only after durable persistence;
- an active-stream deployment either completes safely during drain or is cancelled into canonical
  durable partial output; and
- `SIGKILL` after a deliberately stalled shutdown is reconciled without duplicate work, leaked
  reservations, or false completion.

### 9. Use the managed edge without weakening one-origin security

`chat.capstone.com.ec` remains the only product origin. The final App spec marks it primary,
requires at least TLS 1.2, and redirects the provider starter domain to the primary origin. The DNS
record is DNS-only; no separately configured CDN or proxy is placed in front of App Platform.

The final domain contract is exact:

- the App spec contains `domain: chat.capstone.com.ec`, `type: PRIMARY`, and
  `minimum_tls_version: "1.2"`, with no `zone` because Hostinger remains DNS authority;
- Hostinger publishes a CNAME from `chat` to the current `.ondigitalocean.app` target displayed by
  the provider, never to an assumed or copied historical target;
- the updater preserves the provider-managed `DEFAULT` starter domain returned by the live spec;
- an authority-specific ingress rule issues an HTTPS 308 redirect from exactly that starter domain
  to `chat.capstone.com.ec`; it omits a replacement URI so the original path and query survive; and
- no wildcard, secondary product domain, or alternate authenticated origin is accepted.

A planning-only `dig` observation on 2026-08-11 returned no `DS`, `DNSKEY`, or `CAA` record for
`capstone.com.ec` and no existing `chat` CNAME/A record. That is not launch evidence. Immediately
before attachment, query the authoritative DNS and parent delegation again. App Platform does not
support attaching a DNSSEC-enabled domain: if DNSSEC is then enabled, stop for a separate explicit
security/provider decision and never disable it silently. If any CAA record exists, it must permit
both `letsencrypt.org` and `pki.goog`; otherwise certificate activation is blocked until the owner
approves the exact DNS correction.

The application continues to provide HSTS, CSP, origin checks, JSON-only mutation checks, secure
cookies, no-store API responses, immutable fingerprinted asset caching, and a short-lived SPA shell.
App Platform edge caching and email obfuscation are disabled to avoid transforming authenticated
HTML or NDJSON. Enhanced threat control remains off until measured because it must not silently
change authentication, cancellation, or streaming semantics.

Acceptance verifies:

- HTTP redirects to the primary HTTPS origin;
- the starter domain cannot establish an independent authenticated origin;
- custom TLS issuance, renewal status, minimum protocol, HSTS, and certificate chain;
- asset and HTML cache policy;
- API and NDJSON no-store/no-transform behavior;
- exact Host/Origin/cookie/CSRF behavior;
- no public route bypasses managed ingress; and
- DigitalOcean's current Cloudflare-backed edge and subprocessor posture is recorded in the
  production privacy/vendor inventory.

The domain is not attached to an App that is about to be deleted. Planned replacement detaches the
custom domain and verifies provider release before deleting the old App. Accidental deletion while
the domain remains attached can make DigitalOcean retain the binding for up to 24 hours, which is
outside the controlled four-hour RTO. On August 12, 2026, the owner approved a best-effort maximum
24-hour exception for only that accidental-deletion failure mode; it is recorded separately from
controlled recovery evidence.

### 10. Preserve the PlanetScale network and role boundary

After Dedicated Egress assigns two addresses:

- create PlanetScale restrictions for `address-a/32,address-b/32`;
- scope application access to the application role and migration access to the migration role;
- retain separate credentials and verify the runtime role cannot run DDL/admin operations;
- keep direct port 5432 and `verify-full` TLS;
- force new connections after every allowlist or credential change;
- allowlist both provider-assigned addresses before either the service or job receives a database
  credential;
- prove an unrelated public source cannot connect even with the correct hostname;
- force repeated fresh service and job connections and verify stable operation across provider
  egress selection; and
- verify ordinary spec updates and rolling deployments do not release or replace the pair.

App Platform does not expose a control that selects which member of the pair a connection uses.
If PlanetScale connection/audit evidence or a DigitalOcean diagnostic identifies the source
address, qualification must observe and record each `/32`. If neither provider exposes that
evidence, acceptance records the pair as a provider-contract-based control and the repeated
fresh-session result; it does not claim deterministic one-by-one proof. Deliberately removing one
allowlist entry in production is prohibited because it would create nondeterministic failures
rather than a safe negative test.

The deployment tool treats omission or change of `egress.type: DEDICATED_IP` as a destructive
operation and refuses it. Replacing or destroying the App necessarily assigns a fresh pair and
requires an explicit recovery/cutover sequence.

The managed qualification applies every migration, verifies `unaccent`, search, budget locking,
prepared statements, direct-session timeout options, role separation, connection limits, pool
release, reconnect behavior, and critical query plans on the exact PS-5 candidate. The existing
pool maximum remains unchanged unless measurements demonstrate a problem and a separate focused
change is reviewed.

### 11. Replace Fluent Bit with a bounded New Relic log mirror

App Platform cannot run the approved host Fluent Bit process and does not natively forward to New
Relic. Adding Better Stack, Datadog, or OpenSearch merely for logs would add a second external
telemetry backend. Instead, add one small adapter inside `apps/api` using existing Node HTTPS/fetch
capabilities and no new dependency.

The adapter:

- mirrors Pino records to stdout for App Platform live/crash visibility;
- forwards only an explicit allowlist of content-free fields to the fixed New Relic Log API;
- discards unknown fields before enqueueing;
- never accepts prompts, responses, drafts, summaries, raw provider payloads, URLs, arbitrary
  browser errors, stack traces, headers, cookies, or secrets;
- has one bounded in-memory queue by both record count and bytes;
- has one bounded batch size, flush interval, request timeout, and retry count;
- uses no disk, filesystem spool, worker deployment, sidecar, or unbounded timer;
- drops telemetry on overflow or sustained outage rather than blocking product requests;
- is not part of readiness after valid startup configuration;
- shares the already parsed New Relic license key without logging or duplicating it; and
- participates in the existing bounded telemetry shutdown budget.

The first implementation uses recorded constants rather than open-ended tuning:

| Bound | Value |
|---|---:|
| Maximum serialized allowlisted record | 2,048 UTF-8 bytes |
| Queue capacity | 1,024 records or 1 MiB, whichever is reached first |
| Batch capacity | 64 records or 128 KiB, whichever is reached first |
| Flush interval | 1 second |
| Concurrent Log API requests | 1 |
| Request timeout | 3 seconds |
| Delivery attempts | 3 total, with bounded 250 ms then 1 second backoff |
| Shutdown flush budget | 5 seconds inside the existing telemetry shutdown budget |

An oversize record is rejected before enqueueing. On queue pressure, the adapter drops the oldest
record first so the bounded window retains the most recent incident context, increments a
content-free dropped-record metric, and never recursively logs that metric through the mirror.
There is no promise of lossless delivery; stdout/App Platform crash visibility remains the local
fallback.

Tests cover field allowlisting, hostile strings, exact byte/count limits, overflow, batching,
timeouts, retry exhaustion, New Relic failure, shutdown, and secret/content scans. A real managed
rehearsal proves delivery, alerting, outage behavior, and absence of employee content. App Platform
native runtime/crash logs are sampled separately for the same privacy rule.

App Platform Insights replaces Droplet host metrics. PlanetScale remains the protected database
metrics/Query Insights source. New Relic continues traces, application metrics, and retained
allowlisted application logs. No proprietary New Relic agent, browser agent, infrastructure agent,
collector, or second telemetry backend is added.

### 12. Make rollback and database-authority changes explicit

Ordinary application rollback is a reviewed forward deployment of the immediately previous
compatible image through the **current** live spec:

1. identify the prior revision and exact GHCR digest from accepted release evidence;
2. verify the image, current schema compatibility, and current database authority;
3. fetch and validate the current live spec without printing it;
4. preserve the current egress pair, domains, encrypted variables, and every other locked field;
5. patch only the service/job digest to the prior artifact;
6. submit that change as a new deployment and observe the idempotent pre-deploy migration and
   readiness-gated replacement;
7. verify public readiness, exact revision, authentication, chat, Stop, and telemetry; and
8. record safe evidence.

DigitalOcean's retained deployment history may be inspected as discovery evidence, but its native
rollback action is prohibited in every production operator workflow because it can rewind
configuration and encrypted secrets together with code. The action is invoked only as an
explicitly isolated negative rehearsal of stale-initialization safety. Retention of ten provider
deployments therefore does not define Capstone's rollback window; the exact current and
immediately previous compatible GHCR digests do.

Rollback is never automatic. It does not reverse a database migration and cannot cross an
incompatible schema.

A database-authority cutover uses a different recovery flow because App Platform may overlap old
and new containers:

1. enable provider maintenance at the edge to reject new employee traffic;
2. drain or terminate current application work and prove zero active generations;
3. revoke the old application role or remove its IP authorization so an old deployment cannot
   write;
4. prepare and verify the isolated restored branch with the migration and application roles;
5. update component-scoped encrypted database secrets without exposing them;
6. deploy through the migration/readiness path;
7. prove exactly one new database authority receives writes;
8. disable maintenance only after complete smoke and integrity checks; and
9. mark every retained deployment using the old authority as non-rollbackable.

After an authority cutover, every native provider rollback remains prohibited. Revoked credentials
make an accidental stale deployment fail readiness, and recovery proceeds only by a reviewed
forward deployment from the current spec.

### 13. Rebuild recovery around an ephemeral platform

App Platform contains no authoritative application data and no persistent secret file. Recovery
sources are:

- the Git repository and accepted app contract;
- the exact current and immediately previous compatible GHCR digests;
- Bitwarden source credentials and recovery material;
- PlanetScale backups/PITR and provider configuration evidence; and
- DNS/provider ownership with MFA and recovery access.

Controlled cold recreation must fit the four-hour RTO and follows section 2's initialized-database
recreation sequence, never its empty-database initialization path. Because destroying an App
releases its egress addresses, the rehearsal allocates a fresh pair, updates PlanetScale
restrictions, forces reconnects, restores only steady encrypted variables, deploys the exact
digest, and reassigns a temporary custom domain. It records the domain transfer behavior, proves no
initialization document/job or initial invitation was used, and does not assume the old pair can be
recovered.

For a planned replacement, preserve the current App ID whenever possible. If replacement truly
requires a new App, first enable maintenance, detach `chat.capstone.com.ec` from the old App, verify
that DigitalOcean has released the binding, attach it to the verified replacement, and only then
delete the old App. The recovery rehearsal must prove that controlled sequence inside four hours.

That proof does not cover accidental App deletion while the domain is still attached. DigitalOcean
documents that the binding can persist for up to 24 hours, so the current provider contract cannot
honestly guarantee the controlled four-hour RTO for that failure mode. The owner approved a
best-effort maximum 24-hour exception on August 12, 2026 while retaining the four-hour objective
for every controlled recovery. The restricted steady deploy token and short-lived delete authority
materially reduce the probability; any actual exception remains separately reported.

The PITR rehearsal still restores into an isolated PlanetScale branch, applies extensions and
settings explicitly, uses separate roles, verifies every migration and integrity query, and leaves
the source untouched. Temporary branch, App, domain, credential, and egress resources are removed
only after evidence is accepted and cleanup is authorized.

### 14. Replace audits and runbooks, then retire the Droplet path

Update `scripts/operations-audit.mjs` so the active provider contract asserts:

- exactly one service and one `PRE_DEPLOY` job;
- exact region, sizes, instance count, port, health, termination, edge, domain, and egress settings;
- exact custom-domain object, preserved provider `DEFAULT` domain, authority-specific 308 redirect,
  and absence of an App-managed DNS zone;
- no autoscaling, scale-to-zero, VPC, function, worker, persistent volume, or second service;
- exact-digest service/job equality and image-owned deployment revision;
- component-scoped secret key sets and no values in the repository;
- the App Platform client-address mode and 0.0.0.0 production bind;
- the bounded direct New Relic log path and absence of Fluent Bit;
- explicit migration-before-rollout and rollback checks;
- current-main strict-forward deployment ancestry, one shared non-cancelling spec-writer group, and
  pre/post live-fingerprint checks;
- relocated GHCR retention protection/plan-hash/TOCTOU checks before host artifact deletion;
- PlanetScale two-address restrictions and role instructions;
- the split between App Platform Insights/alerts and one independent DigitalOcean Uptime check;
- no active Render or Droplet operator reference; and
- historical plans labeled non-operative.

Rewrite the nine operations documents around App Platform:

- `provision-and-deploy.md` — bootstrap contract, egress pair, PlanetScale restrictions, encrypted
  variables, revocable initialization roles/key, durable latch, exact image, first deploy,
  identity/policy bootstrap, post-readiness invitation, and smoke;
- `deploy-and-rollback.md` — protected exact-digest deploy, pre-deploy migration, readiness,
  termination, rollback, unsafe-history eviction, GHCR retention, and evidence;
- `database-recovery.md` — 12-hour/84-hour PITR, restored-branch preparation, maintenance fence,
  authority cutover, fresh egress pair, RPO/RTO, and cold App recreation;
- `domain-and-tls.md` — authoritative DNSSEC/CAA preflight, DNS-only mapping, exact
  primary/CNAME/starter redirect, managed TLS, HSTS, edge settings, privacy/subprocessor
  acceptance, planned detach-before-delete, stream verification, and recovery;
- `secret-rotation.md` — Bitwarden, App Platform encrypted variables, service/job scope, GHCR,
  DigitalOcean, PlanetScale, New Relic, Resend, OpenRouter, and Better Auth;
- `incident-response.md` — App Platform deploy/health/Insights/logs, PlanetScale, New Relic,
  Resend, OpenRouter, maintenance, rollback, and platform/provider incidents;
- `providers-and-budget.md` — unchanged model/budget rules plus App Platform and PlanetScale cost
  control planes, team-pooled bandwidth review, Dedicated Egress, and Uptime allowance/overage;
- `employee-access.md` — preserve application authorization and define safe initial operator
  commands without SSH; and
- `README.md` — active authority, ownership, evidence rules, and external-action boundary.

After the new path passes repository review, remove obsolete host artifacts and host-only scripts.
Do not preserve them as a “fallback” that CI no longer exercises. The prior amendment document and
Git history are the recovery record for that design.

The disposable Droplet cleanup is an external destructive action and remains separately gated. Its
runbook must confirm no authoritative data or production credential was installed, lock root,
close the recovery console, delete the temporary root-password Bitwarden item, destroy the Volume,
reserved IP, Droplet, firewall, and tag in a safe order, and verify no continuing charge.

### 15. Keep first initialization and later operator work narrow without SSH

First initialization uses the temporary pre-deploy job from section 2, not a service console. This
is required because the production service correctly remains unready until a compatible model
policy exists. The initialization entrypoint reads one at-most-32-KiB schema-validated document,
runs migrations, checks the durable document-hash latch before provider work, performs the
database-only identity bootstrap, closes its pool, fetches the catalog, then performs policy
bootstrap and marks completion. It can resume after any completed phase without duplicating a
workspace, authorization, catalog approval, or policy. It distinguishes an exact safe repeat from
conflicting canonical input and fails closed on conflict. It cannot send email.

After the final exact service is ready, the first bounded console operation sends the initial
administrator invitation from the already committed approval using the final application role,
Better Auth secret, origin, sender, and Resend key. The command re-resolves the canonical approval,
never creates or changes authority, accepts its at-most-32-KiB input through standard input, and
reports the existing content-free sent/retry-safe outcome. An ambiguous provider timeout may still
produce the already documented duplicate-email possibility; it cannot duplicate approval or
membership authority. The invitation is never sent while the product origin returns bootstrap
404s.

Thereafter App Platform's component console may be used only for a rare existing application-role
command that the administrator UI does not own, such as privacy re-attestation. It is not a
deployment path and no durable state may depend on its ephemeral filesystem. Before opening it,
the helper resolves one current instance and verifies its deployment ID, exact image digest,
image-owned revision, non-root user, readiness, and database authority. It disables local shell
history/tracing, accepts any bounded document through standard input, and records only the existing
content-free result.

Normal employee and model-policy administration remains in the authenticated administrator UI.
The service console never receives the migration or recovery credential and cannot run DDL.
Migration stays in the steady `PRE_DEPLOY` job. PITR preparation and authority cutover use a
separately authorized, isolated recovery App or bounded operator environment with exact temporary
PlanetScale `/32` access; they do not widen the production service role or install a permanent
operator component.

## File-level implementation map

The final implementation should remain narrow. Expected paths are:

| Area | Expected action |
|---|---|
| `docs/prd/README.md`, PRD 02, PRD 06 | Record only the approved hosting amendments |
| Phase 8 implementation records | Add supersession pointers; retain historical evidence |
| `deploy/app-platform/*` | Add digest-free non-secret contract, bootstrap, exact-input renderer, deploy, rollback, drift audit, relocated GHCR retention planner/tests, fixtures, and operator README |
| `deploy/digitalocean/*` | Delete only after every still-required provider-independent safety, especially GHCR retention, is relocated and reviewed |
| `apps/api/src/config.ts` | Add exact deployment target, platform secret source, host, and client-address validation |
| `apps/api/src/security/client-address.ts` | Add strict `do-connecting-ip` capture and retire Caddy production authority |
| `apps/api/src/secret-environment.ts` | Limit file mode to a real offline-recovery use or remove it |
| `apps/api/src/observability/*` | Add the bounded content-free New Relic log mirror |
| `apps/api/src/database/*`, next migration | Add the singleton initialization document-hash/phase latch without storing its PII input |
| `apps/api/src/operator/*` | Add the ordered latched initialization command, the post-readiness initial-invitation command, and bounded document input for later console-only operations; preserve existing services and content-free results |
| `apps/api/src/entrypoint.ts` | Add only the runtime-secret-free egress-bootstrap and temporary initialization targets required by the accepted contracts |
| `apps/api/Dockerfile` | Preserve one non-root AMD64 artifact, bake its validated revision into the runtime environment, and remove active Caddy defaults |
| `.github/workflows/ci.yml` | Preserve image publication and add exact App contract/image checks |
| `.github/workflows/deploy-production.yml` | Add protected strict-forward deploy, rollback, and shared serialized App-spec mutation entrypoints |
| `.github/workflows/ghcr-retention.yml` | Add separate protected dry-run/delete invocations for the relocated retention planner |
| `scripts/operations-audit.mjs` | Replace host assertions with App Platform assertions and self-tests |
| `scripts/container-smoke.mjs` | Exercise the new production environment contract without leaking secrets |
| `.env.example` | Document names and non-secret modes only |
| `docs/operations/*.md` | Replace host operations with managed-platform operations |
| `README.md` | Describe the one active deployment path and current costs |

If implementation reveals that an expected file is unnecessary, omit it rather than creating an
empty abstraction. Do not combine the provider migration with unrelated application refactoring.

## Implementation sequence

1. Freeze the exact clean baseline and re-run repository/operations gates before editing.
2. Add failing configuration, client-address, secret-source, app-contract, and deploy-tool tests.
3. Implement the App Platform runtime configuration and strict client-address source.
4. Implement or remove the secret-file seam so one active production source remains.
5. Add the bounded New Relic log mirror and privacy/outage tests.
6. Add the egress-bootstrap entrypoint and its negative product-route tests.
7. Add the non-secret App Platform contracts and live-spec fixture validator.
8. Add exact-digest deploy/rollback tooling with destructive-egress and secret-leak guards.
9. Add the protected deployment workflow without installing a live token.
10. Relocate and adapt the GHCR retention planner/tests with App/GitHub/recovery-pin authority and
    the existing plan-hash/TOCTOU boundary.
11. Update container smoke, repository audit, operations audit, and CI.
12. Add the initialization latch/migration, ordered temporary initialization entrypoint,
    post-readiness invitation command, later console document seam, and their
    idempotency/privacy/replay tests.
13. Amend authority docs and rewrite every active operations runbook.
14. Delete the active Droplet host artifacts only after the retention replacement is verified, and
    prove no runbook/script still references them.
15. Run the complete local gate and an independent no-P1/P2 repository review.
16. Stop and request separate authorization for a disposable App Platform/PlanetScale rehearsal.
17. Run the managed network, load, stream, deploy, rollback, secret, and recovery gates twice where
    required.
18. Record rehearsal evidence honestly and stop for managed-rehearsal acceptance plus separate
    authorization to begin the production launch checklist. This is not candidate acceptance.
19. Only after that production authorization, provision production, configure DNS/secrets,
    bootstrap identity/policy, run the paid smoke, complete every manual production gate, and stop
    for the final no-P1/P2 review and candidate/launch acceptance.

No ordinary `pnpm` command, test, CI pull-request workflow, or local smoke may create, mutate, or
delete a DigitalOcean, PlanetScale, DNS, New Relic, Resend, OpenRouter, GitHub, or Bitwarden
resource.

## Required automated verification

### Configuration and security

- Production starts only with the exact App Platform target, platform-environment secret source,
  `0.0.0.0`, port 3000, approved origin, real providers, full revision, and production web assets.
- Missing, mixed, duplicated, direct/file, fake-provider, non-TLS, non-`verify-full`, non-DNS-host,
  wrong-origin, wrong-sender, wrong-OTLP, or mutable-revision configurations fail before readiness.
- Migration configuration accepts only its database secret and never loads runtime provider keys.
- Service configuration never loads the migration or recovery credential.
- `do-connecting-ip` IPv4/IPv6 normalization and every invalid/multiple case are covered; missing
  succeeds only for the two health routes and fails closed everywhere else.
- All forwarded headers are removed before routes/auth/rate limiting observe the request.
- Caddy is no longer an accepted production client-address source.

### App contract and deployment

- Contract parsing asserts exact topology, region, sizes, count, no autoscaling/VPC/extra
  components, port, ingress, exact primary/default-domain handling, edge, health, termination, and
  egress.
- The source contract contains no digest or release placeholder; rendering requires one verified
  exact digest/full revision and refuses mutable or missing inputs.
- Bootstrap mode exposes health only, contains no runtime environment secret, places the required
  GHCR pull credential only in the image source, and is rejected by final live validation.
- Service and job always use the same immutable digest and image-owned full revision; the App spec
  cannot override `DEPLOYMENT_REVISION`.
- Deployment fixtures prove encrypted values are preserved but never printed or committed.
- First-create fixtures prove plaintext GHCR input exists only transiently in
  `image.registry_credentials`; later fixtures require a preserved encrypted value on every
  image-bearing component and cover per-field first submission plus rotation.
- Omission/change of Dedicated Egress, secret scope, or another locked field fails before update.
- Migration failure, readiness failure, provider failure, timeout, and partial API response fail
  closed and retain safe evidence.
- Rollback accepts only the immediately previous compatible accepted image on the current database
  authority and patches it through the current live spec.
- Normal deploy accepts only the current protected `main` HEAD as a strict descendant of the active
  release; fixtures reject old, equal, divergent, and head-moved candidates, while same-digest
  history eviction cannot change the spec.
- Every App-spec workflow declares the same non-cancelling concurrency group; mutation fixtures
  cover queued writers, in-progress deployments, pre-submit fingerprint drift, unexpected
  post-submit state, and prohibited uncoordinated control-panel edits.
- No deploy path uses mutable tags, auto-deploy, latest-source rebuild, or unchecked control-panel
  state.
- Temporary initialization runs migration, latch, identity, catalog, and policy in exact order;
  injected failures after every phase prove an exact retry is idempotent, a conflicting hash fails
  before provider work, and the final spec contains no initialization job or variable.
- Tests prove the job cannot load Better Auth, Resend, New Relic, or final database credentials;
  historical replay after bootstrap-role/key revocation and latch completion cannot mutate state.
- Unsafe pre-egress and initialization deployments are identifiable by structure, and final live
  validation reports failure until neither remains in the provider's rollbackable history.
- GHCR retention fixtures protect active-serving, desired, in-progress, previous, recent-five, and
  recovery-pinned digests; leave unknown versions untouched; and reject deletion after App spec,
  deployment evidence, pin, or package-inventory drift from the approved plan hash.
- The post-readiness invitation and every later console-only operator command reject the wrong
  deployment or instance, accept only bounded stdin input, and emit only content-free evidence.

### Observability and privacy

- Log mirror allowlists fields and rejects/drops unknown or content-bearing data.
- Queue record/byte limits, batch limits, request timeout, retry count, overflow, outage, and shutdown
  are deterministic.
- Telemetry failure cannot fail readiness or block an application response.
- Secrets, prompts, responses, drafts, summaries, raw provider payloads, browser stacks, and URLs are
  absent from stdout, mirrored logs, traces, metrics, fixtures, and evidence.
- Health success remains metric-only and does not create a trace; failures remain observable.

### Database, migration, lifecycle, and streams

- Every migration applies to an empty PostgreSQL 18 database and remains in the image.
- Application and migration role boundaries remain integration-tested.
- PRE_DEPLOY command exits nonzero on migration/config failure.
- First initialization never holds a database connection across the OpenRouter catalog wait and
  cannot send email. A post-readiness invitation retry cannot duplicate authority even if Resend's
  delivery outcome is ambiguous.
- Readiness rejects starting, unhealthy, and draining replicas; liveness remains DB-independent.
- Shutdown budget remains strictly below the 300-second App Platform grace.
- Real-listener tests cover NDJSON, heartbeat, backpressure, disconnect, Stop, terminal persistence,
  forced interruption, and canonical incomplete recovery.
- Reconciliation, reservation settlement, and pool release remain correct after forced shutdown.

### Full repository gate

Run at minimum:

```text
pnpm check
pnpm verify:repository
pnpm verify:operations
pnpm typecheck
pnpm test
pnpm build
pnpm report:bundle
pnpm test:e2e
git diff --check
```

Also build the production image, verify non-root UID/revision/runtime contents/migrations/no source
maps/no test files/no `.env*` files, run the production container smoke, inspect the Docker build
context for ignored secrets/artifacts, run the production dependency audit, and validate every
source-controlled App contract fixture. Literal `pnpm check` must be reported honestly if the known
globally ignored local `.claude/settings.local.json` remains the only unrelated failure.

## Disposable managed rehearsal

Repository completion is necessary but insufficient. A fresh authorization must name:

- one temporary App Platform App in `ric` using the exact one-GiB service, the transient 512 MiB
  initialization job, and the final 512 MiB migration job;
- Dedicated Egress with its two temporary exclusive addresses;
- one temporary PS-5 Single Node database/branch in AWS `us-east-1` with no production data;
- one temporary custom rehearsal hostname;
- exact GHCR digest and temporary read/deploy credentials;
- fake model gateway, disabled/fake email, synthetic `.test` identities, and content-free rehearsal
  telemetry;
- an external load generator that does not consume candidate service capacity;
- a temporary least-privilege PlanetScale load-operator role, provider-enforced 24-hour TTL, and
  only the named external generator IPv4 `/32` for the bounded load window;
- maximum prorated provider spend and maximum lifetime; and
- mandatory cleanup after evidence review.

Production mode and the final origin continue rejecting fake providers. The rehearsal uses the
existing explicit non-production managed-test boundary; it does not install OpenRouter, Resend, or
production identity secrets.

The load-operator URL is generator-only and is absent from every App spec and component
environment. The generator also receives one temporary rehearsal-only
`CAPSTONE_LOAD_AUTH_SECRET` equal to the rehearsal service's `BETTER_AUTH_SECRET`, solely to create
synthetic `.test` sessions; no production or reusable identity secret is permitted. Preserve denial
from the generator before role/restriction creation, success only
from the named generator during the window, and denial from an unrelated source during the same
window. Cleanup first terminates the generator and force-closes its database pool because
restriction changes affect only new sessions; it then erases the generator auth-secret environment,
explicitly revokes/deletes the role despite its TTL, removes the generator `/32`, removes or rotates
the rehearsal service auth secret during teardown, and proves denial again. Any failure in those
cleanup or post-cleanup checks fails the rehearsal and stays prominent rather than being waived.

### Managed network and platform qualification

Prove:

- live `ric` availability and exact resource/pricing lines;
- successful bootstrap deployment with no runtime secret and exactly one protected private-GHCR
  image credential, followed by verification of its encrypted live representation;
- allocation and persistence of two exclusive egress addresses;
- both `/32`s present in PlanetScale restrictions, stable repeated fresh connections, source-IP
  evidence for each address when either provider exposes it, and denial from an unrelated source;
- direct 5432, `verify-full`, DNS hostname, role separation, pool limits, session timeouts, and
  forced reconnect after restriction changes;
- exact-image GHCR pull, revision/digest identity, retention, and credential rotation;
- a GHCR retention dry run protecting active/previous/recent-five/recovery pins and a disposable
  candidate deletion whose plan-hash revalidation fails after injected authority drift;
- ordered temporary initialization, latch/hash conflict behavior, retry after each injected phase
  failure, successful removal of all initialization-only configuration, bootstrap-credential
  revocation, and safe attempted replay of the retained historical initialization deployment;
- explicit rollback to the pre-egress bootstrap deployment, recording whether the platform blocks
  it, preserves egress, or releases/replaces the pair; restoration after the negative test; and
  verified eviction of every unsafe bootstrap-era deployment from rollbackable history using only
  exact-final-spec redeployments;
- a post-readiness fake/disabled invitation operation and later bounded application-role console
  operation with no persistent file, migration/recovery credential, input echo, or PII/provider
  payload in logs;
- exact custom domain/CNAME/primary/default-domain redirect, managed TLS, DNSSEC/CAA preflight,
  HSTS, cache/transform settings, header-optional health probes, and non-health real client IP;
- encrypted variable scope and absence from build/deploy/runtime/crash logs;
- App Platform Insights/alerts, one DigitalOcean Uptime check, New Relic OTLP, direct log mirror,
  and telemetry-outage behavior;
  and
- no SSH, host, Volume, Caddy, systemd, or Fluent Bit dependency.

### Managed capacity qualification

Run two clean final repetitions of the unchanged 20-employee/40-stream workload after warm-up.
Each run exercises:

- 20 registered and simultaneously signed-in synthetic employees;
- 40 active streams, ordinary APIs, administration, cancellation, slow readers, deterministic
  failures, compaction, reconciliation, and ownership canaries;
- the one-GiB service container and exact PS-5 database;
- response-start, API, cancellation, first-delta, event-loop, CPU, memory, pool, database, and
  cleanup measurements; and
- post-idle heap/RSS, active work, reservations, pool release, malformed events, unexpected 5xx,
  and cross-employee leakage gates.

A failed measured wave fails the repetition. Do not average it away. Prior local, Render, Starter,
Standard, or Droplet results do not count as either App Platform pass.

The external harness connects through only the temporary load-operator role. Its privileges are
the smallest set demonstrated by the source-controlled fixture creation, state inspection,
advisory-lock challenge, and reservation reconciliation paths; it receives no DDL, role,
restriction, branch, backup, or production-database authority. Create it with PlanetScale's
user-defined role TTL (`pscale role create ... --ttl 24h`) as defense in depth, while still
performing the explicit revocation, `/32` removal, forced connection closure, and final denial
proof above.

### Streaming and deployment qualification

Exercise through public managed TLS:

- an ordinary incremental NDJSON response;
- a quiet stream with repeated 15-second heartbeats;
- a held-open stream through the five-minute application ceiling;
- the 35-second browser watchdog after deliberate truncation;
- Stop, network disconnect, slow-reader backpressure, and canonical partial recovery;
- deploy during a healthy long stream;
- deploy during a stalled stream requiring bounded cancellation;
- migration failure before replacement;
- candidate readiness failure while the old release remains live;
- forced termination at the platform grace boundary;
- immediately previous compatible rollback; and
- same-digest provider restart distinguished from a new release.

Evidence includes only identifiers, revisions, digests, statuses, durations, counts, safe resource
measurements, and sanitized errors.

### Recovery qualification

After the 84-hour backup policy has aged fully:

- restore to an isolated PlanetScale branch;
- recreate extensions, settings, roles, and restrictions explicitly;
- verify PITR window, observed RPO, migrations, search, constraints, integrity, and application
  behavior;
- enable maintenance and prove old authority is fenced before cutover;
- cold-create a temporary App from the bootstrap contract;
- allocate a fresh egress pair and replace allowlist rules;
- recover provider-encrypted variables from Bitwarden source copies;
- deploy the exact digest and migration job;
- prove the completed latch and existing administrator/policy are verified without an initialization
  document, initialization job, bootstrap provider key, or invitation;
- detach and verify release of a temporary domain before replacement, reattach it, run smoke, and
  measure the controlled end-to-end RTO;
- prove old credentials/deployments cannot write; and
- destroy temporary recovery resources after explicit cleanup authorization.

The production database remains untouched throughout the isolated rehearsal.

## Production launch checklist boundary

The managed rehearsal does not authorize launch. After repository acceptance and rehearsal
acceptance, production still requires a guided, separately authorized checklist covering:

1. current provider contracts, DPA/subprocessors/retention/privacy terms, estimates, team-pooled
   bandwidth, Uptime allowance, billing alerts, spend caps, and ownership;
2. dedicated DigitalOcean team, exact steady and operation-scoped token permissions, private-GHCR
   source/encrypted credential rotation, PlanetScale, GitHub, Bitwarden, DNS, New Relic, Resend,
   and OpenRouter MFA/recovery;
3. App creation, egress pair, PlanetScale steady and revocable bootstrap roles/restrictions,
   backups, and storage ceiling;
4. encrypted component variables and exact GHCR/deployment credentials;
5. exact-image first deploy, Dedicated Egress activation, latched identity/policy bootstrap,
   bootstrap credential revocation, readiness, post-readiness invitation, unsafe-history eviction,
   historical-replay safety, and forward-rollback evidence;
6. production DNS, custom TLS, starter redirect, HSTS, origin/cookie/CSRF/client-IP tests;
7. Resend domain and real invitation/verification/reset delivery;
8. New Relic traces/metrics/logs and App Platform/PlanetScale alert delivery;
9. the separately authorized smallest OpenRouter three-tier privacy/accounting smoke;
10. Ecuador broadband latency and current Chrome, Edge, Firefox, Safari, iOS Safari, and Android
    Chrome checks;
11. keyboard, VoiceOver/screen-reader, zoom, reduced-motion, and responsive acceptance;
12. aged PITR and controlled cold App recreation evidence within RPO/RTO, with accidental domain-
    binding deletion measured separately against the approved maximum 24-hour exception;
13. final secret/content sampling and incident/rotation/on-call review;
14. explicit sign-off on one-instance, single-node, one-Bitwarden-owner risks; and
15. final no-P1/P2 review before candidate acceptance.

## Failure response and escape hatches

No resource changes automatically when a gate fails.

| Measured bottleneck or contract failure | Proposed next action | Approximate base effect before variables |
|---|---|---:|
| Service memory only | Consider `apps-s-1vcpu-2gb` after evidence and approval | Service USD 25; infrastructure about USD 55 |
| Shared-CPU latency/noisy neighbor | Consider `apps-d-1vcpu-1gb` after evidence and approval | Service USD 34; infrastructure about USD 64 |
| PlanetScale CPU/RAM | Consider PS-10 ARM Single Node after evidence and approval | Infrastructure about USD 45 |
| Both service and database | Combine only the measured changes after approval | Recalculate live |
| App Platform header is spoofable | Fail the candidate and select a new trusted edge; do not use XFF fallback | New decision required |
| Managed edge buffers/truncates five-minute NDJSON | Fail the candidate or obtain a documented provider configuration | New decision required |
| New Relic log mirror is unsafe or destabilizing | Stop for explicit native-no-retention or second-provider decision | New decision required |
| Dedicated Egress cannot be preserved safely | Fail closed; never remove PlanetScale restrictions silently | New decision required |
| Cloudflare/DigitalOcean processing terms fail the privacy review | Reject App Platform; do not claim container-terminated TLS | New provider decision required |
| DNSSEC is enabled and must remain enabled | Reject the App Platform domain attachment or explicitly select a different edge; never silently disable DNSSEC | New decision required |
| Accidental App deletion cannot release the domain inside four hours | Use the approved best-effort maximum 24-hour exception only for this failure mode; preserve four hours for controlled recovery | Approved 2026-08-12 |
| App Platform cannot meet migration/drain/rollback contract | Return to provider selection with evidence | New decision required |

The 512 MiB service is not an automatic downgrade. Autoscaling and a second instance are not
automatic fixes. Every steady-state cost or availability change requires an explicit decision and
fresh evidence.

## Risk register

| Risk | Required response |
|---|---|
| Dedicated Egress adds USD 25/month | Record the honest USD 44–45 operational base and billing alert; do not call this the old USD 15 plan |
| Team-pooled transfer or Uptime pricing adds overage | Keep the DigitalOcean team dedicated, inspect the whole-team bill monthly, and alert on current allowance/overage |
| Spec update omits egress and permanently releases both IPs | Fetch/validate/patch the live spec; hard-fail before submission; rehearse negative case |
| Native rollback selects the successful pre-egress bootstrap spec | Rehearse the destructive behavior, restore safely, evict every unsafe spec from the ten rollbackable deployments, and install the steady update token only after the hard history gate |
| PlanetScale alternates between two egress addresses without a selector | Allowlist both exact `/32`s, force repeated fresh connections, use provider source evidence when available, and do not claim deterministic per-address proof otherwise |
| App container is public behind an unverifiable proxy peer | Trust only provider-documented `do-connecting-ip`, strip all headers, allow missing only on health, and require live spoof/omission tests |
| Managed Cloudflare edge buffers or transforms NDJSON | Disable edge cache/transforms and run heartbeat/five-minute/disconnect/deploy tests |
| Managed Cloudflare edge can process plaintext content | Accept only after DPA/subprocessor/region/log-retention/access/deletion/breach review; reject the candidate if the privacy contract fails |
| DNSSEC or CAA blocks managed TLS | Recheck authoritative DNS; never disable DNSSEC silently; if CAA exists authorize both required certificate authorities |
| One instance loses availability during platform/provider failure | Accept explicitly, monitor externally, retain exact rebuild/rollback procedures, meet RTO |
| Pre-deploy job sees runtime provider secrets | Component-scoped variables and live-contract key-set audit |
| A newly added private-GHCR image block has no encrypted value yet | Accept plaintext only through protected first-field input, place it only in image credentials, verify the returned encrypted form, preserve each field thereafter, and rotate explicitly |
| Retiring the Droplet deletes GHCR retention authority | Relocate the tested planner before host removal, derive protection from live App/GitHub/recovery-pin evidence, and preserve dry-run hash plus full revalidation before deletion |
| Temporary initialization combines migration and application authority | Use distinct revocable bootstrap roles/key, a 32-KiB schema, durable hash latch, content-free output, immediate live-spec removal, and historical-replay tests |
| Successful initialization spec remains in provider deployment history | Revoke every bootstrap credential, retain the completed latch, prohibit native rollback operationally, and prove an old replay cannot mutate state |
| App Platform console user can reveal encrypted variables | Minimal team membership, MFA, Bitwarden ownership, access review, and audited configuration changes |
| Team-scoped deploy token can update another App | Keep only Capstone in the dedicated team, pin the App ID in every request, omit create/delete/console scopes, and use separate revocable provisioning, console, and post-domain-release delete credentials |
| Direct log mirror leaks content or blocks requests | Strict allowlist, bounded memory/time/retry, no disk, drop on outage, adversarial privacy tests |
| No host Fluent Bit remains to capture crash-tail records | Keep content-free stdout and App Platform crash logs; flush boundedly without promising lossless telemetry |
| Rolling deploy overlaps database pools | Verify PS-5 connection headroom and pool release; change pool only from measured evidence |
| Native platform rollback restores old configuration or database secrets | Keep it out of the operator workflow; redeploy the prior exact digest through the current spec and revoke old roles so stale attempts fail closed |
| Normal deploy is used to select an old checked commit | Require current protected `main` HEAD and strict active-release ancestry; reserve prior artifacts for the compatibility-checked rollback entrypoint |
| Concurrent full-spec writers overwrite fresh secrets or egress/domain state | Serialize every writer in one non-cancelling Actions group, use one mutation helper, double-check the full live fingerprint immediately before PUT, verify after PUT, and prohibit control-panel spec edits |
| Planned App replacement loses egress pair/domain state | Preserve the App ID when possible; otherwise detach and verify domain release before delete, allocate a new pair, and rehearse controlled transfer within RTO |
| Accidental deletion leaves the domain bound for up to 24 hours | Keep delete authority short-lived, invoke the approved maximum 24-hour exception only for this failure mode, and report it separately from controlled recovery |
| App spec/provider state drifts through control-panel edits | Read-only live-contract audit before every deploy and scheduled/manual review |
| Provider maintenance restarts the same image | Distinguish restart from release using exact digest/revision and alert/evidence metadata |
| RIC managed scheduling differs from local evidence | Two managed load passes and Ecuador latency gate; no historical relabeling |
| PS-5 remains a bottleneck | Managed DB metrics and exact queries first; PS-10 only after explicit approval |
| Three-day PITR or storage policy drifts | Backup-aging audit, storage alerts/ceiling, isolated restore, and launch blocker |
| Old Droplet resources continue billing or retain temporary access | Separately authorized inventory, secure teardown, Bitwarden cleanup, and zero-resource verification |
| Historical runbooks mislead operators | One active-path audit and prominent supersession notices |
| One recovery owner is unavailable | Preserve sealed offline kit and visible launch risk; never claim two-owner resilience |

## Definition of repository done

Repository implementation is complete only when:

- every approved authority document and runbook names App Platform as the one active path;
- App Platform runtime configuration, strict client address, platform secret scope, health,
  termination, and log mirror are implemented and tested;
- the non-secret App contract, bootstrap, exact-digest deploy, rollback, and live drift audit are
  source-controlled and self-tested;
- protected first-GHCR-credential submission, encrypted-value preservation/rotation, and
  rollbackable-history inspection are source-controlled and self-tested;
- GHCR cleanup still protects active-serving, desired, in-progress, previous, recent-five, and
  recovery-pinned digests with a reviewed plan hash and fresh-authority check before deletion;
- the initialization latch, revocable-bootstrap contract, and post-readiness invitation seam are
  implemented without adding a second authority path;
- CI still publishes one exact non-root image only after all gates pass;
- migration runs only as the exact-digest pre-deploy job;
- Droplet host artifacts and active references are removed rather than maintained in parallel;
- full local checks, browser matrix, image checks, audits, and diff checks pass;
- the implementation record lists every changed path and exact result;
- no credential, provider ciphertext, production data, resource, DNS change, or paid call was added;
  and
- an independent final review finds no unresolved repository-scope P1/P2 issue.

Repository completion must still say managed acceptance is pending.

## Definition of candidate acceptance

The App Platform/PlanetScale candidate is accepted only when:

- current prices, region, resource slugs, egress pair, pooled bandwidth, Uptime allowance, logs,
  alerts, ownership, DPA, subprocessors, regions, retention/access/deletion/breach terms, and the
  Cloudflare plaintext-processing boundary are recorded and accepted;
- two exact managed 20-employee/40-stream passes meet every unchanged objective;
- authoritative DNSSEC/CAA preflight, exact primary/CNAME/starter redirect, client-IP spoof and
  omission resistance, TLS/origin/cookies, five-minute NDJSON, heartbeat, cancellation,
  backpressure, and canonical recovery pass through the real edge;
- migration failure, readiness failure, active-stream deploy, forced termination, provider restart,
  and rollback are exercised;
- both egress `/32`s, role boundaries, direct TLS, PS-5 compatibility, pool behavior, storage, and
  backup policy pass;
- initialization latch/retry/conflict behavior, bootstrap-credential revocation, safe historical
  replay, final-spec cleanup, and post-readiness invitation pass;
- the pre-egress rollback behavior is recorded and every bootstrap-era unsafe deployment is proven
  absent from the ten rollbackable successful deployments;
- New Relic and native provider telemetry deliver content-free evidence and alerts without becoming
  readiness-critical;
- the aged PITR and controlled detach-before-delete App recreation satisfy RPO/RTO, and the
  accidental-deletion domain-binding behavior is evaluated against the approved maximum 24-hour
  exception without relabeling it as a controlled four-hour recovery;
- production Resend, authorized OpenRouter smoke, Ecuador/browser/device/accessibility, secret
  rotation, and incident procedures pass;
- temporary resources and credentials are cleaned up; and
- the final acceptance review has no unresolved P1/P2 finding.

## Authorization boundary

This accepted amendment and implementation record do not grant permission to act externally.

Without a later explicit grant, do not:

- delete or mutate the existing Droplet rehearsal;
- create an App Platform App, dedicated egress pair, PlanetScale database/branch, domain, registry
  credential, or provider token;
- install any secret in DigitalOcean, GitHub, PlanetScale, New Relic, Resend, or OpenRouter;
- mutate DNS, production data, backups, roles, IP restrictions, or recovery state;
- run paid inference or send real employee email;
- commit, push, or deploy; or
- claim managed acceptance or production readiness.

Repository authorization has been consumed. External rehearsal and production actions remain
later, separately bounded decisions.

## Repository implementation record — 2026-08-11

Repository implementation was completed against baseline
`4172169833f23d88b1f10a56f6a032251ac83945`. It replaces the raw-Droplet operator surface with one
strict DigitalOcean App Platform adapter while preserving the existing OCI image and PostgreSQL
application boundaries. No provider resource, credential, DNS record, paid inference, employee
email, commit, or push was created by this work.

Implemented behavior includes:

- digest-free staged production and managed-rehearsal contracts, exact-digest rendering, fetched
  state validation, immutable egress-pair preservation, protected-main/CI/base-deployment fences,
  and retry-safe ambiguous-success reconciliation;
- exact-digest steady deployment, predecessor-only rollback, content-free schema-2 GitHub
  Deployment authority, initial-baseline adoption, production/rehearsal unsafe-history eviction,
  and two-phase GHCR retention with fresh-authority revalidation;
- one serialized spec-writer boundary for deploy, rollback, maintenance, domain changes, and
  operator-local credential rotation; consuming CLIs remove protected plaintext input files on
  success, validation failure, or operation failure;
- bounded App Platform console execution, production initialization and invitation seams,
  platform-environment secret loading, strict `do-connecting-ip` handling, direct New Relic log
  mirroring, and the disposable managed rehearsal runtime; and
- updated active authority, runbooks, recovery evidence, image checks, CI publication, operations
  audit, and removal of the obsolete host/Caddy/systemd deployment implementation.

The managed initializer persists deterministic OpenRouter-shaped catalog and privacy-attestation
rows solely to exercise OpenRouter reservation, accounting, and readiness through the injected
load gateway. They are synthetic capacity fixtures, never live catalog, provider, or privacy
evidence. Neither the rehearsal service nor its initializer receives `OPENROUTER_API_KEY`.

### Complete changed-path inventory

The final working-tree inventory relative to the recorded baseline is:

- Root and workflows: `.env.example`, `README.md`, `package.json`,
  `.github/workflows/ci.yml`, `.github/workflows/configure-production.yml`,
  `.github/workflows/deploy-production.yml`, and `.github/workflows/ghcr-retention.yml`.
- API packaging/schema: `apps/api/Dockerfile`, `apps/api/package.json`,
  `apps/api/migrations/0007_sloppy_northstar.sql`, `apps/api/migrations/meta/_journal.json`, and
  `apps/api/migrations/meta/0007_snapshot.json`.
- Modified API source: `apps/api/src/app.ts`, `apps/api/src/auth/authentication.ts`,
  `apps/api/src/config.ts`, `apps/api/src/database/migrate-command.ts`,
  `apps/api/src/database/schema.ts`, `apps/api/src/entrypoint.ts`,
  `apps/api/src/identity/resend-email.ts`, `apps/api/src/identity/service.ts`,
  `apps/api/src/load/diagnostics.ts`, `apps/api/src/load/harness-safety.ts`,
  `apps/api/src/load/load-server.ts`, `apps/api/src/model-policy/service.ts`,
  `apps/api/src/observability/telemetry-contract.ts`, `apps/api/src/observability/telemetry.ts`,
  `apps/api/src/openrouter/catalog-client.ts`, `apps/api/src/openrouter/openrouter-gateway.ts`,
  `apps/api/src/operator/identity-command.ts`, `apps/api/src/operator/model-policy-command.ts`,
  `apps/api/src/secret-environment.ts`, `apps/api/src/security/client-address.ts`,
  `apps/api/src/security/http.ts`, and `apps/api/src/shutdown-budget.ts`.
- Added API source: `apps/api/src/database/initialization-schema.ts`,
  `apps/api/src/egress-bootstrap-server.ts`, `apps/api/src/egress-bootstrap.ts`,
  `apps/api/src/load/managed-rehearsal.ts`,
  `apps/api/src/observability/new-relic-log-mirror.ts`,
  `apps/api/src/operator/initial-invitation-command.ts`,
  `apps/api/src/operator/initialization-document.ts`,
  `apps/api/src/operator/initialization-latch.ts`, `apps/api/src/operator/invitation.ts`,
  `apps/api/src/operator/managed-rehearsal-initialization-command.ts`,
  `apps/api/src/operator/openrouter-bootstrap-catalog.ts`,
  `apps/api/src/operator/production-initialization-command.ts`,
  `apps/api/src/operator/production-initialization.ts`, and
  `apps/api/src/operator/stdin-document.ts`.
- Modified API tests: `apps/api/tests/app-observability.test.ts`,
  `apps/api/tests/client-address.test.ts`, `apps/api/tests/config.test.ts`,
  `apps/api/tests/database.integration.test.ts`, `apps/api/tests/generation-domain.test.ts`,
  `apps/api/tests/http-security.test.ts`, `apps/api/tests/identity-email.test.ts`,
  `apps/api/tests/identity.integration.test.ts`, `apps/api/tests/load-diagnostics.test.ts`,
  `apps/api/tests/load-harness-safety.test.ts`, `apps/api/tests/load-harness.ts`,
  `apps/api/tests/model-policy-operator.integration.test.ts`,
  `apps/api/tests/observability-database.integration.test.ts`,
  `apps/api/tests/openrouter-catalog.test.ts`, `apps/api/tests/openrouter-gateway.test.ts`,
  `apps/api/tests/phase7-database.integration.test.ts`,
  `apps/api/tests/recovery-preparation.integration.test.ts`,
  `apps/api/tests/recovery-preparation.test.ts`, `apps/api/tests/secret-environment.test.ts`,
  `apps/api/tests/shutdown.test.ts`, and `apps/api/tests/telemetry.test.ts`.
- Added API tests: `apps/api/tests/egress-bootstrap.test.ts`,
  `apps/api/tests/new-relic-log-mirror.test.ts`,
  `apps/api/tests/production-initialization.integration.test.ts`, and
  `apps/api/tests/production-initialization.test.ts`.
- Added App Platform adapter: `deploy/app-platform/README.md`, `app.contract.yaml`,
  `bootstrap.contract.yaml`, `domain.contract.yaml`, `egress.contract.yaml`,
  `initialization.contract.yaml`, `rehearsal-bootstrap.contract.yaml`,
  `rehearsal-domain.contract.yaml`, `rehearsal-egress.contract.yaml`,
  `rehearsal-initialization.contract.yaml`, `rehearsal.contract.yaml`, `configuration.mjs`,
  `configuration.test.mjs`, `configure.mjs`, `console.mjs`, `consumable-input.mjs`,
  `consumable-input.test.mjs`, `contract.mjs`, `contract.test.mjs`, `deploy.mjs`,
  `fixtures/recovery-pins.example.json`, `ghcr-retention.py`, `ghcr-retention.test.py`,
  `github-api.mjs`, `github-api.test.mjs`, `http-json.mjs`, `live-contract.mjs`,
  `mutate-app.mjs`, `mutate-app.test.mjs`, `operator-console.mjs`,
  `operator-console.test.mjs`, `provider-api.mjs`, `provider-api.test.mjs`, `provision.mjs`,
  `provisioning.mjs`, `provisioning.test.mjs`, `release.mjs`, `release.test.mjs`,
  `rollback.mjs`, and `workflow.test.mjs`.
- Removed legacy host adapter: `deploy/digitalocean/Caddyfile`, `README.md`,
  `capstone-boot.service`, `capstone-caddy.service`, `capstone-chat@.service`,
  `capstone-deploy.service`, `capstone-fluent-bit.service`, `capstone-operator.service`,
  `ci-evidence.example.json`, `cleanup-migrations.sh`, `cloud-init.yaml`,
  `deploy-state-machine.test.sh`, `deploy.sh`, `fluent-bit-parsers.conf`,
  `fluent-bit-privacy.test.mjs`, `fluent-bit-secret.test.sh`, `fluent-bit.conf`,
  `ghcr-retention.py`, `ghcr-retention.test.py`, `host.env`, `maintenance.caddy`,
  `migration-cleanup.test.sh`, `operator-entrypoint.mjs`, `operator-secret.test.sh`,
  `operator.sh`, `request-deploy.sh`, `request-lifecycle.sh`,
  `request-lifecycle.test.sh`, `request-operator.sh`, `start-fluent-bit.sh`,
  `verify-artifacts.sh`, `verify-host-negative.test.sh`, and `verify-host.sh`.
- Documentation and authority: this file,
  `docs/implementation/08-digitalocean-planetscale-amendment-plan.md`,
  `docs/implementation/08-production-baseline-amendment-plan.md`,
  `docs/implementation/08-production-hardening-plan.md`, `docs/operations/README.md`,
  `docs/operations/database-recovery.md`, `docs/operations/deploy-and-rollback.md`,
  `docs/operations/domain-and-tls.md`, `docs/operations/employee-access.md`,
  `docs/operations/incident-response.md`, `docs/operations/providers-and-budget.md`,
  `docs/operations/provision-and-deploy.md`, `docs/operations/secret-rotation.md`,
  `docs/prd/02-system-architecture-and-data.md`, `docs/prd/06-development-roadmap.md`, and
  `docs/prd/README.md`.
- Repository verification: `scripts/container-smoke.mjs` and
  `scripts/operations-audit.mjs`.

### Verification record

The final repository verification run completed on 2026-08-11 Ecuador time:

- `pnpm check`: passed; Biome checked 362 files without changes;
- `pnpm verify:repository`: passed for 482 files;
- `pnpm verify:operations`: passed, including its App Platform, PlanetScale, runbook, and recovery
  self-tests;
- `pnpm typecheck`: passed for protocol, API, and web;
- `pnpm test`: 1,021/1,021 passed — 204 protocol, 594 API/PostgreSQL, and 223 web tests;
- the 11 App Platform fixture suites and the Python GHCR retention fixtures passed;
- `pnpm build` and `pnpm report:bundle`: passed; the initial browser payload was 816,000 raw bytes
  and 314,775 gzip bytes, with the existing deferred Markdown chunk advisory remaining visible;
- `pnpm test:e2e`: 42/42 passed across Chromium and the critical Firefox/WebKit matrix;
- `pnpm audit --prod --audit-level high`: passed the high/critical gate with one existing moderate
  development-server advisory;
- migrations applied successfully, including `0007_sloppy_northstar.sql`;
- the production image built at 100,132,859 bytes, ran as the non-root `node` user, contained the
  required migration/API/web artifacts without source maps, tests, or environment files, embedded
  the exact requested API and web revision, and carried no provider-specific runtime defaults;
- the production-image smoke passed migration, identity/model bootstrap, default-entrypoint
  readiness, SPA/cache/security behavior, and graceful shutdown against an isolated disposable
  PostgreSQL database; and
- `git diff --check` passed.

The working-tree inventory contains 164 paths relative to the frozen baseline and matches the
complete inventory above. The disposable smoke database and containers were removed. Managed
rehearsal and every provider-dependent acceptance gate remain unrun and unauthorized.

An independent final read-only audit found no remaining repository-scope P1/P2 issue in image
immutability, release and reconciliation authority, provisioning, Dedicated Egress preservation,
bounded provider clients, console input handling, initialization, or managed-rehearsal isolation.
