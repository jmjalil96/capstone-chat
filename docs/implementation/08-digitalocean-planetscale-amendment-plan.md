# Phase 8 Amendment — DigitalOcean Droplet and PlanetScale PostgreSQL Baseline

Status: approved; repository implementation completed in the authorized working tree on 2026-08-10;
the NYC3 disposable managed rehearsal was authorized on 2026-08-11; candidate acceptance and
production actions remain unauthorized

External authorization: only the disposable NYC3 managed rehearsal is authorized, with at most USD
5 of actual provider usage excluding temporary card holds and taxes. Production DNS, credentials,
data, deployment, paid inference, and production/recovery-resource mutation remain unauthorized.

## Planning record

This amendment responds to the user's explicit 2026-08-10 direction to replace the active Render
candidate with the lowest DigitalOcean and PlanetScale candidates:

- one USD 6/month DigitalOcean Basic Droplet with one shared vCPU and 1 GiB RAM; and
- one USD 5/month PlanetScale Postgres PS-5 Single Node cluster.

The user subsequently approved the design one decision at a time and authorized repository
implementation on 2026-08-10. The approved decisions are RIC1/`us-east-1`, PS-5 ARM, one active
instance with no HA, fixed-source public `verify-full` TLS, a 15 GB database ceiling, backups every
12 hours retained for 84 hours, no paid Droplet backups, the New Relic/DigitalOcean/PlanetScale
monitoring split, CI-published GHCR images with explicit operator deployment, direct DNS-only Caddy,
the encrypted Volume, same-host blue/green activation, and two clean 20-employee/40-stream managed
qualification runs. Repository authorization does not authorize an external account, resource,
credential, DNS, paid rehearsal, inference, production deployment, or recovery mutation.

On 2026-08-11, the live DigitalOcean control panel showed the exact USD 6 Basic size unavailable in
RIC1 and ATL1 but available in NYC3. The user explicitly approved NYC3 for the disposable rehearsal
only. RIC1 remains the production candidate. NYC3 evidence may qualify the shared host size,
application behavior, PS-5 capacity, deployment, rollback, and recovery paths; it cannot be labeled
as RIC1 scheduling, availability, or RIC1-to-`us-east-1` latency evidence. A production-region
change requires a separate explicit decision.

The repository currently starts at commit `92bee339972f6416ae7266d2a592d8fdeb98bd73` plus the
uncommitted, user-owned Minimal Render amendment implementation and its performance evidence. The
first implementation step must freeze the exact accepted tree and results. This plan does not
pretend that a dirty working tree is a release baseline, and it does not overwrite or discard the
existing work.

The accepted [Phase 8 plan](./08-production-hardening-plan.md) and the implemented
[Minimal Render amendment](./08-production-baseline-amendment-plan.md) remain historically honest.
Their Render, `pro_plus`, Standard, Starter, private-network, Blueprint, and local load results are
evidence for those candidates only. They are not DigitalOcean or PlanetScale evidence and must not
be relabeled.

The useful sizing evidence carried forward is narrower:

- the production image is approximately 100 MB and runs as non-root UID 1000;
- the 1 CPU / 2 GiB application-container candidate passed the locked local workload twice;
- the 0.5 CPU / 512 MiB application-container candidate remained memory-safe but failed the
  experimental 750 ms response-start objective on one final run;
- the application therefore needs one full candidate vCPU more clearly than it needs 2 GiB of
  application RAM; and
- every prior local load run used a host PostgreSQL instance rather than a constrained PS-5
  database, so none qualifies PlanetScale capacity.

The USD 6 Droplet and PS-5 are consequently **provisional production candidates**. They remain
unaccepted until the NYC3 managed topology passes every applicable unchanged gate twice and the
remaining RIC1-specific evidence is either produced or superseded by an explicit production-region
decision. A price choice is not capacity evidence.

## Authority and amendment semantics

Read this document with:

- `AGENTS.md`;
- `docs/prd/README.md` and all six locked PRDs;
- the accepted Phase 1–8 implementation records;
- the current Minimal Render amendment, migrations, production image, load harness, CI workflow,
  repository/operations audits, and operations runbooks; and
- the current official DigitalOcean, PlanetScale, and GitHub contracts linked below.

This approved amendment supersedes only these active Phase 8 choices:

| Active choice | Approved replacement |
|---|---|
| Render Hobby workspace | One DigitalOcean team/account and one PlanetScale organization with named Capstone ownership |
| Render Standard Web Service | One DigitalOcean Basic shared-CPU Droplet, 1 vCPU / 1 GiB, in RIC1 |
| Render `basic-256mb` PostgreSQL | PlanetScale Postgres PS-5 ARM Single Node, 512 MiB, in AWS `us-east-1` |
| Render private database network | Public Internet route restricted to one fixed Droplet `/32` and protected by `verify-full` TLS |
| Render-managed edge/TLS | Caddy on the Droplet, with public ports 80/443 and application ports bound to loopback only |
| Render secret injection | Root-owned files on one encrypted DigitalOcean Volume plus a narrow application secret-file loader |
| Render Git-linked `checksPass` deploy | CI-published immutable GHCR image followed by an explicit operator deploy after all exact-commit checks pass |
| Render pre-deploy migration | One direct, separately credentialed migration container before application activation |
| Render retained artifacts | GHCR full-SHA images and recorded digests, retaining the current and immediately previous compatible release |
| Render default log stream | One bounded Fluent Bit host process forwarding only content-free application JSON logs to New Relic |
| Render infrastructure dashboard | DigitalOcean Monitoring for the host and PlanetScale's protected metrics/Query Insights for PostgreSQL |
| Render platform rollback | Same-host blue/green activation and immediately previous compatible image rollback |
| Render platform rebuild | Source-controlled cold rebuild, encrypted-volume recreation, secret recovery, and reserved-IP reassignment |
| Render three-day PITR | PlanetScale custom backups every 12 hours retained for 84 hours, guaranteeing at least 72 hours of continuously accessible PITR, plus isolated restored branches |
| `render.yaml` and Render audit | Exact DigitalOcean/PlanetScale host artifacts and provider-specific operations audit |

This amendment also explicitly changes the locked “no host agent” interpretation only as far as
the new provider requires. DigitalOcean offers no Droplet log service. One narrowly configured
Fluent Bit process is therefore approved for application log delivery, and DigitalOcean's own
Monitoring agent is used for host metrics. No New Relic infrastructure agent, browser agent,
OpenTelemetry collector, sidecar, second telemetry backend, or database-log forwarder is added.

Every other product, privacy, security, data, model, email, budget, capacity, latency, and recovery
decision remains locked. In particular, this amendment does not change:

- the modular monolith, one employee-facing origin, one active application instance, one database,
  no HA/read replica, and no queue, cache, worker, or additional product service;
- `https://chat.capstone.com.ec`, Resend, OpenRouter, ZDR, the approved model mappings, output
  limits, accounting, reservation margin, privacy attestation, or generation timeout;
- the authoritative USD 100 monthly model budget, two employee chat workflows, one workflow per
  conversation, or the 20-employee/40-stream launch workload;
- p95 admitted-send-to-`response.started` at most 500 ms, ordinary API p95 at most 300 ms and p99
  at most 750 ms, backend cancellation p95 at most 500 ms, or the Ecuador/browser/UI objectives;
- expand/contract migrations, readiness/drain, four-minute stream grace, canonical partial-output
  recovery, and immediately previous compatible rollback;
- RPO at most 15 minutes, RTO at most four hours, at least three continuously accessible days of
  PITR, isolated restore, and source preservation. Approval explicitly accepts an 84-hour finite
  backup-retention ceiling—the smallest 12-hour-cadence margin that does not periodically dip below
  72 accessible hours;
- content-free logs, metrics, traces, provider evidence, load evidence, and recovery evidence; or
- the four named Phase 8 P2 production blockers. They remain launch blockers and gain an explicit
  implementation home in this amendment.

Approval and authorization stay separate:

1. approving this plan freezes the intended design;
2. explicitly authorizing implementation permits source-controlled repository changes only;
3. creating the disposable managed rehearsal requires a fresh action-specific authorization; and
4. production accounts, resources, DNS, credentials, paid inference, and recovery branches each
   remain separately gated.

### Approved recovery-store decision

The Capstone Bitwarden Teams cloud organization is the approved recoverable source for runtime,
migration, GHCR, New Relic, Resend, OpenRouter, DigitalOcean, PlanetScale, DNS, and SSH credentials.
The `Production` collection belongs to the Capstone organization rather than a personal vault. Its
initial owner uses a company-controlled mailbox, has MFA enabled, and has a sealed offline recovery
kit stored separately from the operator's computer and phone. Credentials and recovery material
must never be added to this repository, task, screenshot, log, or operational evidence.

The approved initial cost is one Bitwarden Teams owner at USD 4/month equivalent, billed annually.
The user explicitly deferred a second recovery owner. That does not block repository implementation,
but it is a visible single-person recovery risk that must be reviewed during launch sign-off and
every cold-rebuild rehearsal. The plan must not claim two-owner resilience until a second authorized
business owner has an independent company-controlled account, MFA, and tested access. Before launch,
the current owner must also exercise emergency retrieval and restoration of a fresh encrypted Volume
within the four-hour RTO; the test records only timing and safe outcomes.

## Current provider contracts

The following contracts were reviewed on 2026-08-10 before repository authorization. Prices and
provider behavior are not application constants. Recheck them immediately before external
provisioning and record any material drift before acting.

### DigitalOcean

- [Droplet pricing](https://docs.digitalocean.com/products/droplets/details/pricing/) identifies
  the Basic shared-CPU catalog and bandwidth billing. The live control-panel estimate must confirm
  the USD 6 `s-1vcpu-1gb` candidate and its included transfer.
- [Shared versus dedicated CPU](https://docs.digitalocean.com/products/droplets/concepts/choosing-a-plan/)
  states that a shared vCPU is not guaranteed dedicated CPU time. Two passing runs at one moment do
  not prove permanent neighbor-independent latency; ongoing monitoring remains mandatory.
- [Vertical resizing](https://docs.digitalocean.com/products/droplets/how-to/resize/) requires a
  power-off. CPU/RAM-only resizing preserves a path back when disk size is kept fixed; increasing
  the Droplet disk is permanent and the disk cannot later shrink.
- [Reserved IP pricing](https://docs.digitalocean.com/products/networking/reserved-ips/details/pricing/)
  is zero while the address is assigned to a Droplet. An unassigned reserved IPv4 can incur cost.
- [Reserved-IP outbound routing](https://docs.digitalocean.com/products/networking/reserved-ips/how-to/outbound-traffic/)
  requires an explicit persistent route change. Merely assigning the address does not prove that
  PlanetScale sees it as the source.
- [Cloud Firewalls](https://docs.digitalocean.com/products/networking/firewalls/details/pricing/),
  [Monitoring](https://docs.digitalocean.com/products/monitoring/details/features/), and one
  [Uptime check](https://docs.digitalocean.com/products/uptime/details/pricing/) are expected to fit
  the candidate without an additional monthly line item. Verify the live account limits.
- DigitalOcean's
  [Droplet shared-responsibility statement](https://www.digitalocean.com/security/shared-responsibility-model-droplets)
  says Droplet local disks are not encrypted at rest and DigitalOcean supplies no Droplet logging
  service.
- [Volumes features](https://docs.digitalocean.com/products/volumes/details/features/) documents
  encryption at rest, and [Volumes pricing](https://docs.digitalocean.com/products/volumes/details/pricing/)
  currently makes the minimum 1 GiB volume USD 0.10/month.
- [Regional availability](https://docs.digitalocean.com/platform/regional-availability/) lists
  RIC1. Live account availability still controls creation: on 2026-08-11 the exact Basic size was
  unavailable in RIC1 and ATL1 and available in NYC3. The user approved NYC3 only for this
  disposable rehearsal; all selected Droplet, Volume, reserved IPv4, firewall, and Monitoring
  features must be verified live there before creation.

### PlanetScale Postgres

- [Postgres pricing](https://planetscale.com/docs/postgres/pricing) currently lists PS-5 Single
  Node at USD 5/month with 1/16 vCPU, 512 MiB RAM, and 10 GB included storage. PS-10 ARM Single Node
  is the first proposed database escape hatch at USD 10/month.
- [Postgres compatibility](https://planetscale.com/docs/postgres/postgres-compatibility) and
  [extensions](https://planetscale.com/docs/postgres/extensions) cover the required PostgreSQL 18
  behavior and `unaccent`. Compatibility still must be proved against every migration and critical
  query; documentation is not executable evidence.
- [Connections](https://planetscale.com/docs/postgres/connecting) require TLS. Node connection
  strings use `sslmode=verify-full`; do not add `sslrootcert=system`, which the repository's `pg`
  client can interpret as a local file rather than a platform trust-store instruction.
- [IP restrictions](https://planetscale.com/docs/postgres/connecting/ip-restrictions) can restrict
  roles or the database to the Droplet's fixed public `/32`. DigitalOcean cannot use PlanetScale's
  AWS/GCP private-connect products, so this remains an acknowledged public-network TLS path.
- [Roles](https://planetscale.com/docs/postgres/connecting/roles) support a separate application
  credential. The provider's default administrative credential must not be the runtime credential.
- [Local PgBouncer](https://planetscale.com/docs/postgres/connecting/pgbouncer) is available, but
  the existing application intentionally supplies PostgreSQL startup `options` for JIT, statement,
  lock, and idle-transaction limits. This plan initially uses direct port 5432 to preserve those
  session guards without introducing a second configuration path. Pooler adoption requires a
  separate measured change.
- [Single Node](https://planetscale.com/docs/postgres/cluster-configuration/single-node) has no
  replica or automatic failover. That matches the currently accepted no-HA cost posture but remains
  an availability risk.
- [Backups](https://planetscale.com/docs/postgres/backups) default to two-day retention and charge
  for retention beyond included backup/WAL storage. Frequency and retention are independent, and
  PITR starts at the oldest retained backup. A custom 12-hour/84-hour schedule is required so the
  continuously accessible window remains at least 72 hours after an older backup expires.
  Restored branches do not restore extensions, credentials, IP restrictions, or custom settings.
- [PITR](https://planetscale.com/docs/postgres/backups/point-in-time-recovery) restores into a new
  separately billed branch and does not replace the source.
- [Security and compliance](https://planetscale.com/docs/security) states that branch and backup
  storage media are encrypted at rest. Verify the applicable live terms before relying on the
  existing deleted-content backup disclosure.
- [Disk autoscaling](https://planetscale.com/docs/postgres/cluster-configuration/disk-autoscaling)
  is enabled by default, grows a small disk by at least 50%, and can sever connections during surge
  growth. This candidate keeps it enabled but fixes the storage limit at 15 GB: one bounded growth
  from the included 10 GB and no unbounded cost increase.

### GitHub Container Registry

- [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)
  currently states that Container registry image storage and bandwidth are free, with advance
  notice promised before a pricing change. The account's actual package permissions, budget, and
  retention must be checked before relying on it.
- [Container registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
  supports repository-linked private OCI images. GitHub Actions publishes with `GITHUB_TOKEN`; the
  Droplet uses a separate read-only package credential stored only on the encrypted Volume.

### Caddy, Docker logging, and New Relic

- Caddy's [streaming behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)
  already flushes responses of unknown length. A negative `flush_interval` also suppresses backend
  cancellation on client disconnect, so it is explicitly prohibited.
- Caddy's [admin endpoint](https://caddyserver.com/docs/caddyfile/options#admin) supports a Unix
  socket. Host networking makes the default loopback TCP endpoint reachable from the application
  container, so production has no TCP admin listener.
- Docker's [Fluentd logging driver](https://docs.docker.com/engine/logging/drivers/fluentd/) supports
  Unix sockets but otherwise defaults to blocking startup, an enormous in-memory event count,
  near-infinite retries, and no write timeout. Every bound is explicit below.
- Docker's [dual logging](https://docs.docker.com/engine/logging/dual-logging/) can retain a local
  cache for remote drivers. Production explicitly disables it so application records never land on
  the unencrypted root disk.
- New Relic documents both a separately installed Fluent Bit output plugin and generic HTTPS log
  ingest. This plan uses Fluent Bit's built-in HTTPS output and the
  [New Relic Log API](https://docs.newrelic.com/docs/logs/log-api/introduction-log-api/) to avoid an
  extra native plugin/binary supply-chain surface.

## Proposed production topology

```text
Internet
  |
  |  HTTPS https://chat.capstone.com.ec
  v
DigitalOcean reserved IPv4 -> Cloud Firewall -> RIC1 Basic Droplet
                                                1 shared vCPU / 1 GiB
                                                Ubuntu 24.04 LTS
  |
  |-- Caddy :80/:443
  |     |-- ACME/TLS state on encrypted Volume
  |     |-- no access log
  |     `-- reverse proxy to active loopback slot
  |
  |-- Capstone OCI slot A on 127.0.0.1:3001
  |-- Capstone OCI slot B on 127.0.0.1:3002
  |     `-- exactly one slot active for new traffic
  |
  |-- Fluent Bit -> content-free application JSON logs -> New Relic Free
  |-- Fastify OTLP -> content-free traces/application metrics -> New Relic Free
  |-- DigitalOcean Monitoring agent -> host metrics -> DigitalOcean dashboard
  `-- encrypted 1 GiB Volume
        |-- runtime and migration secret files
        |-- GHCR read credential
        `-- Caddy private state

Droplet fixed outbound reserved IPv4 /32
  |
  |  public TLS, sslmode=verify-full, direct port 5432
  v
PlanetScale AWS us-east-1
  `-- PostgreSQL 18.4, PS-5 ARM Single Node
        |-- 1/16 vCPU / 512 MiB
        |-- 10 GB included storage; autoscaling hard-limited to 15 GB
        |-- application role: read/write, no DDL/admin
        |-- migration role: direct operator/deploy use only
        `-- backups every 12 hours retained 84 hours; PITR continuously >= 72 hours

OpenRouter, Resend, and New Relic remain the existing external providers.
GHCR stores immutable full-revision OCI images; it is not a running application service.
```

The application remains one modular-monolith process and one active production instance. Slot B is
an inactive deployment slot on the same machine, not horizontal application capacity, HA, or a
second employee-facing service. During a rollout, both containers may overlap only for readiness
and graceful drain. The exact 1 GiB host must prove that overlap without OOM or stream corruption.

## Cost statement

The approved steady-state base estimate is:

| Component | Candidate | Monthly estimate |
|---|---|---:|
| DigitalOcean Droplet | Basic shared CPU, 1 vCPU / 1 GiB | USD 6.00 |
| DigitalOcean encrypted Volume | 1 GiB | USD 0.10 |
| DigitalOcean reserved IP, firewall, Monitoring, one Uptime check | Assigned/within documented free allowance | USD 0.00 |
| PlanetScale Postgres | PS-5 ARM Single Node, initial included 10 GB | USD 5.00 |
| GitHub Container Registry | Current container-registry pricing | USD 0.00 |
| **Candidate base infrastructure** | | **USD 11.10/month** |
| Bitwarden Teams | One company-controlled owner, billed annually | USD 4.00 |
| **Candidate operational base** | Infrastructure plus one Bitwarden owner | **USD 15.10/month** |
| Configured storage ceiling | One automatic growth to 15 GB at current `us-east-1` storage price | **USD 15.725/month operational total (USD 15.73 rounded)** |

USD 11.10 is the starting infrastructure base and USD 15.10 is the approved operational base with
one Bitwarden owner. At the storage ceiling, those values become USD 11.73 infrastructure and USD
15.73 operational. This is not an all-in hard cap. PlanetScale
backup/WAL storage beyond its included allowance,
PlanetScale and DigitalOcean network overage, GitHub policy changes, temporary rehearsal/restore
resources, DNS, tax, and provider price changes are additional. New Relic and Resend are assumed to
remain within their approved free allowances; that must be verified in their live accounts.
OpenRouter model spend remains separate and is still governed by the application's hard USD 100
monthly workspace budget.

Do not add DigitalOcean Droplet backups or DOCR Basic merely to make the table look safer. The host
contains no authoritative application data, must be reproducible from source, and must recover from
external secret escrow plus an immutable GHCR image. If GHCR ceases to meet the retention/cost
contract, stop for a new registry decision rather than silently adding USD 5/month.

The managed rehearsal and PITR branch are billed only while alive. The operator records their live
estimate before creation and destroys them after evidence is accepted. No external resource is
created from an ordinary test command.

## Scope

### In scope

- Amend PRD 02, PRD 06, the active Phase 8 records, README, and all operations runbooks without
  rewriting historical evidence.
- Replace Render-specific release metadata, trusted-edge handling, Blueprint, deployment,
  migration, secrets, logging, rollback, rebuild, and recovery assumptions.
- Add the smallest source-controlled DigitalOcean host configuration: Caddy, systemd, firewall
  expectations, Docker runtime constraints, encrypted-Volume layout, and a bounded deploy script.
- Publish one immutable production OCI artifact to GHCR only after every exact-commit CI gate passes.
- Add a narrow secret-file loader so secret values do not appear in Docker arguments, image layers,
  unit files, root-disk environment files, logs, or repository files.
- Use one fixed outbound reserved IPv4 and PlanetScale `/32` restrictions with `verify-full` TLS.
- Create separate least-privilege application and migration database credentials.
- Preserve direct application-pool timeout settings and prove every migration/query on PS-5.
- Replace Render log streaming with one bounded Fluent Bit application-log path while keeping
  Fastify OTLP, DigitalOcean host metrics, and PlanetScale database metrics in their approved homes.
- Implement and verify the four named P2 production-acceptance defects before the managed rehearsal.
- Add provider-specific audit, deploy, rollback, cold-rebuild, incident, rotation, and recovery
  evidence validators.
- Run the approved disposable NYC3 managed rehearsal without representing its results as RIC1
  regional evidence and, later, the separately authorized production launch checklist.

### Out of scope

- Provisioning any resource, changing DNS, installing a live credential, running paid inference,
  or creating a recovery branch during repository implementation.
- Terraform, Pulumi, Ansible, Kubernetes, Docker Swarm, a deployment framework, a hosted control
  plane, self-hosted GitHub runner, or permanent staging environment.
- Multiple active application instances, application autoscaling, load balancers, HA database
  nodes, read replicas, Redis, a pooler, queue, cache, worker, cron service, or background
  deployment service. The separately bounded PlanetScale disk growth in this plan remains in scope.
- DigitalOcean App Platform, Managed PostgreSQL, Spaces, DOCR, paid Droplet backups, or a second
  log/metrics vendor.
- Persisting employee content, PostgreSQL data, or generated backups on the Droplet or Volume.
- Lowering the 20-employee/40-stream workload, changing the 500 ms response-start target, weakening
  the memory/cleanup/correctness gates, or calling a one-off pass sufficient.
- Product features, protocol changes beyond the already required stream-liveness fix, UI redesign,
  model-policy changes, data-retention changes beyond the explicit 84-hour backup margin, or
  unrelated refactoring.
- Claiming one full shared vCPU is a guaranteed dedicated CPU. If noisy-neighbor behavior breaks the
  locked objective, the candidate fails.

## Required repository changes

### 1. Amend authority without erasing history

After explicit implementation authorization, update `docs/prd/README.md`, PRD 02, and PRD 06
before behavior changes:

- identify this document as the active Phase 8 provider amendment;
- replace Render Hobby/Standard/`basic-256mb` with the provisional DigitalOcean/PlanetScale sizes;
- record the explicit change from a private provider network to fixed-source public TLS;
- record self-managed Ubuntu, Caddy, host patching, encrypted Volume, GHCR, explicit gated deploy,
  Fluent Bit application-log forwarding, and provider-native infrastructure metrics;
- retain the same origin, single active instance, single database, no HA, launch workload,
  performance gates, three-day PITR, RPO, RTO, budget, privacy, and model decisions; and
- label the candidate unaccepted until the managed NYC3 rehearsal passes twice and the remaining
  RIC1-specific production evidence is resolved explicitly.

Update the current Phase 8 and Minimal Render records with a prominent pointer to this amendment.
Keep their implementation evidence intact and label only their active provider recommendations
superseded. Do not rewrite Render test dates, sizes, results, or external-gate status.

The implementation record in this document must state the exact frozen baseline commit, every file
changed, every local result, and every external item still unverified.

### 2. Make release identity provider-neutral

Replace `RENDER_GIT_COMMIT` with one production key, `DEPLOYMENT_REVISION`, everywhere:

- `apps/api/src/config.ts` accepts exactly one full 40-character hexadecimal revision in production;
- the Vite build embeds the same exact revision;
- `apps/api/Dockerfile`, container smoke, load reports, CI, telemetry resources, readiness/release
  metadata, and runbooks use the same name;
- the OCI image receives source/revision labels and a full-SHA GHCR tag; and
- no Render compatibility alias or two-key precedence rule remains after the migration.

Tests must fail on a missing, short, malformed, conflicting, or placeholder production revision.
The deployed revision, embedded web revision, OCI label, requested GHCR digest, readiness metadata,
and load evidence must agree exactly.

### 3. Bind the application to loopback and replace trusted-edge handling

Run each application slot with Linux host networking and `HOST=127.0.0.1` on port 3001 or 3002.
Production configuration must require loopback for this topology. The public network exposes only
Caddy on 80/443; neither application port may appear in the DigitalOcean Firewall, UFW, `ss`, or an
external scan.

Caddy is the only trusted proxy hop. Its committed configuration must:

- redirect HTTP to the exact HTTPS origin;
- manage TLS for `chat.capstone.com.ec` with private state on the encrypted Volume;
- bind its admin API to a root/deploy-accessible Unix socket under `/run/capstone-caddy/`, disable
  persisted API configuration with `persist_config off`, and expose no TCP admin port;
- remove inbound `Forwarded`, `X-Forwarded-*`, `CF-Connecting-IP`, and
  `X-Capstone-Client-IP` claims;
- set exactly one private `X-Capstone-Client-IP` value from Caddy's validated remote peer address;
- proxy to only the active loopback slot;
- leave `flush_interval` unset, preserve unknown-length/no-transform NDJSON, and explicitly prohibit
  negative `flush_interval`, response buffering, compression, or a synthesized `Content-Length`;
- avoid access logs entirely, because identity action URLs can contain private fragments or tokens;
- keep Caddy error output bounded and prove it contains no raw URL, query, header, body, or secret;
  and
- reload atomically without dropping existing proxy connections.

The authoritative DNS record is a direct, DNS-only `A` record to the reserved IPv4. Do not enable
Cloudflare proxy mode, another CDN, tunnel, edge proxy, or load balancer: any such hop changes TLS
ownership and makes Caddy's remote peer cease to be the employee. A future proxy/CDN requires its
own approved trust and client-address contract.

Add one typed `CLIENT_ADDRESS_SOURCE` deployment setting with only `socket` and `caddy`. Production
requires `caddy`; development/test default to `socket`; the isolated managed rehearsal explicitly
opts into `caddy` even though its fake-provider runtime is non-production. This separates the proxy
trust boundary from provider/model test mode without creating a test route or weakening production.

Update `apps/api/src/security/client-address.ts` so `caddy` accepts the private header only when the
uncaptured socket peer is exactly the configured loopback proxy. It must still normalize one valid
IPv4/IPv6 address, reject commas/multiple claims, delete the private header before ordinary
application handling, keep Fastify `trustProxy: false`, and preserve socket-IP behavior only when
the explicit source is `socket`.

Tests cover direct spoofing, forwarded-header chains, missing/multiple/invalid private values,
production rejection of `socket`, test-runtime opt-in to `caddy`, non-loopback callers, IPv4/IPv6
normalization, rate-limit identity, and the Better Auth handoff.
A managed origin test must prove that a public caller cannot choose another employee's rate-limit
address. It must also prove that a real client disconnect propagates through default Caddy streaming
to Fastify, aborts the model gateway, and preserves durable partial output. The application UID must
be unable to open Caddy's admin socket while the audited root deploy path can validate/reload it.

### 4. Add a narrow encrypted secret-file boundary

Droplet local disks are not encrypted at rest. No production credential may be persisted there in a
unit file, shell profile, Docker configuration, `.env`, cloud-init user data, command argument, or
container environment declaration visible through `docker inspect`.

Add one small API-owned startup module that:

1. opens a configured absolute JSON secret file from the read-only mount;
2. rejects a symlink, non-regular file, unsafe owner/mode, oversized file, malformed JSON, unknown
   key, missing required key, non-string value, or duplicate source;
3. loads only the existing approved secret configuration keys into `process.env` before importing
   the normal server or operator command;
4. never prints a key name/value pair or the input document; and
5. closes and discards the read buffer before normal startup.

Keep non-secret production configuration in the root-owned systemd unit/environment definition.
Use separate files for runtime and migration/operator database credentials. On the host, each file
is root-owned and group-readable only by a dedicated numeric supplemental group supplied to the
non-root container. The Volume is mounted `nodev,nosuid,noexec`; application files are mounted
read-only. Host-wide and per-unit core-dump controls cover every secret-bearing process.

The encrypted Volume contains only:

- runtime secrets;
- migration/operator secrets;
- the read-only GHCR pull credential/configuration;
- the Fluent Bit New Relic log-ingest credential; and
- Caddy's certificate/account private state.

These occupy separate least-readable subdirectories. The application cannot read migration, GHCR,
New Relic-log-forwarder, or Caddy files; Caddy cannot read application/registry/telemetry files;
Fluent Bit can read only its New Relic log-ingest credential; and only the root deploy path can read
the migration and GHCR material. Do not mount the whole Volume into any container.

It does not contain PostgreSQL data, employee exports, prompts, responses, summaries, search terms,
load fixtures, application logs, database logs, or recovery evidence. The source of truth for
secret recovery remains an approved Capstone-controlled external password/recovery store. A lost
Volume must be replaceable within the four-hour RTO without restoring a Droplet snapshot.

### 5. Harden the one host without inventing a platform

Add a narrow `deploy/digitalocean/` directory containing exact, audited artifacts rather than a
generic infrastructure framework:

- `cloud-init.yaml` — secret-free first-boot users/packages/firewall/automatic security-update
  baseline;
- `Caddyfile` — public TLS and trusted-proxy boundary;
- `capstone-chat@.service` — one root-owned systemd template for slot A/B containers;
- `capstone-boot.service` — boot-time and failed-deploy reconciliation from the single
  active-release symlink;
- `capstone-fluent-bit.service` and `fluent-bit.conf` — bounded application-log forwarding only;
- `deploy.sh` — locked, fail-closed migration/blue-green activation/rollback flow, invoked only by
  a supervised root-owned systemd oneshot whose failure action runs `capstone-boot.service`;
- `maintenance.caddy` — root-controlled, content-free 503/`Retry-After` behavior for a real
  database cutover or corrupting-write incident, disabled during ordinary operation;
- `verify-host.sh` — read-only host/topology/security evidence; and
- `README.md` — exact installation paths, ownership, versions, and manual commands.

The implementation may consolidate files only when that produces a smaller direct control flow;
it must not introduce a reusable deployment library.

The source-controlled host contract is:

- Ubuntu 24.04 LTS on the USD 6 Basic 1 vCPU / 1 GiB size, with production bound to RIC1 and only
  the explicit non-production managed rehearsal bound to NYC3;
- one named non-root SSH operator, key authentication only, no password login, no root SSH login,
  and MFA/recovery on the DigitalOcean account;
- no ordinary user in the `docker` group, because Docker control is root-equivalent; deployment
  uses one audited root-owned script through an explicit sudo boundary;
- dedicated unprivileged `caddy` and `capstone-fluent-bit` service users, separate Volume
  subdirectories/groups, and systemd sandboxing that grants each process only its required files,
  sockets, network families, and write paths;
- DigitalOcean Cloud Firewall plus UFW allowing 80/443 publicly and SSH only from the operator's
  exact approved `/32`; all other inbound traffic denied;
- an IPv4-only initial public origin: publish only the reserved-IPv4 `A` record and keep public IPv6
  disabled/denied until a separately measured dual-stack amendment owns its proxy, firewall,
  monitoring, and recovery behavior;
- a free assigned reserved IPv4 configured and tested as the persistent outbound source across a
  reboot;
- no public application ports, Docker API, database, metrics endpoint, or Fluent Bit input;
- DigitalOcean Monitoring enabled, one external HTTPS readiness Uptime check, UTC time sync, and
  alert delivery tested;
- unattended Ubuntu security updates, with controlled reboot and application smoke documented;
- reviewed/pinned-at-install Docker Engine, Caddy, and Fluent Bit sources/versions recorded in
  evidence, with a monthly patch procedure rather than unobserved service-changing upgrades;
- host-wide coredump storage disabled, `LimitCORE=0` on every application, migration, Caddy, Fluent
  Bit, and secret-handling unit, and container `core=0` ulimits. No coredump may persist a runtime,
  database, registry, telemetry, or TLS credential on the root disk;
- no swap unless a separately reviewed encrypted or memory-only design is approved. Capacity must
  pass without using unencrypted disk swap; and
- no persistent authoritative data on the root disk.

Run the application container as the existing non-root `node` user with a read-only root filesystem,
bounded tmpfs, all Linux capabilities dropped, `no-new-privileges`, a PID limit, a 640 MiB memory
and memory+swap limit, and no Docker restart loop that can conceal repeated startup failure. The
host's one vCPU is shared with Caddy, Docker, Fluent Bit, and Monitoring, so do not claim the app has
one dedicated CPU quota.

The 640 MiB limit is a proposed containment boundary, not a new product gate. The exact managed
rehearsal may show that it is too high for host overlap or unnecessarily low for Node. Any change is
recorded with the observed whole-host/application memory, repeated from a clean run, and approved
before the production manifest changes.

### 6. Publish and retain one immutable OCI artifact

Keep `apps/api/Dockerfile` as the one production application artifact. Do not create a
DigitalOcean-specific application image. CI must:

1. run the existing quality, repository, operations, TypeScript, test, build, bundle, migration,
   Playwright, dependency, image-content, non-root, and container-smoke gates;
2. only after all exact-commit jobs succeed, build the release image with the full revision;
3. repeat the image-content/non-root/smoke assertions on the exact image that will be pushed;
4. authenticate to GHCR with job-scoped `GITHUB_TOKEN` and the smallest `packages: write`
   permission;
5. push a repository-linked private image tagged with the full commit and record its digest; and
6. never publish a failed, pull-request, untrusted-fork, dirty-tree, `latest`-only, or mutable-only
   production candidate.

Deployment always references `ghcr.io/<owner>/<image>@sha256:<digest>`. The full-SHA tag is
diagnostic; the digest is the executable identity. Retain at minimum the current and immediately
previous compatible digests, and target five recent accepted releases while the current GHCR
contract remains free. A tested cleanup command must refuse to delete an active, previous, or
recovery-pinned digest.

The Droplet's GHCR credential is a classic PAT with only `read:packages`, because GHCR CLI pulls do
not currently accept a fine-grained PAT. Prefer a dedicated Capstone deployment identity granted
read access only to this private package and no unrelated repository/package; a classic PAT can
read every package its owner can access, so identity scope is the effective blast-radius boundary.
Record MFA, SSO authorization where required, recovery under the approved one-owner Bitwarden
posture, the deferred second-owner risk, and whether the identity consumes a paid GitHub seat. If it
adds recurring cost, stop and amend the USD 11.10 infrastructure / USD 15.10 operational estimate
before provisioning. Store its Docker configuration on the encrypted Volume, never under `/root`
on the local disk. Rotation and account recovery are explicit runbook steps.

### 7. Use a bounded, CI-gated blue/green deploy

Do not expose SSH to GitHub-hosted runner address ranges, install a self-hosted runner, or run an
image watcher. Initial production deployment is an explicit operator action after checking the
exact commit's GitHub Actions result. This intentionally replaces Render `checksPass` automation
without weakening the “checks before deploy” rule.

Use one durable active-release authority: an atomically replaced root-owned symlink under
`/var/lib/capstone-chat/active` to an immutable release directory containing the slot, port, digest,
revision, and Caddy upstream fragment. The symlink and referenced metadata contain no secret. Caddy
runtime configuration, systemd running state, Docker names, and a separate “current slot” file are
not competing authorities. On boot and at the start of every deploy, the reconciliation path reads
the symlink, verifies its metadata/container labels, starts the named slot, and loads that exact
upstream through the permissioned Caddy Unix admin socket.

`deploy.sh` must be idempotent where safe and fail closed. Its normal flow is:

1. acquire a host deployment lock, reject concurrent deploy/rollback/migration operations, and
   reconcile live Caddy/systemd/Docker state back to the durable active-release symlink if an earlier
   process died before commit;
2. validate a full revision, immutable digest, current active release, disk/memory headroom, an
   encrypted Volume whose block-device `MAJ:MIN` differs from root and whose resolved device has the
   exact approved size, secrets, the anchor route and externally observed reserved outbound IP,
   PlanetScale TLS, and exact passing CI evidence recorded by the operator;
3. pull the digest with the encrypted-Volume GHCR configuration and verify OCI revision labels;
4. run all forward migrations once in a short-lived non-root container using the separate direct
   migration credential; never migrate during application startup;
5. create and fsync an immutable candidate release directory, then start its inactive slot on the
   alternate loopback port with the exact runtime restrictions;
6. verify liveness, readiness, release identity, migration, database access, strict production
   telemetry configuration, OpenRouter policy mode, and credential-free direct static/API/
   anonymous-session smoke without exposing the slot publicly;
7. validate and load the candidate upstream through Caddy's Unix admin socket while the durable
   symlink still points to the old release, preserving established connections;
8. verify public new traffic reaches the candidate and passes credential-free static/API/
   anonymous-session/revision smoke. On failure, reload the durable old fragment and stop the
   candidate without changing the symlink;
9. atomically replace and fsync the active-release symlink only after the live switch passes. There
   is no separately enabled slot state to update;
10. signal the old slot to drain after the durable commit and after it stops receiving new requests,
   preserving the existing
   5-second ordinary drain, 240-second stream grace, 30-second forced cleanup, database/email
   cleanup, and telemetry flush bounds;
11. preserve the stopped container until systemd success, no OOM, and exit code zero are verified;
    write a memory-backed clean-shutdown acknowledgement before removal, fail loudly on timeout,
    exit 137, or forced systemd kill, and retain its digest;
12. repeat the credential-free public smoke, then emit one exact content-free journal record with a
    UTC `activatedAt`, full revision, and digest and report activation complete but acceptance
    pending; and
13. have the named `adm` operator copy only that bounded record into the authorized external change
    evidence, then prune only unprotected old images. Release `createdAt` remains pre-activation
    metadata and is never presented as activation evidence.

Credentialed custom-origin sign-in, authenticated session/API, NDJSON generation, and Stop/
cancellation recovery are a separately authorized post-activation acceptance gate. They require a
real operator account and may invoke a paid provider; no deployment credential, production test
route, or authentication bypass belongs in the supervised state machine. The release remains
unaccepted until the operator records that gate. The old digest remains protected throughout.

The empty database has one narrow ordered bootstrap path before any active release exists. First,
`identity-bootstrap <revision> <digest>` accepts the full immutable image reference, rejects any
existing active symlink, validates exact CI evidence and OCI labels, pulls through the read-only
encrypted-Volume registry credential, runs forward migrations with the migration-only secret, and
creates the workspace through the identity boundary. Then `model-policy-initialize` validates the
same image and binds the locked OpenRouter policy to that workspace. Neither command creates release
authority; the following normal deploy reruns forward migrations idempotently. Every operator path
validates the secure Volume's distinct block-device identity, exact size, and mount restrictions
before reading a secret, and every migration-secret mount revalidates the exact one-key schema.

If the deploy process dies after the live Caddy switch but before the symlink commit, the old release
remains durable authority and has not begun draining; systemd's failure action immediately runs the
same reconciliation used at boot and rolls live traffic back to it. If the host loses power, boot
reconciliation applies that authority before readiness; if failure occurs after the atomic commit,
it chooses the candidate. The deploy path may not be run as an unsupervised shell process. Tests
terminate the supervised process group and simulate the durable state left before and after the
migration, start, reload, public-verification, symlink, and drain boundaries. Killing the installed
systemd unit and power-cycling the actual host across that matrix remain managed-rehearsal gates;
local process fixtures are not labeled as host power-loss evidence. A failed Caddy load never leaves
candidate state on disk that would activate only after reboot.

Systemd gives Docker's 300-second application grace a 330-second unit envelope. The deployment unit
uses a 2,400-second valid-path budget and a 1,200-second failure-convergence budget; boot uses exact
900-second start/stop envelopes for two-slot reconciliation; and operator work uses 1,800-second
start plus 210-second cleanup envelopes. These values enclose the individually bounded pull,
migration, start, smoke, drain, reconciliation, and cleanup subprocesses with explicit host/daemon
headroom. A Caddy reload must
not reset active NDJSON streams. Both old-loaded/new-idle and new-loaded/old-draining overlap are
part of the 1 GiB acceptance test.

Rollback uses only the immediately previous schema-compatible digest. It starts that digest in the
inactive slot, checks it against the current expanded schema, switches Caddy, and drains the bad
slot through the same path. It never reverses a migration or uses PITR for application rollback.

The maintenance switch is not part of an ordinary deploy. It atomically makes Caddy return a
generic uncached 503 with `Retry-After`, leaves health available only to the operator's loopback
checks, and blocks all employee reads/writes while a real recovery cutover changes database
authority. Enabling or disabling it is deployment-locked, audited, and covered by public-origin
tests; it exposes no diagnostics, generated hostname, or bypass header.

If two-slot overlap cannot pass safely on the USD 6 host, stop. Do not silently replace it with an
unplanned stop/start outage or weaken stream drain. Present the measured memory/CPU cause and either
a user-approved deployment availability tradeoff or the next vertical size.

### 8. Make PlanetScale compatibility executable

Create the PlanetScale cluster as PostgreSQL 18.4, PS-5 ARM Single Node, AWS `us-east-1`, with the
included 10 GB initial storage, autoscaling enabled, a hard 15 GB storage limit, and no replicas.
That permits one minimum 50% growth and caps the current allocated-storage increase at USD 0.625
per month. Record warnings before 60% utilization and a critical operator action before the 70%
provider growth threshold; if the selected plan lacks an alert, the launch-week/daily review owns
it. ARM is selected because the next proposed PS-10 ARM step is USD 10; provider documentation says
CPU architecture cannot be changed in place, so choosing x86 would close that cheapest path.

Use three credential boundaries:

- **application role:** direct port 5432, `sslmode=verify-full`, no ownership/DDL/admin privileges,
  and membership only in the provider-supported read-all/write-all data roles or an equally narrow
  explicitly tested grant set; and
- **migration role:** direct port 5432 with only the provider privileges needed for the current
  migrations, extension management, bootstrap, and recovery preparation. It is mounted only into
  migration/operator containers and never the long-running app; and
- **default near-superuser role:** rotate immediately after cluster creation, store only in the
  approved external recovery store, and use only when a provider-only extension/role/recovery task
  cannot be delegated safely. It never lives in the application file or ordinary deploy path.

One database-wide IP restriction applies to all roles and schemas, including the default role, and
normally contains only the Droplet's verified outbound reserved IPv4 `/32`. If rehearsal fixture
assertions require a separate load runner, add only its exact `/32` to that database-wide rule and
give it a separately limited credential; never copy the default/migration credential to the runner.
Afterward revoke the runner credential, terminate every associated backend from the trusted
Droplet, remove its `/32`, close/reopen the ordinary pools, and prove new and previously established
bad-source connections are gone before evidence passes. The production database never opens to
`0.0.0.0/0` or an operator laptop as a convenience.

Keep the application pool at ten only if PS-5's live connection limit and memory behavior pass.
Retain the existing five-second connection, query, statement, lock, and idle-in-transaction bounds.
Runtime initially uses direct port 5432 because the current `options` string is a safety contract.
The one-connection migration pool also uses direct access. Do not switch to local PgBouncer merely
because it is included; first prove startup settings, named prepared statements, transaction
semantics, timeout enforcement, and latency under the full suite.

The managed database gate must cover:

- empty migration through the current migration number and upgrade from the accepted Phase 7/8
  snapshots;
- `unaccent`, generated search columns, GIN indexes, recursive CTEs, deferred/composite foreign
  keys, partial unique indexes, advisory locks, `FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED`, JSONB,
  numeric precision, timestamps, and every manual migration object;
- all Better Auth tables and transactional identity behavior;
- the exact four named prepared statements through reconnects;
- statement, lock, query, and idle-transaction timeout enforcement;
- application-role denial of DDL, role changes, extension changes, and other administrative work;
- migration-role success without using the application credential;
- direct TLS hostname verification and failure with a bad hostname/CA/credential/source IP;
- bad-source denial for the application, migration, default, and temporary runner roles, including
  explicit termination after an IP-rule change because provider rules affect only new connections;
- pool total/idle/waiting, PS-5 connections/CPU/RAM/I/O/locks, Query Insights, and reconnect behavior;
- bounded 10-to-15-GB autoscaling/surge connection recovery plus audit failure above the storage
  ceiling; and
- every correctness, budget, accounting, cancellation, compaction, search, branch, archive, and
  administration integration test.

### 9. Preserve three-day PITR on PlanetScale

Configure one custom automatic backup schedule every 12 hours with 84-hour retention. Immediately
after an older backup expires, the next-oldest scheduled backup is still at least 72 hours old;
record continuous oldest-selectable-point samples across a rotation boundary rather than one lucky
timestamp. Record the live schedule, oldest selectable PITR point, newest excluded interval,
backup/WAL usage, included allowance, and projected overage. The extra 12-hour margin is an explicit
finite data-retention amendment accepted with this plan; do not call PlanetScale's default two days
or a bare 72-hour retention setting equivalent.

Add or extend a narrow recovery-preparation operator command for a newly restored branch. Because
PlanetScale does not restore extensions or external connection settings, it must idempotently:

- install/verify `unaccent` before relying on the existing migration ledger;
- verify PostgreSQL version and all migration-owned functions/indexes/constraints;
- require separately recreated application and migration credentials;
- require the correct `/32` restrictions and `verify-full` URLs;
- verify application startup options and timeouts; and
- emit only closed, content-free status evidence.

The restore rehearsal always creates a separate billed branch in the same PlanetScale region and
keeps the source untouched. Validate pre/post markers, migration ledger, constraints, search,
identity, conversation structure, drafts, compactions, generations, reservations, accounting,
reconciliation, one fake read/write flow, and RPO/RTO without OpenRouter or Resend.

A real database-authority cutover never uses ordinary blue/green overlap. Its separately locked
state machine is:

1. acquire the deployment/recovery lock and enable the generic maintenance response for all public
   employee traffic;
2. mark every old-authority application slot unready, cancel/drain active requests and streams
   through the bounded shutdown contract, then stop all slots;
3. prove no application process or pool remains connected and no application write can reach the
   old source;
4. atomically replace the encrypted runtime database secret with the validated restored-branch
   credential while Caddy remains in maintenance;
5. start exactly one slot on the restored branch, verify release/migration/markers/readiness and the
   critical fake-or-authorized local smoke through loopback, and prove its connections target only
   the restored branch;
6. disable maintenance, run public critical smoke, and begin the accepted new-authority write
   window; and
7. preserve the old source and both credential versions until independent cutover acceptance and a
   documented rollback/data-divergence decision.

Established NDJSON connections are explicitly terminated before step 4; a Caddy maintenance reload
alone is not a write fence. Never restore over or delete the source as part of the rehearsal.

Droplet snapshots are not database recovery. The application host must pass a separate cold rebuild
within RTO using source-controlled artifacts, GHCR, external secret recovery, a new encrypted
Volume, and reserved-IP reassignment.

### 10. Rebuild observability around the new ownership boundary

Preserve the existing direct Fastify OTLP traces/application metrics and content-free structured
Pino output. Route signals as follows:

```text
New Relic Free
  - Fastify OTLP traces
  - Fastify application metrics
  - Fluent Bit forwarded Capstone application JSON logs only

DigitalOcean dashboard/alerts
  - Droplet CPU, load, RAM, disk, bandwidth, process/reboot availability
  - external HTTPS readiness/TLS Uptime check

PlanetScale protected dashboard
  - database CPU, RAM, storage, connections, locks, backups, WAL, Query Insights
```

Fluent Bit must:

- run as its dedicated unprivileged user and accept Docker's Fluentd driver only over a permissioned
  Unix socket that is not mounted into either host-network application container;
- forward only the Capstone container's JSON stdout/stderr, not Caddy access, journald, auth,
  Docker daemon, SSH, kernel, or raw PostgreSQL logs;
- use its built-in HTTPS output—not New Relic's separately installed native output plugin—with the
  approved New Relic Log API endpoint/credential from its isolated encrypted-Volume directory;
- set Docker `fluentd-async=true`, `fluentd-buffer-limit=1024`, `fluentd-retry-wait=1s`,
  `fluentd-max-retries=10`, `fluentd-write-timeout=1s`, `mode=non-blocking`,
  `max-buffer-size=4m`, and `cache-disabled=true` on both slots;
- use at most 8 MiB of Fluent Bit in-memory input buffering, no filesystem buffer, and ten bounded
  HTTPS output retries. Validate the exact installed versions support every option;
- never make readiness depend on delivery after valid startup configuration;
- deliberately drop new/old log records when those bounded memory/retry limits are exhausted rather
  than blocking employee traffic or writing to disk. This availability-over-telemetry loss policy
  is explicit, counted safely where possible, alerted/rehearsed, and recorded during an incident;
- preserve structured safe fields and reject/truncate unexpected oversized records; and
- pass a deliberate sample audit for prompts, responses, summaries, searches, titles, drafts,
  emails, cookies, authorization values, identity URLs, raw URLs/query strings, provider bodies,
  database URLs, and credentials.

The Docker application container must not retain the remote driver's automatic dual-logging cache,
default JSON logs, or any other application record on the unencrypted root disk. Caddy access
logging remains disabled. System logs remain bounded and must never receive secret values or
application content. Test start, restart, sustained logging, and application availability with
Fluent Bit absent, its socket unavailable, and New Relic refusing/timing out requests.

Do not export PlanetScale server logs or raw Query Insights to New Relic. Database diagnostics can
contain SQL or values and remain in the provider's protected operator view. Operational evidence
records counts, timings, plans with synthetic values, and categories only.

Alert and rehearse:

- DigitalOcean high CPU/load, memory pressure, disk pressure, restart/unreachable, bandwidth, and
  TLS/readiness failures;
- New Relic application readiness/5xx/latency, response-start, provider timing/outcome, active work,
  budget rejection, settlement/reconciliation, pool waiting, Resend category, client error, and
  OTLP/log-delivery health; and
- PlanetScale CPU/RAM/connections/storage/backup/WAL thresholds and notification support available
  on the selected plan.

Where PS-5 lacks a provider alert, the runbook names a manual review cadence. Do not create a polling
worker or another monitoring backend to simulate a missing plan feature.

### 11. Replace Render-specific CI, audits, and runbooks

Remove active `render.yaml` only after the provider amendment and replacement artifacts land in the
same verified change. Historical plans may reference it as superseded evidence. No active README,
PRD, runbook, CI job, audit, or production configuration may still instruct an operator to use
Render.

Strengthen `scripts/operations-audit.mjs` and its self-tests to validate the exact new artifacts:

- one 1 vCPU / 1 GiB RIC1 Droplet candidate and one 1 GiB encrypted Volume;
- one PS-5 ARM Single Node PostgreSQL 18.4 `us-east-1` candidate with 10 GB initial/15 GB maximum
  storage and 12-hour backups retained for 84 hours;
- public ports 80/443, SSH `/32`, loopback-only application slots, and no public database/app ports;
- Caddy header stripping, private address overwrite, Unix admin socket, `persist_config off`, no
  access log, default cancellable NDJSON streaming with negative flush forbidden, and encrypted
  state path;
- direct/DNS-only IPv4 public DNS/firewall behavior and the deployment-locked content-free
  maintenance switch;
- non-root/read-only/capability/PID/memory/core-dump container restrictions;
- host-wide core-dump denial and unprivileged sandboxed Caddy/Fluent Bit users;
- immutable digest deploy, one atomic active-release authority, migration-before-activation,
  crash-safe readiness/switch/drain, and rollback rules;
- secret-file paths on the encrypted Volume with no secret literals;
- Fluent Bit built-in HTTPS application-only forwarding, Unix input, exact bounded/drop options,
  and disabled Docker dual-log cache;
- exact release identity, GHCR publication after all CI jobs, and protected digest retention;
- direct `verify-full` PlanetScale connections, separate credentials, and `/32` restrictions; and
- recovery evidence for both PlanetScale PITR and Droplet cold rebuild.

Self-tests must fail on a second service, open SSH/database/application/admin/log port, proxied DNS,
root container/host service, missing header strip, negative flush, access logging, mutable image,
split active-slot authority, migration at startup, unencrypted/cross-readable secret path, enabled
core dump/log cache/disk buffer, unbounded logging retry, external log plugin, weakened TLS, missing
database-wide role restriction, storage above 15 GB, backup cadence/retention drift, relaxed
workload/latency, or deleted rollback digest.

Rewrite the existing operations set in place rather than creating a parallel handbook:

- `docs/operations/README.md` — provider ownership, external account recovery, routine inspection,
  and evidence rules;
- `provision-and-deploy.md` — DO/PS/GHCR prerequisites, exact order, host bootstrap, secret install,
  database roles, policy/identity bootstrap, Caddy/DNS/TLS, smoke, and cost confirmation;
- `deploy-and-rollback.md` — CI result, digest, migration, slot switch, stream drain, compatible
  rollback, patch reboot, and evidence;
- `database-recovery.md` — 12-hour backup cadence, 84-hour retention, continuous 72-hour PITR,
  restored-branch preparation, isolated recovery, cutover, RPO/RTO, and cold host rebuild;
- `incident-response.md` — DigitalOcean, Caddy, Docker/systemd, Fluent Bit, PlanetScale, New Relic,
  Resend, OpenRouter, maintenance, resize, and source preservation;
- `providers-and-budget.md` — unchanged provider/model/budget rules plus the new telemetry/database
  control planes;
- `secret-rotation.md` — encrypted files, atomic rotation, app/migration roles, GHCR, Caddy account,
  New Relic, Resend, OpenRouter, Better Auth, SSH, and DO/PS account credentials;
- `domain-and-tls.md` — reserved IP A/AAAA policy, Caddy ACME, CAA, redirect/HSTS, stream flushing,
  and rollback; and
- `employee-access.md` — preserve application behavior while running operator commands through the
  exact migration/operator container boundary.

README environment/deployment examples become provider-neutral and use placeholders only. No
command may put a secret in shell history or process arguments.

### 12. Close the four existing P2 launch blockers

Provider work does not waive the previously named product-boundary defects. Implement them before
the managed load/deploy rehearsal:

1. **Silent-stream heartbeat:** add the approved content-free NDJSON heartbeat so a quiet provider
   interval remains distinguishable from a dead Caddy/network connection.
2. **Browser stream watchdog:** bound silent or truncated streams, adopt canonical durable state,
   and never duplicate or erase visible partial content.
3. **Mid-use 401/session transition:** move an already open app to the signed-out boundary on expiry
   or revocation and fence completions from the old authentication generation.
4. **Frozen interrupted response:** render canonically interrupted/incomplete output as terminal and
   actionable after recovery/reload rather than leaving a false streaming state.

If the heartbeat changes the public stream contract, update the protocol schema and the relevant
locked PRD/Phase 4–8 cross-references explicitly. Keepalive bytes must remain content-free and must
not affect response accounting, first-token timing, visible message content, checkpoint revision,
or completion semantics.

Tests include silent provider intervals longer than every proxy idle threshold, truncated bodies,
missing terminal events, Stop/cancel, archive/rename/delete, navigation, session revocation, reload,
Caddy drain, backpressure, and canonical recovery.

## Managed NYC3 rehearsal before launch checklist

Repository completion is necessary but insufficient. Before the production launch checklist starts,
request immediate authorization for a disposable rehearsal with:

- one exact USD 6 Basic 1 vCPU / 1 GiB NYC3 Droplet;
- one assigned reserved IPv4, exact firewall, Monitoring/Uptime, and 1 GiB encrypted Volume;
- one exact PS-5 ARM Single Node PostgreSQL 18.4 cluster in AWS `us-east-1`;
- the exact accepted GHCR digest, Caddy/systemd/Fluent Bit configuration,
  `CLIENT_ADDRESS_SOURCE=caddy`, application/migration/default-role boundaries, direct TLS path,
  15 GB storage ceiling, and 12-hour/84-hour backup policy;
- one temporary controlled rehearsal hostname and certificate;
- the same production-built image in the existing explicitly non-production test runtime, with the
  fake model gateway, email disabled, dedicated content-free telemetry labels/credentials, no
  production secrets/data, and no paid inference; and
- one short-lived separate load-runner in NYC3 or another accepted non-competing source. The load
  generator must not consume the candidate Droplet's CPU/RAM or distort the measured server.

Production mode and the final origin must continue rejecting the fake gateway and disabled/fake
email. The rehearsal qualifies the image's resource, database, proxy, deployment, and failure
behavior; it does not claim final production configuration, Resend, OpenRouter, public DNS, or the
exact custom-origin certificate. It also does not qualify RIC1 scheduling, availability, or
RIC1-to-`us-east-1` latency. Those remain explicit launch-checklist gates unless the user separately
amends the production region.

The load runner uses generated fixtures and its own temporary PlanetScale role/IP rule only if
fixture assertions require database access. Remove the role/rule, terminate its connections, and
destroy the runner before evidence is accepted. Never add a production test HTTP route.

### Database and topology qualification

Before load:

1. prove persistent reserved-IP outbound routing across reboot and match PlanetScale's observed
   source `/32`;
2. apply every migration to a new empty cluster and prove an upgrade path;
3. run the complete PostgreSQL integration suite and the compatibility cases listed above;
4. prove application-role denial and migration-role success;
5. prove TLS hostname verification and IP restrictions fail closed;
6. verify Caddy spoof resistance, headers, security/cache policy, and timed NDJSON flushing;
7. verify no secret in cloud-init, root disk, image, unit, process arguments, Docker inspection,
   logs, telemetry, or evidence;
8. verify application ports are loopback-only and scans find only intended public services; and
9. baseline whole-host, per-process, container, network, and PS-5 resource use at idle.

### Capacity qualification

Run the unchanged 20 registered employees, 20 simultaneous sessions, and 40 active chat streams.
Use the current 10 warm-up waves plus five measured waves and every existing representative API,
draft, history, search, admin, cancellation, failure, accounting, and cleanup action.

Run the final candidate twice from fresh database state. Both runs must pass without retry,
threshold waiver, host reboot, manual cleanup, resize, pooler switch, or changed fixture. Capture:

- ordinary API p50/p95/p99 and unexpected 5xx;
- admitted send-to-`response.started` p50/p95, with p95 at most 500 ms;
- provider first-delta and browser-visible timing separately from application admission;
- cancellation p50/p95, stream outcomes, NDJSON ordering/completeness, heartbeat/watchdog behavior,
  and canonical partial-output recovery;
- all 40 workflow/reservation admissions, expected completion/cancellation/failure counts, budget
  invariants, settlement, reconciliation, ownership isolation, and pool release;
- peak/idle application RSS/heap, monotonic-memory gate, event-loop delay, process CPU, and container
  OOM/restart/throttle state;
- whole-host CPU/load/RAM/swap/disk/network, Docker/Caddy/Fluent Bit/Monitoring overhead, and both
  blue/green overlap states;
- application pool total/idle/waiting plus PS-5 CPU/RAM/connections/I/O/locks/storage/Query Insights;
  and
- exact image digest/revision, host size/region/kernel, package versions, container restrictions,
  PostgreSQL version/size/region, migration, connection mode, and backup policy.

An isolated one-time pass does not qualify the tier. Shared-CPU variance is part of the candidate,
not an excuse to discard a slow measured wave.

### Deploy, failure, and recovery qualification

On the same rehearsal topology:

- deploy a compatible candidate while long fake streams are active; prove new traffic switches,
  existing streams drain/terminate canonically, no visible partial output is lost, and the 1 GiB
  host survives overlap;
- roll back to the previous compatible digest and return to the candidate;
- reboot after security updates and prove reserved outbound IP, encrypted Volume, Caddy, secrets,
  active slot, readiness, telemetry, and database restrictions recover in dependency order;
- destroy and cold-rebuild the rehearsal Droplet/Volume from source, reassign the reserved IP,
  restore secrets from the approved external source, reconnect to the untouched PS cluster, and
  prove RTO at most four hours;
- simulate New Relic, Fluent Bit, PlanetScale, Resend, and OpenRouter outages without making
  telemetry a readiness dependency or weakening privacy/budget rules; and
- inspect every provider/host/log/trace/metric/evidence surface for prohibited content.

PlanetScale three-day PITR needs aged history. Keep only the separately authorized rehearsal branch
long enough to expose the full window, create an isolated restored branch, run recovery preparation,
and prove RPO at most 15 minutes and RTO at most four hours. Record its prorated cost, then remove
both recovery resources after acceptance. The source stays untouched.

### Failure response

If either final run or any security/correctness/recovery gate fails:

1. keep workload, latency, correctness, memory, RPO, and RTO gates unchanged;
2. classify the cause as shared CPU, host RAM, host support-process overhead, Caddy/deploy behavior,
   network, PS-5 CPU/RAM/I/O/connections, query/lock behavior, or harness defect;
3. fix only a bounded application/configuration defect consistent with the existing architecture
   and repeat all affected gates from clean state; and
4. if healthy code is resource-bound, stop and present the measured smallest vertical option and
   recurring cost. Do not resize without user approval and a source-controlled amendment.

The first proposed escape hatches are:

| Measured bottleneck | Proposed next candidate | Estimated base total |
|---|---|---:|
| Host memory only | DigitalOcean 1 vCPU / 2 GiB at USD 12; PS-5 and Volume unchanged | USD 17.10/month |
| Host CPU/shared-CPU latency | DigitalOcean 2 vCPU / 2 GiB at USD 18; PS-5 and Volume unchanged | USD 23.10/month |
| Database CPU/RAM | PS-10 ARM Single Node at USD 10; USD 6 Droplet and Volume unchanged | USD 16.10/month |
| Host and database | measured combination of the above | recalculate live |

These are options, not automatic actions. DigitalOcean CPU/RAM resizing requires a controlled
power-off and smoke. PlanetScale resizing can interrupt connections briefly and must pass
reconnect/stream/reconciliation checks. No resize changes the locked workload or objectives.

## Implementation sequence

Implement only after explicit repository authorization, in these independently verifiable batches:

1. **Freeze the accepted tree.** Resolve/preserve the existing dirty Render-amendment work, record
   the exact baseline SHA and gates, and do not lose user changes.
2. **Amend authority.** Update PRD 02/06, PRD index, Phase 8 pointers, and this plan's status before
   provider behavior changes.
3. **Close the four P2 blockers.** Add focused failing protocol/API/web/browser tests, implement the
   bounded fixes, and pass the full streaming/session matrix.
4. **Generalize release/configuration.** Replace Render revision naming, require loopback production
   binding, and add the strict secret-file loader with tests.
5. **Replace trusted proxy.** Implement Caddy-private header handling and unit/integration spoof
   tests before writing host configuration.
6. **Add exact host artifacts.** Land Caddy, systemd, cloud-init, Fluent Bit, deploy, verification,
   and ownership/mode contracts without credentials.
7. **Publish immutable images.** Make GHCR publication depend on all CI jobs and prove the exact
   pushed digest with image/container smoke.
8. **Add database/recovery compatibility.** Implement role/bootstrap/restore-preparation helpers and
   all PlanetScale-specific executable tests without connecting to a live paid cluster.
9. **Replace audits and runbooks.** Remove active Render configuration only together with exact
   DigitalOcean/PlanetScale audit coverage and rewritten operations documentation.
10. **Run local gates.** Run formatting, repository/operations audits, TypeScript, all tests,
    Playwright, builds, image smoke, migration paths, dependency audit, secret/boundary scan, and
    `git diff --check`.
11. **Independent read-only review.** Review PRD conformance, provider trust, secret handling,
    deployment races, migration/recovery, observability privacy, cost claims, and historical
    honesty. Resolve every P1/P2 within scope.
12. **Request managed-rehearsal authorization.** State exact resources, maximum expected prorated
    cost, credentials/DNS involved, cleanup, and rollback before creating anything.
13. **Run and record exact rehearsal.** Accept the USD 11.10 candidate only after two final capacity
    passes plus deploy, reboot, cold rebuild, privacy, and aged PITR evidence.
14. **Freeze the production candidate.** Record exact sizes, revisions, digests, versions, costs,
    limitations, and remaining external/manual launch gates. Only then begin the launch checklist.

## Verification matrix

### Ordinary repository gate

Run from the repository root:

```text
pnpm check
pnpm verify:repository
pnpm verify:operations
pnpm typecheck
pnpm test
pnpm build
pnpm report:bundle
pnpm test:e2e
pnpm audit --prod --audit-level high
git diff --check
```

Also build the production image with an exact test revision, inspect non-root/read-only-compatible
contents, run container smoke, apply migrations to empty and upgrade databases, scan source/image
for credentials, and inspect boundaries manually. Literal `pnpm check` must either pass or report
only the already documented globally ignored local file; CI's repository checkout must pass cleanly.

### Focused repository evidence

- Configuration/revision/secret-loader unit and container tests.
- Client-address/Caddy fixture spoof and normalization tests.
- Operations-audit bad-fixture matrix for every topology/security failure.
- Deploy-script dry-run/state-machine tests for migration failure, readiness failure, switch,
  drain, rollback, concurrent lock, stale slot, digest mismatch, and forced stop.
- Fluent Bit configuration parse/test with bounded failure and privacy fixtures.
- Direct PostgreSQL TLS/options/prepared-statement tests against a compatible local TLS fixture where
  feasible; managed-only assertions stay explicitly unverified.
- Recovery-evidence validator for PlanetScale branch preparation, extension recreation, RPO/RTO,
  source preservation, and cleanup.
- Full heartbeat/watchdog/session/interrupted-response protocol/API/web/Playwright regressions.

### External evidence that local tests cannot claim

- Shared-vCPU scheduling and 1 GiB whole-host capacity.
- NYC3-to-PlanetScale `us-east-1` latency and fixed-source public TLS behavior for the rehearsal.
- RIC1 scheduling, availability, and RIC1-to-PlanetScale latency remain unverified production
  evidence unless the production region is separately amended.
- PS-5 CPU/RAM/I/O/connection capacity and exact extension/lock/query compatibility.
- Reserved-IP outbound persistence, Cloud Firewall, Volume encryption, Uptime/Monitoring alerts.
- GHCR live permissions, pull/retention/cost behavior, and operator credential rotation.
- Caddy public ACME/TLS, long-stream flushing, reload/drain, and custom-domain security headers.
- Fluent Bit/New Relic delivery and privacy behavior during outage/backlog.
- DigitalOcean reboot/resize/cold rebuild and PlanetScale resize/reconnect behavior.
- Three-day custom PITR, restore preparation, RPO/RTO, and cleanup.
- Resend DNS/email, OpenRouter privacy/catalog/minimal paid smoke, Ecuador/device/accessibility, and
  all remaining Phase 8 launch acceptance.

No local fixture, Docker limit, provider documentation, or prior Render result may be labeled as
that external evidence.

## Production launch checklist boundary

This amendment deliberately stops before the production launch checklist. That checklist may begin
only after:

- the governing docs and repository implementation agree on this topology;
- all ordinary and focused repository gates pass on one exact commit;
- no unresolved P1/P2 remains, including the four named defects;
- the disposable NYC3 USD 6/PS-5 managed rehearsal passes twice and its evidence is not relabeled
  as RIC1 regional evidence;
- deploy/drain/rollback, reboot, cold rebuild, observability privacy, and aged PITR pass;
- the live steady-state and variable cost estimate is recorded and accepted;
- all rehearsal roles, IP rules, DNS, credentials, images, Droplets, Volumes, branches, and load
  runners are either intentionally retained as the accepted candidate or removed and verified; and
- production actions receive fresh explicit authorization.

The later guided launch checklist then owns account creation/recovery, production provisioning,
secrets, DNS/TLS, Resend, New Relic, OpenRouter bootstrap/smoke, employee bootstrap, custom-origin
smoke, devices/accessibility, Ecuador measurements, alerts, real rollback, production PITR, and
launch sign-off. This plan must not mark any of those complete in advance.

## Risk register

| Risk | Required response |
|---|---|
| Shared vCPU produces variable latency | Two clean final passes plus ongoing alerting; fail on a slow measured wave; user-approved CPU resize only |
| One GiB cannot hold host services plus blue/green overlap | Whole-host/process evidence and long-stream deploy; no swap masking; resize or explicit downtime decision if measured |
| PS-5 is the bottleneck | Exact managed DB metrics/query evidence; bounded query fix first; PS-10 ARM only after approval |
| Public database path weakens the old private-network boundary | Fixed outbound reserved `/32`, per-role restrictions, `verify-full` TLS, separate credentials, fail-closed tests |
| Reserved IP is assigned but not used outbound | Persistent route configuration, observed source verification, reboot and cold-rebuild tests |
| Droplet local disk exposes credentials | Encrypted Volume, strict mounted secret loader, no env args/files on root disk, secret scan and cold recovery |
| Root-controlled Docker expands operator privilege | One named key-only sudo operator, no docker group, audited root-owned deploy script, provider MFA/recovery |
| Caddy lets callers spoof client identity | Loopback-only app, one overwritten private header, all public forwarding headers stripped, socket-peer fence/tests |
| Proxy buffers or drops NDJSON or hides client disconnect | Default cancellable unknown-length streaming, no transform/negative flush override, heartbeat, real-disconnect and long-silence tests, reload/drain matrix on public TLS |
| GHCR policy/retention changes | Live preflight, current+previous protected digests, billing alert, stop for registry decision |
| Manual deploy bypasses CI | Exact commit/digest/revision match, recorded green CI, fail-closed deploy preflight, no mutable tags |
| Migration succeeds but new app fails | Expand/contract rule, inactive-slot readiness before switch, immediately previous compatible rollback |
| New Relic outage exhausts host through log buffering | Bounded Fluent Bit memory/retry, no root-disk spool, telemetry not readiness-critical after valid startup |
| Database diagnostics leak content | No DB log export, protected provider view, synthetic plans, content-free evidence only |
| PlanetScale default retention is only two days | Backups every 12 hours retained 84 hours, continuous-window rotation check, storage-cost monitoring, isolated restore |
| PlanetScale storage grows or surges unexpectedly | Hard 15 GB ceiling, 60% warning/70% action, reconnect test, explicit approval before any larger limit |
| Active release state splits across Caddy, systemd, and Docker | One fsynced atomic release symlink, boot reconciliation, and kill/power-loss tests at every switch boundary |
| Recovery cutover allows writes to two databases | Maintenance fence, drain/stop all old-authority slots, prove zero old connections, then start exactly one new-authority slot |
| Bitwarden recovery credentials cannot be retrieved | Stop candidate acceptance; use the sealed offline kit, verify the one owner/MFA/recovery path, and repeat the timed cold rebuild before launch |
| Restored branch lacks `unaccent` or settings | Idempotent recovery preparation before app validation/cutover; executable search/timeout checks |
| Single-node host/database outage | Accepted cost posture, external availability monitoring, cold host rebuild, PlanetScale PITR, RTO rehearsal |
| Host patching causes unplanned restart | Controlled maintenance, drain, reboot smoke, alerting, monthly cadence, urgent security exception runbook |
| Cost exceeds USD 11.10 infrastructure / USD 15.10 operational base | Live estimate, alerts, Bitwarden seat count, backup/WAL/egress accounting, no silent add-ons, user-approved vertical change only |
| One recovery owner is unavailable | Keep the sealed offline kit separate, rehearse owner recovery/cold rebuild, and review the explicitly deferred second owner before launch; never claim two-owner resilience |
| Historical Render docs mislead operators | Prominent supersession pointers, active-reference audit, immutable historical evidence |

## Phase boundary

This remains Phase 8 production infrastructure and operations work. It does not create Phase 9 or
reopen accepted Phase 1–7 behavior except for the already identified production-blocking stream and
session fixes.

Do not add documents/retrieval, uploads, tools, agents, web browsing, memory, images, sharing, teams,
SSO, MFA product features, billing, employee budgets, model controls, provider names in employee UI,
new content types, a second frontend, generalized infrastructure abstractions, or unrelated cleanup.

## Definition of repository done

Repository implementation is complete only when:

- authority docs, this amendment, active Phase 8 pointers, README, CI, deployment artifacts, audits,
  and all runbooks agree on the candidate and its provisional status;
- the Capstone Bitwarden Teams organization, one MFA-protected company owner, sealed offline kit,
  USD 4/month-equivalent cost, deferred second-owner risk, and timed retrieval procedure are
  recorded without placing a credential in the repository;
- historical Render evidence remains accurate and no active operator path still depends on Render;
- release identity is one provider-neutral full revision from source through image/browser/runtime;
- the application is loopback-only and the Caddy/client-address boundary rejects public spoofing;
- secrets persist only on the encrypted Volume/external recovery store and never appear in source,
  root-disk config, image, Docker inspection, command arguments, logs, telemetry, or evidence;
- the OCI artifact remains non-root and CI publishes the exact smoke-tested digest only after all
  exact-commit gates pass;
- blue/green migration/readiness/switch/drain/rollback logic is bounded, tested, and compatible with
  the current shutdown contract;
- PlanetScale direct TLS, role separation, pool bounds, migrations, extension/search behavior,
  prepared statements, locks, numeric accounting, and recovery preparation are covered locally as
  far as possible and honestly marked managed-unverified;
- Fluent Bit adds only bounded content-free application log delivery; infrastructure and database
  signals remain in DigitalOcean/PlanetScale without another backend;
- the four named P2 production blockers are fixed and covered across protocol/API/web/browser;
- full formatting, audit, type, test, build, Playwright, migration, image, dependency, secret,
  boundary, and diff gates pass; and
- no external resource, credential, DNS change, paid inference, or unsupported production claim was
  created during repository work.

## Definition of candidate acceptance

The USD 11.10 infrastructure / USD 15.10 operational-base candidate is accepted for the later
launch checklist only when:

- the NYC3 managed topology passes the full 20-employee/40-stream gate twice at the unchanged
  500 ms response-start objective, and the remaining RIC1 regional evidence is either produced or
  superseded by an explicit production-region amendment;
- application correctness, isolation, budget/accounting, cancellation, cleanup, memory, and pool
  gates pass without retry/waiver;
- whole-host, support-process, blue/green overlap, and PS-5 evidence shows no exhaustion or restart;
- public TLS, client-IP trust, database `/32`, role separation, secret storage, and privacy audits
  pass;
- the database remains within the 15 GB ceiling, the 12-hour/84-hour schedule continuously exposes
  at least 72 hours of PITR, and the default provider role is restricted and absent from runtime;
- deploy/drain/rollback, reboot, cold host rebuild, and provider outages pass;
- three-day PITR ages and an isolated restore proves RPO at most 15 minutes and RTO at most four
  hours with the source untouched;
- exact live recurring/variable costs and limitations are recorded; and
- an independent read-only review finds no unresolved P1/P2 or unsupported acceptance statement.

## Authorization boundary

The user approved this comprehensive plan and authorized repository implementation on 2026-08-10.
That grant includes source-controlled code, tests, documentation, CI, audits, and deployment
artifacts required by this amendment. On 2026-08-11 the user separately authorized the disposable
NYC3 managed rehearsal, capped at USD 5 of actual provider usage excluding temporary card holds and
taxes. It does not authorize production DNS mutation, production credential/data installation,
paid inference, production deployment, or production recovery resources.

Each later external action must be announced with its exact target, expected maximum/prorated cost,
credential and data boundary, rollback, and cleanup path before it occurs.

## Repository implementation record — 2026-08-10

Repository implementation is complete in the authorized working tree. The production candidate is
**not accepted**: no managed rehearsal, account/resource creation, credential installation, DNS
change, deployment, paid inference, or recovery mutation was authorized or performed. No commit or
push was authorized or performed.

### Frozen baseline and worktree ownership

The exact Git baseline remained
`92bee339972f6416ae7266d2a592d8fdeb98bd73` throughout this implementation. Work began with the
user-owned, uncommitted Minimal Render amendment and capacity work already present above that
commit. That pre-existing dirty tree has no separate commit identity; this record does not invent
one. Its exact implementation and local Standard/Starter evidence remain frozen in the
[Minimal Render amendment](./08-production-baseline-amendment-plan.md). Those changes were
preserved and amended in place. The cumulative working-tree inventory below therefore includes
both that preserved work and this DigitalOcean/PlanetScale replacement.

### Delivered repository behavior

- The locked PRDs, Phase 8 records, README, CI, audits, and nine active runbooks now identify the
  provisional USD 6 RIC1 Droplet, PS-5 ARM `us-east-1` database, encrypted one-GiB Volume, Caddy,
  GHCR, Fluent Bit/New Relic, 12-hour/84-hour backups, USD 15.10 operational base, and separately
  gated managed acceptance. Historical Render evidence remains historical rather than rewritten.
- The four inherited production blockers are closed: NDJSON has content-free heartbeats and a
  bounded browser watchdog; authentication revocation fences in-flight browser work; canonical
  recovery presents incomplete terminal output without inventing a retry; and admission retains
  the USD 100/concurrency authority while removing repeated planning and per-delta database work.
- Release identity is one provider-neutral full revision through source, image, browser, API, CI
  evidence, and host activation. CI publishes only the exact full-revision GHCR image after quality
  and browser jobs pass; the image keeps a fixed source label and non-root runtime.
- Production entrypoints load credentials only from one authenticated root-owned `0440` JSON file.
  Runtime, migration, registry, Caddy, Fluent Bit, and ephemeral operator boundaries have distinct
  ownership, modes, schemas, mounts, and cross-read denial. PlanetScale production URLs require
  direct port 5432 and exactly `sslmode=verify-full`; recovery preparation proves separate
  application and migration authority before validating an isolated branch.
- Migration `0006` adds the bounded conversation-generation lookup used by accounting and
  reconciliation. The migration journal/snapshots, application pool/session guards, direct TLS
  contract, role denial, `unaccent`, search, numeric accounting, and recovery-preparation paths are
  covered locally without claiming managed PlanetScale compatibility.
- `deploy/digitalocean/` contains the one reviewed host implementation: cloud-init, exact pinned
  installation contract, Caddy h1/h2 boundary, bounded memory-only Fluent Bit path, hardened
  systemd units, supervised operator/deploy request helpers, same-host blue/green state machine,
  forward migration, readiness/switch/drain/rollback, boot reconciliation, clean-shutdown evidence,
  content-free UTC activation evidence, exact local/remote retention, and fail-closed host audit.
  Application slots keep Docker's 300-second grace inside 330 seconds; deploy uses 2,400/1,200,
  boot 900/900, and operator 1,800/210 second start/stop envelopes.
- Host verification requires the exact UFW default policy and three inbound rules, only the expected
  TCP listeners, IPv6 disabled on all/default/loopback, the encrypted Volume's distinct exact block
  device, exact identities/artifact modes, and exactly one all-state Docker container: the active
  named/labeled application slot. Stopped, unlabeled, migration, operator, or foreign survivors fail.
- The exact-image smoke now leaves the Dockerfile default command intact, enters through the real
  secret loader, reaches database-backed readiness, and proves the revision. A separate production
  configuration probe and full SPA/API/security-header smoke remain in the same gate.

### Final local verification

- `pnpm check`: 319 repository files passed.
- `pnpm verify:repository`: boundary and credential scan passed for 451 files.
- `pnpm verify:operations`: DigitalOcean, PlanetScale, runbook, and recovery-evidence validators and
  their negative self-tests passed.
- `pnpm typecheck`: protocol, API, and Web passed.
- `pnpm test`: 942 tests passed — 204 protocol, 515 API/PostgreSQL, and 223 Web.
- `pnpm build`: protocol, API, and production Web builds passed. The existing deferred Markdown
  chunk advisory remains; initial assets measured 815,967 raw / 314,770 gzip bytes and
  administration remains route-split.
- `pnpm test:e2e`: 42/42 passed across Chromium and the critical Firefox/WebKit matrix.
- `pnpm audit --prod --audit-level high`: the high/critical gate passed; one existing moderate
  development-server advisory remains.
- Host source verification passed 38 deploy-state scenarios, 16 fail-closed verifier regressions
  plus three positive baselines, migration survivor cleanup, request lifecycle, exact secret,
  GHCR-retention, and Fluent Bit privacy fixtures. An Ubuntu 24.04 container with `systemd-analyze`
  and ShellCheck passed `deploy/digitalocean/verify-artifacts.sh` against this tree.
- Local production image `sha256:545089646ff1889809df6f542fc1f413fd7ee21e4d748901961fcc34850bdaa9`
  used synthetic revision `0123456789abcdef0123456789abcdef01234567`, measured 100,097,680 bytes,
  declared user `node`, carried the exact GitHub source label and migration `0006`, excluded tests,
  source maps, and environment files, and passed migration, default-command readiness, SPA/API, and
  runtime-boundary smoke. It was not pushed.
- `git diff --check`, shell syntax, migration clean/upgrade/continuity coverage, shutdown signal
  regression, and local disposable-container cleanup passed. The existing development PostgreSQL
  container was left healthy and unchanged.
- Independent adversarial review resolved every P1/P2 found in the application, image gate, host
  state machine, retention, verifier, and runbooks. No unresolved repository-scope P1/P2 remains.

### Cumulative changed-file inventory — 143 paths

`render.yaml` is deliberately deleted because it is an active Render deployment contract. Every
other path below is modified or added relative to the frozen Git baseline:

```text
.dockerignore
.env.example
.github/workflows/ci.yml
README.md
apps/api/Dockerfile
apps/api/migrations/0006_conversation_generation_lookup.sql
apps/api/migrations/meta/0005_snapshot.json
apps/api/migrations/meta/0006_snapshot.json
apps/api/migrations/meta/_journal.json
apps/api/package.json
apps/api/src/app.ts
apps/api/src/auth/authentication.ts
apps/api/src/auth/request-headers.ts
apps/api/src/config.ts
apps/api/src/database/database.ts
apps/api/src/database/generation-schema.ts
apps/api/src/database/pool.ts
apps/api/src/database/production-database-url.ts
apps/api/src/database/recovery-error.ts
apps/api/src/database/recovery-migrations.ts
apps/api/src/database/recovery-preparation.ts
apps/api/src/entrypoint-loader.ts
apps/api/src/entrypoint.ts
apps/api/src/environment.ts
apps/api/src/generations/admission.ts
apps/api/src/generations/context-preload.ts
apps/api/src/generations/context-service.ts
apps/api/src/generations/durable-authority.ts
apps/api/src/generations/response-stream.ts
apps/api/src/generations/service.ts
apps/api/src/generations/settings.ts
apps/api/src/identity/email-lifecycle.ts
apps/api/src/lifecycle-timeout.ts
apps/api/src/lifecycle.ts
apps/api/src/load/harness-safety.ts
apps/api/src/model-policy/budget-service.ts
apps/api/src/model-policy/generation-policy-query.ts
apps/api/src/model-policy/service.ts
apps/api/src/operator/identity-command.ts
apps/api/src/operator/recovery-preparation-command.ts
apps/api/src/routes/health.ts
apps/api/src/secret-environment.ts
apps/api/src/security/client-address.ts
apps/api/src/shutdown-budget.ts
apps/api/src/start.ts
apps/api/tests/client-address.test.ts
apps/api/tests/config.test.ts
apps/api/tests/context-service.test.ts
apps/api/tests/database-pool.test.ts
apps/api/tests/database.integration.test.ts
apps/api/tests/durable-authority.test.ts
apps/api/tests/entrypoint-loader.test.ts
apps/api/tests/generation-domain.test.ts
apps/api/tests/generations.integration.test.ts
apps/api/tests/health.test.ts
apps/api/tests/identity.integration.test.ts
apps/api/tests/lifecycle.test.ts
apps/api/tests/load-harness-safety.test.ts
apps/api/tests/load-harness.ts
apps/api/tests/model-policy.integration.test.ts
apps/api/tests/observability-database.integration.test.ts
apps/api/tests/phase7-database.integration.test.ts
apps/api/tests/recovery-preparation.integration.test.ts
apps/api/tests/recovery-preparation.test.ts
apps/api/tests/response-stream.test.ts
apps/api/tests/secret-environment.test.ts
apps/api/tests/shutdown.test.ts
apps/api/tests/support/shutdown-signal-child.ts
apps/web/e2e/identity.spec.ts
apps/web/e2e/streaming.spec.ts
apps/web/src/api/session-boundary.ts
apps/web/src/conversations/api.ts
apps/web/src/conversations/chat-runtime.test.ts
apps/web/src/conversations/chat-runtime.ts
apps/web/src/conversations/conversation-page-lifecycle.test.tsx
apps/web/src/conversations/conversation-page.tsx
apps/web/src/conversations/draft-memory.tsx
apps/web/src/conversations/stream-parser.test.ts
apps/web/src/conversations/stream-parser.ts
apps/web/src/identity/identity.test.tsx
apps/web/src/identity/require-session.tsx
apps/web/src/vite-config.test.ts
apps/web/vite.config.ts
deploy/digitalocean/Caddyfile
deploy/digitalocean/README.md
deploy/digitalocean/capstone-boot.service
deploy/digitalocean/capstone-caddy.service
deploy/digitalocean/capstone-chat@.service
deploy/digitalocean/capstone-deploy.service
deploy/digitalocean/capstone-fluent-bit.service
deploy/digitalocean/capstone-operator.service
deploy/digitalocean/ci-evidence.example.json
deploy/digitalocean/cleanup-migrations.sh
deploy/digitalocean/cloud-init.yaml
deploy/digitalocean/deploy-state-machine.test.sh
deploy/digitalocean/deploy.sh
deploy/digitalocean/fluent-bit-parsers.conf
deploy/digitalocean/fluent-bit-privacy.test.mjs
deploy/digitalocean/fluent-bit-secret.test.sh
deploy/digitalocean/fluent-bit.conf
deploy/digitalocean/ghcr-retention.py
deploy/digitalocean/ghcr-retention.test.py
deploy/digitalocean/host.env
deploy/digitalocean/maintenance.caddy
deploy/digitalocean/migration-cleanup.test.sh
deploy/digitalocean/operator-entrypoint.mjs
deploy/digitalocean/operator-secret.test.sh
deploy/digitalocean/operator.sh
deploy/digitalocean/request-deploy.sh
deploy/digitalocean/request-lifecycle.sh
deploy/digitalocean/request-lifecycle.test.sh
deploy/digitalocean/request-operator.sh
deploy/digitalocean/start-fluent-bit.sh
deploy/digitalocean/verify-artifacts.sh
deploy/digitalocean/verify-host-negative.test.sh
deploy/digitalocean/verify-host.sh
docs/implementation/04-streaming-chat-plan.md
docs/implementation/08-digitalocean-planetscale-amendment-plan.md
docs/implementation/08-production-baseline-amendment-plan.md
docs/implementation/08-production-hardening-plan.md
docs/operations/README.md
docs/operations/database-recovery.md
docs/operations/deploy-and-rollback.md
docs/operations/domain-and-tls.md
docs/operations/employee-access.md
docs/operations/incident-response.md
docs/operations/providers-and-budget.md
docs/operations/provision-and-deploy.md
docs/operations/secret-rotation.md
docs/prd/02-system-architecture-and-data.md
docs/prd/03-conversation-model-and-streaming.md
docs/prd/04-cost-control-and-reliability.md
docs/prd/06-development-roadmap.md
docs/prd/README.md
package.json
packages/protocol/src/index.ts
packages/protocol/src/stream.ts
packages/protocol/test/generation-contracts.test.ts
render.yaml (deleted)
scripts/container-load.mjs
scripts/container-smoke.mjs
scripts/operations-audit.mjs
scripts/repository-audit.mjs
```

### External evidence deliberately still unverified

Repository completion does not supply any of the following evidence:

- live DigitalOcean/PlanetScale/GitHub/Bitwarden/New Relic/Resend/OpenRouter account ownership,
  permissions, prices, billing alerts, credentials, or recovery access;
- RIC1 shared-vCPU scheduling, whole-host one-GiB memory, encrypted-Volume behavior, reserved-IP
  outbound persistence, Cloud Firewall, Monitoring/Uptime, or exact 20-employee/40-stream capacity;
- PS-5 PostgreSQL 18 compatibility, direct public `verify-full` latency, `/32` enforcement, role
  separation, extensions, locks, prepared statements, storage/WAL, 12-hour/84-hour backup aging,
  isolated PITR, RPO, RTO, reconnect, or resize behavior;
- live GHCR permission, digest pull, deletion/retention, and billing behavior;
- installed-host Caddy and Fluent Bit binary validation, ACME/public DNS/TLS, long NDJSON streams,
  disconnect propagation, New Relic delivery/privacy/outage behavior, alerting, or log retention;
- killing the installed systemd unit and power-cycling the host across each activation boundary,
  reboot, patch, rollback, resize, cold rebuild, or secret-recovery evidence;
- Resend domain/delivery, OpenRouter privacy/catalog and authorized paid smoke, custom-origin
  identity/generation/Stop, Ecuador latency, real devices, or final accessibility acceptance; or
- a second independent Bitwarden recovery owner, which remains an explicitly accepted launch risk.

Those are candidate-acceptance or guided-launch gates. Their absence is not waived by local fixtures,
historical Render results, provider documentation, or this repository-complete status.

## NYC3 rehearsal authorization addendum — 2026-08-11

After repository commit `91624ce616744f9018423034d24a4a6a7cffb00d` passed GitHub Actions and
published the exact GHCR candidate, the user authorized a disposable managed rehearsal with at most
USD 5 of actual provider usage, excluding temporary card holds and taxes. The live DigitalOcean
control panel showed the USD 6 Basic 1 vCPU / 1 GiB size unavailable in RIC1 and ATL1 and available
in NYC3. The user approved NYC3 for this rehearsal only.

The repository therefore binds production mode to RIC1 and the explicit managed `NODE_ENV=test`
rehearsal to NYC3. The production `host.env` remains RIC1; the operator renders NYC3 only into the
non-production rehearsal contract. Cold-rebuild rehearsal evidence must identify NYC3. NYC3 results
may qualify region-independent compute, application, PS-5, deployment, rollback, and recovery
behavior, but they cannot close RIC1 scheduling, availability, or RIC1-to-`us-east-1` latency gates.
No production-region amendment, production DNS/credential/data installation, paid inference, or
production deployment was authorized by this exception.

The follow-up implementation also makes the deployed SPA explicit with the exact
`WEB_ASSETS=production-build` mode and adds a test-only operator allowlist for ordered synthetic
pending identity bootstrap without delivery, simulated first-policy initialization, and isolated
recovery. Rehearsal readiness requires simulated policy authority, the temporary host cannot equal
the production host, runtime secrets reject provider keys, and the pending administrator must use
the reserved `.test` TLD. It does not add credentials, a password-seeding path, or a public test
endpoint. The exact managed
load-server invocation that keeps the load generator off the candidate host remains a
source-controlled review gate; host-shell provisioning and credential-free activation may proceed,
but the capacity step must stop until that invocation lands and passes CI.
