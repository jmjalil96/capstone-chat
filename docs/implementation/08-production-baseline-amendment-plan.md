# Phase 8 Amendment — Minimal Render Production Baseline

Status: repository implementation completed and locally verified on 2026-08-09; production
acceptance pending

Superseded production recommendation: the user-approved
[DigitalOcean and PlanetScale amendment](./08-digitalocean-planetscale-amendment-plan.md) replaced
this Render candidate on 2026-08-10. The Render Standard, Starter, Hobby, private-network,
Blueprint, and local load results below remain historical evidence exactly as recorded; they are
not DigitalOcean/PlanetScale evidence and no longer direct an operator to provision Render.

Operator notice: do not execute the Render provisioning, Blueprint, deploy, DNS, log-stream, or
recovery steps below. Follow the current operations index and active DigitalOcean/PlanetScale
amendment instead.

External authorization: no Render, DNS, Resend, New Relic, OpenRouter, GitHub-setting, paid
rehearsal, inference, or recovery-resource mutation is authorized by this plan

## Planning record

This amendment starts from commit `92bee339972f6416ae7266d2a592d8fdeb98bd73`, where the accepted
Phase 8 repository implementation is complete and production acceptance remains pending. The
original [Phase 8 plan](./08-production-hardening-plan.md) is an implementation record and must stay
historically honest: its local `pro_plus` evidence remains true evidence for that earlier candidate,
but it is not evidence that the new smaller production candidate passes.

The user approved this amendment and authorized its source-controlled repository implementation on
2026-08-09. That grant does not authorize any external or paid action listed above.

The user explicitly approved these changes on 2026-08-09:

1. Remain on Render rather than changing deployment providers.
2. Use a Render Hobby workspace instead of Pro.
3. Use one Standard Web Service with 1 CPU and 2 GB RAM instead of `pro_plus`.
4. Use one `basic-256mb` PostgreSQL database with 5 GB storage.
5. Accept a three-day point-in-time-recovery window instead of seven days while retaining the
   existing RPO and RTO targets.
6. Keep New Relic Free for content-free Fastify OTLP traces/application metrics and the supported
   Render default log stream. Keep Render CPU, memory, network, disk, and PostgreSQL infrastructure
   metrics in the Render dashboard only; do not recreate infrastructure metric streaming with a
   collector or agent.
7. Retain the locked launch workload of 20 signed-in employees and 40 simultaneous employee chat
   streams. Smaller infrastructure must prove the existing contract; it does not lower it.

Approval of this plan also explicitly accepts the directly associated Hobby tradeoffs: one Render
workspace member, no workspace audit log, no Pro-only edge HTTP request logs or response-latency
views, seven-day Render dashboard log/metric history, reduced rollback/build history, 500 included
build minutes, an expected five retained recent build artifacts that must be verified live, 5 GB
included outbound bandwidth, and usage-based overage. Those are operational constraints, not reasons
to weaken application authorization, logging privacy, deployment gates, recovery, or capacity
targets.

This document plans the repository corrections and acceptance evidence needed to make that
amendment safe. It does not claim that the new baseline is production-ready.

## Authority and amendment semantics

Read this document with:

- `AGENTS.md`;
- `docs/prd/README.md` and all six PRDs;
- the eight accepted implementation plans, especially
  [Phase 8](./08-production-hardening-plan.md);
- the current `render.yaml`, CI workflow, load harness, migrations, and operational runbooks.

When approved and implemented, this amendment supersedes only the following locked Phase 8 choices:

| Existing locked choice | Approved replacement |
|---|---|
| Render Pro workspace | Render Hobby workspace |
| `pro_plus` Web Service candidate | Standard, one instance, 1 CPU / 2 GB RAM |
| 15 GB PostgreSQL storage | 5 GB at database creation |
| Seven-day PITR retention | Three-day PITR retention |
| Render infrastructure metrics streamed to New Relic | Render infrastructure metrics viewed in the Render dashboard only |
| New Relic described as the sole destination for all operational signals | New Relic is the sole external application/log telemetry destination; Render remains the native infrastructure control plane |
| Pro-only Render edge request logs, response-latency views, audit log, and metrics stream | Not available; use safe Fastify application telemetry plus manual Render infrastructure views without inventing replacements |

Every other product, privacy, security, data, model, email, cost-control, capacity, latency,
deployment, and recovery decision remains locked. In particular, this amendment does not change:

- the modular monolith, one OCI artifact, one origin, one Web Service, one PostgreSQL database, one
  application instance, private network, Virginia region, or absence of HA/read replicas;
- `https://chat.capstone.com.ec`, Resend, the approved model catalog and tier mappings, ZDR routing,
  30-day privacy attestation, output limits, reservation margin, or generation timeouts;
- the authoritative USD 100 monthly application budget, two chat workflows per employee, one chat
  workflow per conversation, or the 20-employee/40-stream launch workload;
- the locked API, response-start, presentation, cancellation, Ecuador, correctness, isolation,
  pool, and memory objectives;
- checks-pass deployment, pre-deploy forward migrations, readiness/drain, immediately previous
  compatible rollback, RPO at most 15 minutes, or RTO at most four hours;
- content-free logs, traces, metrics, reports, and recovery evidence;
- the prohibition on queues, caches, workers, replicas, extra services, agents, collectors, browser
  telemetry, or a second observability backend.

If the smaller candidate cannot pass the unchanged gates after the bounded corrections in this
plan, implementation stops and returns measured options to the user. It must not silently resize,
lower concurrency, relax thresholds, or change providers.

## Current external contract

The following official contracts were refreshed during planning on 2026-08-09 and must be rechecked
immediately before implementation or provisioning if they change materially:

- [Render workspace plans](https://render.com/docs/new-workspace-plans): Hobby has one member,
  5 GB included outbound bandwidth, and 500 included build minutes.
- [Render instance types](https://render.com/docs/compute-plans): Standard is 1 CPU / 2 GB; the
  paid `basic-256mb` PostgreSQL type is 0.1 CPU / 256 MB with a 100-connection limit.
- [Render flexible PostgreSQL](https://render.com/docs/postgresql-refresh): paid databases receive
  PITR, Hobby retention is three days, storage costs separately, storage grows in 5 GB increments,
  and allocated storage cannot be reduced.
- [Render deploys](https://render.com/docs/deploys): `checksPass` remains a documented auto-deploy
  trigger. A provider document is not a substitute for a live Hobby verification.
- [Render metrics streams](https://render.com/docs/metrics-streams): infrastructure metric
  streaming requires Pro or higher.
- [Render log streams](https://render.com/docs/log-streams): a workspace default log stream remains
  supported on Hobby, while per-service overrides do not.
- [Render dashboard metrics](https://render.com/docs/service-metrics) and
  [logs](https://render.com/docs/logging): Hobby retains seven days and exposes a smaller feature
  set than Pro.
- [Render rollbacks](https://render.com/docs/rollbacks): rollback requires a retained build artifact
  and does not restore the current service's instance type, domains, or other live configuration.
- [Render notifications](https://render.com/docs/notifications): built-in email can report failed
  builds/deploys and unhealthy services without introducing another observability backend.
- [Render private networking](https://render.com/docs/private-network): same-region services in one
  workspace share the private network, and cross-environment network blocking requires Pro or
  higher. A second Hobby environment is therefore not an isolation boundary.

Render prices and allowances are operational estimates, not immutable application constants. The
operator must confirm the live estimate before creating resources.

## Objective

Produce the smallest complete repository and operational amendment that can truthfully support this
production candidate:

```text
Render Hobby workspace
  |
  |-- one Standard Docker Web Service (1 CPU / 2 GB, Virginia)
  |     `-- one non-root Capstone Chat OCI artifact
  |
  `-- one basic-256mb PostgreSQL 18 database
        |-- 0.1 CPU / 256 MB / 100 connection provider limit
        |-- 5 GB storage selected before creation
        `-- three-day PITR

Fastify OTLP traces/application metrics ------> New Relic Free
Render default application/datastore logs ----> New Relic Free
Render infrastructure metrics ----------------> Render dashboard only
```

The repository corrections target the measured workspace budget-lock convoy and redundant
generation-state reads. They must make the existing business boundaries cheaper without changing
what is authoritative.

## Cost statement

At the approved candidate prices, the expected base monthly infrastructure estimate is:

| Component | Candidate | Estimate |
|---|---|---:|
| Render workspace | Hobby | USD 0 |
| Web Service | Standard | USD 25 |
| PostgreSQL | `basic-256mb` plus 5 GB storage | USD 7.50 |
| Base infrastructure | | **USD 32.50/month** |

This is not a hard all-in bill. Outbound bandwidth above 5 GB, build-minute overage, temporary load
and PITR resources, provider price changes, taxes, and model usage are additional. The operator must
capture the live Render estimate before provisioning and remove disposable resources promptly after
accepted evidence.

The application's USD 100 monthly workspace model budget remains the authoritative product cost
control. This amendment does not silently add an OpenRouter key-level reset policy: a provider-side
limit has different reset/timezone and availability semantics and needs a separate explicit
decision. The paid provider smoke still requires immediate authorization.

## Scope

### In scope

- Explicit PRD and Phase 8 cross-reference amendments for the approved locked changes.
- A period-bounded budget-spend aggregation that retains cross-period active-workflow enforcement.
- One measured, general conversation lookup index and an admission predicate aligned with the
  existing active-chat partial index.
- Removal of the redundant database read for every provider stream event while preserving local and
  cross-replica terminal fencing.
- PostgreSQL-enforced application query, lock-wait, and idle-in-transaction timeouts aligned with
  the existing five-second client query bound.
- A 300-second Render shutdown envelope around the unchanged 240-second stream grace and bounded
  application cleanup phases.
- Local Standard web-container constraints and exact managed Render rehearsal requirements.
- Exact Blueprint and operations-audit assertions for Standard, `basic-256mb`, and 5 GB.
- Runbook changes for Hobby ownership, checks-pass, observability, bandwidth/build constraints,
  three-day PITR, rollback retention, and the reduced infrastructure alert surface.
- Tests, migration `0006`, load evidence, container evidence, and the full repository gate.

### Out of scope

- Provisioning or resizing a Render resource, mutating DNS, configuring New Relic/Resend/OpenRouter,
  changing GitHub settings, or running a paid rehearsal, smoke, or recovery operation.
- A provider move, portability layer, second frontend, cache, pooler, queue, worker, replica, HA,
  autoscaling, additional instance, or permanent staging environment.
- A New Relic infrastructure agent, OpenTelemetry collector, sidecar, browser agent, metrics proxy,
  scheduled dashboard scraper, or second telemetry destination.
- A new budget service, repository abstraction, generation cache, stream coordinator service, or
  background sampler.
- Lowering the launch workload to one workflow per employee or choosing Starter. That remains only
  a future explicitly approved fallback after evidence.
- Changing the application budget, provider catalog, privacy rules, pricing interpretation,
  tokenizer policy, UI, protocol, content retention, or employee-facing features.
- Claiming the local host database represents `basic-256mb`.

## Required repository changes

### 1. Amend governing decisions without rewriting history

Update `docs/prd/README.md`, PRD 02, and PRD 06 first so implementation follows the approved product
baseline:

- replace the Pro workspace requirement with Hobby and record the one-operator/no-audit-log
  consequence;
- record Standard and `basic-256mb` with 5 GB as candidates that still require exact rehearsal;
- replace seven-day PITR with three days while retaining RPO/RTO and isolated restore requirements;
- describe New Relic as the sole external application/log telemetry destination, with Render's
  dashboard as the infrastructure source and no infrastructure metric stream on Hobby;
- retain all launch workload and latency values unchanged.

Amend every active normative/operational Phase 8 clause that would otherwise still direct Pro,
Render-to-New-Relic infrastructure metrics, or seven-day PITR: objective, approval decisions,
external-contract summary, dependency diagram, provisioning order, observability/alerts, backup,
implementation sequence, manual acceptance, definition of done, and current external gates. Add a
prominent pointer to this amendment. Do not rewrite the Phase 8 implementation record's 4 CPU / 8 GB
runs as if they occurred at Standard. Those historical measurements remain unchanged and labeled
superseded for sizing; the new plan owns replacement evidence.

Review product/operations copy for a hard-coded seven-day recovery-window statement. The accessible
PITR window becomes three days, but that does not prove the physical deletion schedule of provider
backup media. Keep PRD 01's generic deleted-content backup disclosure unless Render's contractual
terms establish a hard media-deletion bound. Active application and accounting retention do not
change in this amendment.

### 2. Bound budget admission by the authoritative period

Refactor `lockAdmission` in `apps/api/src/model-policy/budget-service.ts` without changing its public
contract or transaction owner.

The state statement must compute two independent values:

1. **Current-period consumed USD.** Join or aggregate only generations for the locked workspace whose
   `budget_period_start` and `budget_period_end` match the current workspace month and whose
   `accounting_status` is `reserved`, `actual`, or `estimated`. A previous-period row must not enter
   the spend aggregation and then be discarded by a `CASE` after a broad join.
2. **Active employee chat workflows.** Count the employee's `preparing` and `active` chat workflows
   regardless of budget-period boundary. Use the complete structural predicate: active/preparing
   status, non-null conversation, and non-null assistant message, plus employee/workspace scope. The
   content-reference constraint then limits purpose to chat/null, hidden compaction does not consume
   an employee chat slot, and the active-chat partial index is eligible. Because that index is
   conversation-keyed rather than user-keyed, it bounds the scan to all currently active chat
   workflows before applying employee scope; that is acceptable at the locked capacity and must not
   be described as a user-selective lookup. A workflow admitted before midnight/month rollover
   remains active concurrency after rollover.

Keep these invariants exactly:

- workspace row lock before membership row lock;
- the second state statement after the authority lock, so PostgreSQL `READ COMMITTED` sees a fresh
  snapshot after a lock wait;
- workspace timezone month boundaries and exact decimal arithmetic;
- active membership requirement and current error precedence;
- budget comparison, reservation creation, idempotency, conversation and draft CAS behavior;
- workspace -> membership -> conversation -> draft lock order;
- no provider or browser network wait inside a transaction;
- no cache or eventually consistent cost source.

Use the established `generations_workspace_budget_period_idx`. PostgreSQL integration evidence must
show that current-period spend uses a bounded index-backed plan on a history-heavy fixture. If the
existing index cannot do that, stop and return the query-plan evidence for a plan amendment; do not
silently add a second speculative budget index.

Required regression coverage:

- prior-month actual/estimated/reserved rows do not count toward current consumption;
- current-month actual/estimated/reserved rows all count once and terminal unaccounted rows do not;
- a previous-month active employee chat still counts toward the two-workflow limit;
- month rollover while concurrent admissions serialize cannot overspend or admit a third workflow;
- a workspace-lock waiter observes the preceding committed reservation;
- inactive membership, exhausted budget, idempotent retry, active-conversation conflict, stale
  revision, and draft consumption preserve their current outcomes;
- decimals remain canonical and no transaction spans model work.

The smaller database also makes bounded waits part of the same admission-safety work. Keep the
existing five-second `node-postgres` `query_timeout`, and apply session-level
`statement_timeout=5000`, `lock_timeout=5000`, and
`idle_in_transaction_session_timeout=5000` to application-pool connections. This protects the
server after client cancellation and prevents a stalled lock/transaction from pinning the ten-slot
pool. The migration pool remains separate and must not inherit application query/lock limits that
could interrupt a valid pre-deploy migration. Add focused pool-configuration tests; do not turn
these fixed safety bounds into another environment-variable surface.

### 3. Make conversation-generation lookups intentional

Add forward-only migration `0006` and the matching Drizzle schema declaration for a non-unique
`generations(conversation_id)` index restricted to non-null conversation references. The index is
justified by existing terminal-history, completed-continuation, response-state, conversation
lifecycle/FK, deletion, and compaction lookups that cannot use the active-only indexes. Excluding
null references keeps it smaller after deleted compaction history is detached. It is not a
replacement for either active-chat uniqueness constraint.

Align the admission `EXISTS` predicate with the existing
`generations_chat_workflow_conversation_unique` predicate by requiring a non-null assistant message
for `preparing`/`active` chat workflows. The database content-reference constraint already requires
that relationship for chat. This lets PostgreSQL use the narrow partial index for the hot conflict
check while the general index covers lifecycle/history paths.

Migration requirements:

- repair the missing `0005` Drizzle snapshot before generating `0006`; the starting journal has six
  entries but only snapshots `0000` through `0004`, so generation against stale `0004` would
  re-emit Phase 8 schema. Add a regression that the snapshot count/numbers exactly match journal
  entries before accepting the chain;
- use the next established migration number and existing SQL/meta conventions;
- use the established transactional Drizzle migration path and create only the one normal additive
  index. Production has not been provisioned, so do not introduce incompatible `CREATE INDEX
  CONCURRENTLY` machinery; a later populated-production index would require a separate plan;
- apply cleanly to an empty database and as a `0005` -> `0006` upgrade;
- advance the Drizzle journal/snapshot, hard-coded migration-count expectations, current-migration
  integration fixtures, and image/latest-migration evidence rather than dismissing those failures as
  stale tests;
- preserve all foreign keys, partial unique indexes, checks, and deletion behavior;
- include PostgreSQL integration coverage for duplicate active-chat prevention and conversation
  cleanup after the index exists;
- record `EXPLAIN (ANALYZE, BUFFERS)` or safe equivalent against non-sensitive fixtures showing the
  hot admission and lifecycle shapes use bounded plans. Do not commit raw production plans/content.

### 4. Replace per-delta authority reads with one bounded fence

`apps/api/src/generations/response-stream.ts` currently has both a 250 ms durable-state monitor and
an awaited `readState` for every non-header gateway event. Tiny deltas therefore turn provider event
frequency into database traffic.

Keep one generation-local durable-authority sampler using the existing 250 ms tuning. It holds only
the current generation's last successful state, monotonic read time, one coalesced in-flight read,
and abort controller; it is not a cross-request cache or new service. The stalled-provider monitor
and event loop share it. Rapid events synchronously consult the last state; an event arriving after
the interval forces and awaits one refresh, while the monitor continues refreshing when the
provider is silent. A terminal/null state is sticky and aborts upstream. An event-triggered refresh
failure remains fail-closed; a background refresh failure neither replaces the last known state nor
advances the last-successful-read time, so the next provider event retries and awaits the read.
No last-successful read is also due, so the first provider event cannot publish from unknown
authority.

If this state is more cohesive as a small lifecycle module because `response-stream.ts` is already
large, add one narrowly named generation module with fake-clock unit coverage. Do not generalize it
into a polling framework or refactor unrelated coordinator behavior.

Required behavior:

- same-replica Stop remains immediate through the process-local lease and abort path;
- after a remote Stop, conversation delete, or employee-deactivation terminal transaction commits,
  its generation state becomes visible within one existing 250 ms poll interval. The locked 500 ms
  backend-abort objective remains specific to cancellation; a batched administrator operation has
  its own transaction duration before that terminal commit;
- rename and archive remain non-terminal structural races: streaming continues, completion locks the
  latest conversation revision, and neither the title nor archive state is lost;
- once terminal state is observed, no later content delta is written to the employee response;
- a racing checkpoint or completion cannot overwrite a durable terminal state;
- already visible partial content remains durable on Stop;
- provider metadata and authoritative late usage still settle after terminalization without
  reopening generation content;
- if an event-triggered refresh discovers terminal state for the provider event already yielded,
  that event still passes through the existing metadata/late-accounting handler before abort and
  canonical terminal emission where applicable. A background-discovered terminal may abort
  immediately and use the existing bounded final usage lookup;
- monitor errors remain bounded and cannot turn telemetry or a transient read into unsafe content
  publication;
- the monitor, timer, and controller are always released on completion, failure, disconnect, and
  shutdown.

Required tests:

- hundreds of one-character deltas produce a database read count bounded by elapsed polling
  intervals, not by delta count, with at most one durable read in flight;
- immediate local Stop, remote Stop, delete, deactivation, and forced shutdown races;
- rename/archive during streaming continue and terminalize against the latest structural revision;
- terminal state observed between two deltas suppresses the second delta;
- a failed background refresh does not make cached active authority fresh, and the next delta cannot
  publish until its due fail-closed refresh succeeds;
- checkpoint/completion after terminal loses its CAS and retains canonical content/status;
- late completed/failed provider accounting still settles exactly once;
- slow consumers and backpressure retain bounded memory and correct lifecycle order;
- monitor abort/cleanup leaves no timer, promise, lease, active gauge, or database client behind.

Do not create a generic polling abstraction. Extend the existing generation coordinator and tuning
pattern only.

### 5. Constrain and harden the load harness

Update `scripts/container-load.mjs` to run the built Web container at exactly:

```text
--cpus 1
--memory 2g
--memory-swap 2g
```

Update the Docker-inspect assertion and wording from Pro Plus to Standard. Keep the workload, five
measured waves, failure mix, canaries, strict thresholds, ten-connection application pool, and
fake-gateway timing unchanged. The final implementation uses ten complete unmeasured warm-up waves
instead of five; the evidence and rationale for that one harness-only adjustment are recorded below.

Run two consecutive final-candidate rehearsals, each from a newly created empty PostgreSQL 18
database. Record absolute, content-free evidence in addition to pass/fail:

- ordinary API p95/p99, response-start p95, cancellation p95, stream outcomes, and unexpected 5xx;
- peak and post-idle Web CPU, RSS, heap, event-loop behavior, and monotonic/15% memory gate;
- pool total/idle/waiting, active workflows/reservations, reconciliation, and ownership canaries;
- exact image revision, container CPU/RAM limits, database major version, and migration number.

The local database runs on the host and is not constrained to 0.1 CPU / 256 MB. Therefore these
runs can validate the Standard Web candidate and regression behavior only. They cannot validate
`basic-256mb`, private-network latency, Render scheduling, deploy drain, or `checksPass`.

### 6. Make the Blueprint and audit exact

After repository tests and both local Standard runs pass, update `render.yaml`:

```yaml
services:
  - plan: standard
databases:
  - plan: basic-256mb
    diskSizeGB: 5
```

Retain one instance, Virginia, PostgreSQL 18, no HA, no read replica, no pooler, no previews, private
database binding, empty public allowlist, checks-pass, pre-deploy migration, readiness, custom
domain, and disabled final Render subdomain. Raise `maxShutdownDelaySeconds` from 270 to Render's
300-second maximum while keeping the application stream grace at 240 seconds. The bounded
application shutdown budget is 287 seconds: a 275-second work fence comprising 5 seconds of
ordinary request drain, 240 seconds of stream grace, and 30 seconds of forced stream cleanup;
2 seconds for concurrent email and database-pool cleanup; and 10 seconds for telemetry flush.
The remaining 13 seconds is platform/process headroom; do not shorten stream grace or silently
extend any application phase.

The 5 GB value must be committed before database creation. Render storage cannot shrink. The
provisioning preflight must stop if a 15 GB database already exists; it must not describe that as an
in-place trim. The user has stated that no production resources exist at planning time, but the
operator still verifies that fact immediately before sync.

Strengthen `scripts/operations-audit.mjs` to require the exact Web plan, database plan, disk size,
and 300-second shutdown delay. Retain exact-key validation and every topology/security assertion.
Update its self-tests or fixtures so a changed plan, disk, added service, public database rule,
removed checks-pass setting, or changed shutdown envelope fails closed.

Source control remains authoritative for planned size. An emergency dashboard resize must be
documented during the incident and reconciled into `render.yaml` immediately afterward; normal
deployment must not depend on dashboard drift.

### 7. Reconcile observability with Hobby

Preserve the current manual Fastify OpenTelemetry implementation and content-free Pino logging.
Change only operational routing and claims:

```text
New Relic Free
  - Fastify OTLP traces
  - Fastify application metrics
  - supported Render default application/container/datastore log stream

Render dashboard (seven-day history)
  - Web CPU and memory
  - outbound bandwidth and available request counts
  - PostgreSQL disk, connections, network, transactions, lock-delayed queries, and top queries
```

Do not claim that Hobby provides Render Metrics Stream, Pro-only response-latency views, Pro-only
edge HTTP request logs, or infrastructure alerts in New Relic. Fastify's own route-template request
telemetry remains the application latency/error source.

Keep New Relic alerts and saved views only for signals the application exports or logs safely:

- readiness/application availability, route-template 5xx and duration;
- admission-to-response-start, provider first-token/total timing, terminal outcome, and timeout;
- active chat/compaction workflows, budget rejections, reservation settlement, and reconciliation
  lag;
- application-observed PostgreSQL pool waiting;
- sanitized client failures, Resend failure categories, and OTLP export health.

Web CPU/RAM/restart, PostgreSQL host CPU/RAM/disk and lock-delayed queries, and bandwidth remain
manual Render dashboard checks. The reduced proactive infrastructure alert surface is an explicitly
accepted Hobby risk and must appear in the acceptance record. Do not compensate with a New Relic
agent, collector, polling job, sidecar, or another vendor.

During acceptance, verify the default log stream actually receives the supported Web/database logs,
then inspect New Relic and Render dashboard samples for prohibited content. If Hobby cannot provide
the documented default log stream at provisioning time, stop for a user decision; do not silently
drop centralized logs.

### 8. Update operations for the reduced platform envelope

Update the README and existing runbooks in place; do not add a second operations system.

`docs/operations/provision-and-deploy.md` must:

- require Hobby, Standard, `basic-256mb`, 5 GB, one operator, and the live estimate;
- verify no database exists before selecting 5 GB;
- verify `checksPass` on the Hobby workspace before accepting auto-deploy behavior;
- configure only the default Render log stream plus Fastify OTLP for New Relic;
- identify Render dashboard as the infrastructure-metric source;
- record the 5 GB bandwidth and 500 build-minute allowances and billing notifications;
- record the expected five retained recent build artifacts, verify the actual Hobby value live, and
  stop/update the runbook if the provider differs rather than relying on an assumed count;
- require an explicit operator choice for Render's pipeline-overage spend limit during external
  provisioning and record that reaching the limit can stop new builds/pre-deploy work until reset
  or a separately approved increase. Do not invent that amount in repository code;
- preserve private networking, migrations, bootstrap, DNS/TLS, Resend, secret, and final-subdomain
  steps.

`docs/operations/deploy-and-rollback.md` must:

- verify that the immediately previous compatible build artifact is still retained before deploy;
- exercise that rollback while it is available and record when dashboard rollback disables
  auto-deploy;
- verify the live service returns to `checksPass` after the rollback exercise;
- record that instance type and current live configuration are not restored by an artifact rollback;
- never use migration reversal or PITR as an ordinary application rollback.

`docs/operations/database-recovery.md` must:

- use a three-day retention statement and require the window to age before claiming it;
- keep restore-to-new-database, source untouched, fake model, disabled email, content-free evidence,
  RPO <=15 minutes, and RTO <=4 hours;
- create an unambiguous marker boundary and simulated incident whose expected recovered marker gives
  RPO <=15 minutes, then separately wait until the selected restore timestamp is older than Render's
  current 10-minute exclusion before triggering PITR. Do not collapse those two clocks into a
  fragile five-minute window;
- make temporary paid resource creation/deletion separately authorized;
- describe the accessible PITR recovery window as three days without making an unsupported claim
  about physical backup-media deletion.

`docs/operations/providers-and-budget.md`, `incident-response.md`, and `secret-rotation.md` must:

- separate New Relic application/log telemetry from Render dashboard infrastructure diagnosis;
- remove the nonexistent New Relic Render metrics integration and its alert claims;
- rotate the New Relic credential for the default log stream and OTLP header only;
- keep model budget authority, provider privacy, Resend, and content-free incident rules unchanged.

The operations index must record the single Render operator and provider-account recovery material
kept outside the repository. Acceptance requires MFA where available, verified recovery email,
recovery codes stored outside Render, and a named business owner who can regain the administrator
mailbox/GitHub/New Relic/Resend/OpenRouter accounts. Because Hobby has no workspace audit log, the
operator's content-free UTC change record is authoritative for external configuration mutations.
The sole Render member uses a Capstone-controlled mailbox and recovery path; credentials are never
shared to simulate multiple operators. If independent Render operators become necessary, stop and
revisit Hobby versus Pro. Hobby's one-member limit must not be confused with Capstone Chat's
employee/admin roles.

Add a small manual infrastructure routine to the operations index or incident/provisioning runbook:
inspect Web CPU/RAM/restarts, database disk/headroom/connections/lock-delayed queries, outbound
bandwidth, and pipeline usage before and after each deploy, daily during launch week, and weekly
thereafter. Enable Render's built-in failure email notifications for unhealthy services and failed
builds/deploys to the sole operator/recovery mailbox and test receipt; these notifications do not
replace unavailable CPU/RAM/disk threshold alerts. Evidence remains content-free. Approaching
resource exhaustion triggers an explicit source-controlled resize decision, not an emergency
scraper, agent, or silent dashboard change.

### 9. Preserve CI and repository boundaries

The implementation adds no production dependency and should add no protocol or web behavior. CI
must continue to execute `pnpm run ci`, not pnpm's built-in install alias. Keep one authoritative
quality gate and the existing production image/audit/migration jobs.

Update repository/operations audits and documentation links for the new baseline. Use exact
executable assertions for Blueprint/configuration and a documented `rg` review for stale
`pro_plus`, Pro workspace, seven-day PITR, and Render-to-New-Relic metrics-stream prose. Do not add a
brittle semantic prose scanner to CI. Historical occurrences in the original Phase 8 evidence are
allowed only where clearly labeled superseded.

## Implementation sequence

Implement in small, independently verifiable batches:

1. **Freeze and amend authority.** Re-run the current gate, record baseline SHA/results, then amend
   PRD 02/06 and add the pointer from the original Phase 8 record. No behavior change precedes the
   approved PRD wording.
2. **Add focused failing tests.** Cover period isolation, month-boundary active concurrency, hot
   conversation lookup, application-pool server timeouts, migration snapshot continuity,
   many-tiny-delta read counts, and every terminal race before implementation.
3. **Optimize budget admission.** Split current-period spend from all-period active-workflow count
   inside the existing lock/transaction boundary. Run targeted PostgreSQL tests and safe query-plan
   evidence.
4. **Repair migration metadata and add migration `0006`.** Reconstruct the exact `0005` snapshot,
   prove journal/snapshot continuity, add the general conversation index, align the hot predicate,
   and prove empty/upgrade migration, uniqueness, lifecycle, and query plans.
5. **Consolidate stream authority.** Remove per-event database reads, reuse the existing 250 ms
   generation-local monitor, and pass local/remote cancellation, lifecycle, late-accounting,
   backpressure, and cleanup tests.
6. **Constrain Standard locally.** Update the container harness to 1 CPU / 2 GB and run the two
   fresh-database final-candidate rehearsals without changing workload or thresholds.
7. **Finalize source configuration.** Only after both local runs pass, update `render.yaml`, exact
   operations-audit assertions, README, and runbooks.
8. **Run the full repository gate.** Resolve only defects caused or exposed by this amendment; do not
   perform unrelated cleanup.
9. **Request separate external authorization.** Provision and exact-Render rehearsal remain a new
   action after repository acceptance. No external step is bundled into implementation approval.

## Required automated verification

### Targeted PostgreSQL and service verification

- Budget admission regressions listed above, including real concurrent transactions and month
  boundaries in a workspace timezone.
- History-heavy safe fixtures and reviewed query plans for current-period spend,
  active-conversation conflict, and conversation lifecycle/deletion lookup. Test semantics and
  index existence; do not make a PostgreSQL planner-node name a statistics-sensitive Vitest gate.
- Migration `0006` from empty PostgreSQL and from the exact `0005` schema.
- Migration journal entries and numbered snapshots have an exact one-to-one sequence through
  `0006`; generation against `0005` does not re-emit prior schema.
- Application connections enforce five-second client, statement, lock, and idle-transaction
  limits; the migration pool remains exempt from application statement/lock timeouts.
- All active-generation uniqueness, accounting, conversation deletion, compaction, and
  reconciliation tests remain green.
- Stream authority read-count, cancellation/deactivation/delete/shutdown, non-terminal
  rename/archive, CAS, late usage, slow-reader, and cleanup tests remain real listener/PostgreSQL
  tests where the established suite requires them.

### Configuration and operations verification

- `render.yaml` parses and has exactly one `standard` Web Service and one `basic-256mb`, 5 GB
  database with a 300-second shutdown delay.
- The audit rejects `pro_plus`, another Web plan, another database plan, a disk other than 5 GB,
  added services, HA, replicas, pooler, public access, removed `checksPass`, changed region, or
  secret literals.
- Runbook commands and links reference real repository entry points.
- Search finds no active baseline claim for Pro workspace, seven-day PITR, or a Render infrastructure
  metrics stream to New Relic. Clearly labeled historical Phase 8 evidence is exempt.
- The Docker harness proves exact Standard CPU/RAM limits and still refuses an unsafe target/database.

### Full local gate

Run and record:

```text
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm verify:repository
pnpm verify:operations
pnpm audit --prod --audit-level high
git diff --check
```

Also run the full Playwright matrix, production image build/smoke as non-root, current migration
history, secret/boundary scans, and both exact Standard built-container load rehearsals. A known
ignored local file may be disclosed only if it remains outside Git and is not changed; no gate is
declared green by hiding a tracked failure.

## Repository implementation record — 2026-08-09

Repository implementation is complete in the authorized working tree. No Render, DNS, Resend, New
Relic, OpenRouter, GitHub-setting, paid-inference, managed-load, or recovery resource was created or
modified.

### Delivered repository changes

- PRD 02, PRD 06, the Phase 8 cross-reference, README, Blueprint, CI, operations audit, and all
  active runbooks now agree on Hobby, Standard, `basic-256mb`, 5 GB, three-day PITR, and the
  New Relic/Render telemetry split. Historical `pro_plus` evidence remains labeled as superseded
  sizing evidence rather than rewritten.
- Budget admission retains the workspace -> membership -> conversation -> draft -> policy lock
  order and hard USD budget while separating all-period active-chat concurrency from current-period
  spend. The ordinary draft path combines its fresh post-wait conversation/draft, budget, and
  policy snapshot, speculatively prepares immutable selected-branch context before the workspace
  lock, and commits messages, reservation, selection, and draft consumption atomically.
- The three stable raw-SQL shapes in the serialized admission path use versioned named PostgreSQL
  plans through one narrow database helper. Request values remain bound, SQL and error precedence
  are unchanged, and a versioned name must be advanced whenever its statement text changes. The
  pinned Drizzle `0.45.2` session surface and direct PostgreSQL connection are intentional; a future
  transaction-pooling proxy or Drizzle upgrade must reverify this helper.
- Migration `0006` adds only the approved nullable-conversation lookup index. The missing exact
  `0005` snapshot was reconstructed, `0006` metadata was generated, and journal, SQL migration, and
  snapshot numbering are one-to-one through `0006`.
- A generation-local 250 ms durable-authority sampler replaces per-provider-event reads while
  retaining terminal fences, same- and cross-replica cancellation, partial-content durability,
  late accounting, backpressure, and cleanup behavior.
- Application PostgreSQL connections now enforce five-second client, statement, lock, and
  idle-transaction bounds with JIT disabled for this OLTP workload. The migration pool remains
  separately unconstrained by those application timeouts.
- Render's 300-second shutdown envelope contains a calculated and test-bounded 287-second
  application budget around the unchanged 240-second stream grace. Email, telemetry, reconciliation,
  and database cleanup remain bounded phases.
- The container load wrapper verifies exactly 1 CPU, 2 GiB RAM, 2 GiB memory-plus-swap, 256 PIDs,
  the non-root `node` user, five measured waves, 20 employees, 40 streams, the ten-connection pool,
  and every pre-existing threshold. No dependency, service, queue, cache, worker, collector, agent,
  replica, or public test route was added.

### Evidence-driven harness adjustment

The measured workload, five measured waves, fake-gateway timing, failure mix, canaries, pool size,
and thresholds did not change. The unmeasured complete-workload warm-up increased from five waves to
ten after two otherwise-green runs failed only the strict heap-slope gate by 306,424 and 264,984
bytes. Content-free heap snapshots attributed 144,192 of a 201,568-byte retained delta to generated
code, with the remainder dominated by V8 metadata; promises, sockets, abort objects, stream
lifecycle objects, and registries were stable or lower, and the longer process retained less heap
despite 282 additional generations. Ten complete unmeasured waves make that finite runtime/schema
stabilization part of warm-up while leaving the measured acceptance workload unchanged.

An initial ten-warm-up candidate still exposed response-start variance: one run passed at 462.42 ms
and the next failed at 645.85 ms while API, CPU, cancellation, event-loop, correctness, and cleanup
remained healthy. Content-free plan evidence showed about 6 ms of repeated PostgreSQL planning per
serialized admission. Versioned named plans reduced representative authority planning from 1.610 ms
to 0.006 ms and conversation/draft planning from 3.015 ms to 0.008 ms after PostgreSQL's normal five
custom-plan executions. This addressed the measured convoy without weakening serialization,
durability, snapshots, or thresholds. Experimental extra indexes were rejected and existed only in
a disposable database that was deleted; migration `0006` remains exactly the one approved index.

### Exact local Standard evidence

Both accepted runs used the same production-built image, manifest
`sha256:6a235844a3aa972195266dc8764c011ff0abb526b91f0beeb88622c34a4b06c0`,
with Docker-inspected size 100,092,097 bytes and user `node`/UID 1000. Each used a distinct newly
created, empty, migrated PostgreSQL 18 database, ten unmeasured warm-up waves, and five measured
waves. The wrapper verified the exact container limits before starting the workload.

| Worst measured value | Run 1 | Run 2 | Gate |
|---|---:|---:|---:|
| Ordinary API p95 | 46.82 ms | 39.28 ms | <= 300 ms |
| Ordinary API p99 | 63.35 ms | 89.08 ms | <= 750 ms |
| Response-start p95 | 432.27 ms | 398.91 ms | <= 500 ms |
| Cancellation p95 | 66.49 ms | 56.17 ms | <= 500 ms |
| Provider first-delta p95 | 940.03 ms | 918.99 ms | recorded, not an admission gate |
| Stream total p95 | 15,558.77 ms | 15,530.43 ms | recorded deterministic-gateway evidence |
| Application CPU | 20.28% | 19.65% | recorded; no invented local percentage gate |
| Event-loop p99 delay | 15.24 ms | 15.86 ms | recorded; API objectives remained green |
| Event-loop maximum delay | 90.05 ms | 85.98 ms | recorded; API objectives remained green |
| Peak application heap | 99,702,040 B | 85,380,264 B | 2 GiB hard container limit; slope checked separately |
| Peak application RSS | 234,573,824 B | 240,181,248 B | 2 GiB hard container limit; slope checked separately |
| Peak pool waiting | 34 | 30 | observed with pool total fixed at 10 |

Every measured wave reached 40 active streams, 40 active chat workflows, and 40 reserved chat
accounting rows. Each run produced the deterministic 35 completed, one failed, and four cancelled
stream outcomes per wave, zero unexpected HTTP 5xx, successful controlled reconciliation, ownership
canaries, idle pool `10/10`, zero waiting clients, zero active streams/workflows/compactions, and zero
reserved chat/compaction accounting after settlement. The strict post-GC heap/RSS slope gate passed
in both runs. All disposable load databases and containers were deleted.

The local PostgreSQL process was not constrained to Render's `basic-256mb` CPU/RAM/private-network
envelope. These runs close only the local Standard Web candidate gate; they do not claim managed
database capacity or Render scheduling evidence.

### Final local verification

- `pnpm check`: 301 files passed with no ignored-file exception.
- `pnpm typecheck`: protocol, API, and Web passed.
- `pnpm test`: 878 tests passed — 204 protocol, 457 API/PostgreSQL, and 217 Web.
- `pnpm build`: all production builds passed; the existing deferred Markdown chunk advisory remains.
- `pnpm test:e2e`: 37/37 passed across Chromium and the critical Firefox/WebKit matrix.
- `pnpm verify:repository`: boundary and credential scan passed for 403 files.
- `pnpm verify:operations`: Blueprint, runbook, and recovery-evidence validators passed, including
  their negative drift cases.
- `pnpm audit --prod --audit-level high`: the high/critical gate passed; one existing moderate
  development-server advisory remains.
- Production image: built, ran as UID 1000, contained migration `0006` and the SPA, excluded
  application source maps/tests/environment files, applied migrations from inside the image, and
  passed readiness, SPA navigation/assets, security headers, API 404, and private-build-metadata
  smoke checks.
- Bundle evidence: 814,538 raw / 314,317 gzip initial bytes; administration remains route-split.
- `git diff --check`, migration clean/upgrade/continuity tests, PostgreSQL query-plan tests, and
  disposable-resource cleanup passed.
- A final independent read-only audit found no actionable P1, P2, or P3 defect in the authorized
  repository scope.

### Local Starter capacity rejection

On 2026-08-09, the same production image was evaluated at the exact paid Starter Web envelope:
0.5 CPU, 512 MiB RAM, 512 MiB memory-plus-swap, 256 PIDs, and non-root `node`. The isolated load
driver gained a bounded `--employees 4-100` diagnostic option; 20 remains its default, every
employee still exercises two distinct-conversation workflows, and no application limit, workload
scenario, threshold, or provider timing changed. The direct capacity search used fresh migrated
PostgreSQL 18 databases for every candidate and never contacted OpenRouter.

| Employees / streams | Requested measured waves | Result |
|---|---:|---|
| 20 / 40 | 5 | failed response-start p95 at 599.63 ms |
| 15 / 30 | 3 | failed response-start p95 at 708.31 ms |
| 12 / 24 | 3 | failed response-start p95 at 516.80 ms |
| 11 / 22 | 3 | failed response-start p95 at 533.28 ms |
| 10 / 20 | 3, then 5 | diagnostic pass with worst 426.67 ms; full run failed at 687.68 ms |
| 8 / 16 | 5 | failed response-start p95 at 537.32 ms |
| 7 / 14 | 5 | latency and correctness completed; failed the locked monotonic-memory gate on 106,792 bytes of heap growth |
| 6 / 12 | two fresh 5-wave runs | first passed with worst response-start p95 365.82 ms; repeat failed at 562.76 ms |
| 5 / 10 | two fresh 5-wave runs | both passed; worst response-start p95 407.09 ms and worst ordinary API p95 144.81 ms |
| 4 / 8 | two fresh 5-wave runs | one failed the locked monotonic-memory gate on 74,128 bytes of heap growth; one passed with worst response-start p95 308.37 ms |

Five employees/ten streams is the highest tested candidate that produced two independent full
passes. Six employees/twelve streams produced one full pass, but its immediate fresh-database
repeat failed the unchanged response-start objective, making it the first unstable level. No
container was OOM-killed or restarted; passing runs peaked around 145 MiB RSS, so half-CPU admission
scheduling—not the 512 MiB memory ceiling—was the observed practical limit. The tiny monotonic-heap
failures are reported as gate failures rather than being waived or reclassified after measurement.

Starter is therefore rejected as a production candidate under the locked objectives: its highest
repeatable local result covers only 25% of the planned 20-employee launch workload when each
employee exercises the approved two-workflow limit. Standard remains the smallest locally accepted
Web plan and `render.yaml` remains unchanged. These results are local Web-container evidence only:
the host PostgreSQL server was not constrained to `basic-256mb`, and no result substitutes for the
managed Standard rehearsal. Every disposable Starter container and database was deleted after
evidence capture.

### Experimental Starter response-start diagnostic

The load harness also permits an explicitly selected 750 ms response-start p95 objective for a
bounded local Starter diagnostic. The option is allowlisted as `--response-start-p95-ms 750`, while
the default remains 500 ms so the locked PRD objective, Standard rehearsal, and all existing load
behavior remain unchanged. The diagnostic does not relax the ordinary API, cancellation,
correctness, isolation, lifecycle, pool, reconciliation, or memory gates.

A pair of fresh-database passes at 750 ms would make Starter locally eligible only under that
experimental objective. It would not amend the locked PRD, change the current Standard
recommendation or `render.yaml`, or substitute for the managed Render/`basic-256mb`, Ecuador, and
production-acceptance evidence.

The 2026-08-09 experiment did not produce that pair. Both final candidates used image
`sha256:b0e5def847fd9de7212c648fe0b3a8257ee0046b0af628081972cf9d40483236`
(100,093,245 bytes) as non-root `node`, and Docker reported the exact limits
`500000000 536870912 536870912 256 node`. Each candidate used its own new empty PostgreSQL 18.4
database with all seven migrations and was run sequentially at 20 employees, 40 active streams,
ten unmeasured warm-up waves, and up to five measured waves.

- Final run 1 failed a measured wave at 797.28 ms response-start p95 against the selected 750 ms
  objective. Its response-start p50 was 513.80 ms, ordinary API p95/p99 were 94.81/161.19 ms, and
  cancellation p95 was 177.83 ms. Target CPU was 19.30%, event-loop p99/maximum delay was
  69.27/105.78 ms, and failure-time diagnostics recorded peak heap/RSS of 66,388,728/160,575,488
  bytes. The target reached 40 active streams with a ten-connection pool and peak pool waiting of
  39. It had no OOM or restart and settled to zero active work, reservations, streams, or waiting
  clients before evidence capture. The harness stopped at the failed wave as required, so this was
  not a complete five-wave pass and did not emit the success-only per-wave first-delta report.
- Final run 2 completed five measured waves and passed every gate. Its worst wave values were
  response-start p50/p95 614.22/711.58 ms, ordinary API p50/p95/p99 8.02/80.22/172.78 ms,
  cancellation p50/p95 187.75/189.30 ms, first-delta p50/p95 1,200.74/1,227.87 ms, CPU 20.83%,
  event-loop p99/maximum delay 77.20/111.87 ms, peak heap 68,725,672 bytes, peak RSS 158,412,800
  bytes, and peak pool waiting 44 with pool total fixed at ten. Every wave reached 40 streams,
  workflows, and chat reservations; produced 35 completed, four cancelled, and one intentionally
  failed outcome; reconciled its controlled reservation; and returned to ten idle connections,
  zero waiting clients, zero active work, and zero reservations. The warmed memory-bound and
  monotonic-slope gates passed, with no OOM or restart.

A pre-final shakedown on the earlier reporting build completed its measured work but failed the
unchanged monotonic-memory gate on strictly increasing post-idle heap samples from 46,609,152 to
46,764,184 bytes, a 155,032-byte rise. That failure was not waived or counted as acceptance. It
exposed that memory-slope failure measurements also needed the selected objective, after which the
focused checks were repeated and the final image above was built once for both final candidates.

Because final run 1 failed, the experimental 750 ms objective did not pass twice. Starter remains
rejected, Standard remains the recommendation, and neither the locked 500 ms PRD objective nor
`render.yaml` changed. All exact-name Starter containers and disposable capacity databases were
deleted; the existing `capstone-chat-postgres-1` container and its normal databases were left
running and untouched.

### Remaining production gates

Production acceptance remains blocked on the separately authorized managed Render rehearsal and
live verification of `basic-256mb`, private-network behavior, Hobby `checksPass`, retained rollback
artifacts, DNS/TLS, Resend, New Relic OTLP/default log stream, Render infrastructure dashboards,
bandwidth/build notifications, OpenRouter privacy/catalog plus the minimal paid smoke, Ecuador and
device/accessibility evidence, deploy/drain/rollback, and isolated three-day PITR recovery. No such
external evidence was inferred from local success.

The four P2 items in **Named production-acceptance follow-up** remain launch blockers: silent-stream
heartbeat, browser stream watchdog, mid-use 401/session transition, and frozen interrupted-stream
presentation. They were deliberately not smuggled into this infrastructure-sizing amendment.

## Separately authorized Render rehearsal

Local success is necessary but insufficient. Before production acceptance, request immediate
authorization to create a separate disposable same-region Hobby workspace with exactly:

- one operator and no production resources, credentials, DNS, or employee data;
- one Standard Web Service;
- one `basic-256mb` PostgreSQL 18 database with 5 GB;
- the private database connection, ten-connection application pool, same image and migrations;
- fake model gateway/test runtime through the already approved load entry point, never a production
  test route and never paid 40-stream inference;
- external email disabled, with telemetry enabled and all telemetry/evidence content-free.

Use rehearsal-specific New Relic resource/environment names and a dedicated ingest credential used
only by the rehearsal, so log/OTLP acceptance does not reuse the production secret. If New Relic
does not provide narrower permission scope for that key type, isolation comes from a separate key,
labels, and immediate revocation. Remove its rehearsal resources during accepted cleanup. Any
deliberate credential reuse would require separate explicit authorization and must not be
improvised.

The existing load driver needs direct database access for fixture setup and content-free state
assertions, while the production image intentionally exposes no seeding route. During only this
separately authorized disposable rehearsal, temporarily allow the operator's exact current public
IP on the rehearsal database external endpoint. Remove the rule immediately after the run and
accept evidence only after the allowlist is empty and private application connectivity is
reverified. Do not add a test HTTP route, one-off worker, or permanent public database access.

Run the unchanged 20-employee/40-stream workload and capture Web plus managed-database evidence:

- all locked latency, correctness, stream, isolation, pool, reservation, cancellation, and memory
  gates;
- Web CPU/RAM/restarts/network and database CPU/RAM/disk/connections/transactions/lock-delayed/top
  query evidence available in Render;
- private-network behavior and absence of public database access;
- deploy/readiness/drain under a long fake stream and immediately previous compatible rollback;
- a real `checksPass` deployment event on Hobby, with the exact GitHub candidate/check result linked;
- supported default Render logs arriving in New Relic and Fastify OTLP traces/application metrics;
- no reliance on Pro-only metrics streaming, edge request logs, or response-latency dashboards.

Destroy disposable resources only after evidence is accepted. Their prorated cost is separate from
the USD 32.50 base estimate.

Do not place the rehearsal beside production in another environment of the production Hobby
workspace and call it isolated. Same-region resources in one Render workspace share the private
network, and Hobby cannot block cross-environment traffic. A separate disposable workspace is the
mandatory boundary and also verifies Hobby `checksPass`; the future production workspace is never
used for rehearsal, and no permanent staging environment is introduced.

To prove `checksPass` after a candidate is already green, separately authorize a temporary Git
branch and unmerged pull request from the exact candidate tree, with a no-source-change follow-up
commit tracked only by the disposable service. The pull request is required because current CI runs
on `main` pushes and pull requests, not arbitrary branch pushes. Record that the required GitHub
quality check concludes `success` and that the Render deploy starts afterward; `neutral`, `skipped`,
or an unexplained manual deploy is not acceptance evidence. Do not push an empty commit to production
`main`. Close the pull request and remove the disposable service/branch after evidence is accepted.

If the exact candidate fails:

1. Keep the workload and thresholds fixed.
2. Determine whether the cause is query/lock, Web CPU/RAM, managed database CPU/RAM/I/O, pool,
   platform, or harness behavior using content-free evidence.
3. Fix only a bounded application defect that preserves architecture and contracts, then repeat the
   full relevant gate.
4. If healthy code is resource-bound, stop and present the measured smallest vertical change and
   monthly cost to the user. Do not apply it until explicitly approved and source-controlled.

## Production acceptance after repository acceptance

This amendment does not repeat every Phase 8 production step. It changes these acceptance points:

1. Confirm the live workspace is Hobby, has one intended operator, and has verified account recovery.
2. Confirm the live estimate and alerts for bandwidth/build usage; record that USD 32.50 is base
   infrastructure only.
3. Confirm Standard and `basic-256mb`/5 GB exactly match the committed Blueprint before first sync.
4. Confirm `checksPass` works on Hobby; stop rather than changing to commit-trigger deployment.
5. Confirm the database is created at 5 GB, uses private networking, has no public allowlist, and
   exposes three-day PITR.
6. Confirm New Relic receives Fastify OTLP and the supported default log stream. Confirm Render
   dashboard—not New Relic—contains infrastructure metrics, with seven-day history and no external
   infrastructure alerts.
7. Pass the exact Render capacity/deploy/rollback rehearsal and record absolute headroom as the
   configured limit minus observed peak. Headroom is diagnostic; the unchanged latency,
   correctness, no-exhaustion, and memory gates remain authoritative, and the implementer must not
   invent a new CPU/RAM percentage threshold mid-run.
8. Let PITR history age to three days, then run the separately authorized isolated rehearsal. Keep
   RPO <=15 minutes, RTO <=4 hours, and the source untouched.
9. Complete every unchanged Phase 8 gate: CI on exact commit, DNS/TLS, Resend, identity, security,
   privacy audit, browsers/devices/accessibility, Ecuador performance, minimal authorized OpenRouter
   smoke, runbook review, and generated-subdomain disablement.

Production readiness must identify the exact commit, migration, Render plans/storage, prices at
provisioning, load report, observability limitations, restore evidence, provider spend, and every
remaining external/manual item. No local result is labeled production evidence.

## Risk register and explicit responses

| Risk | Required response |
|---|---|
| `basic-256mb` is the actual bottleneck | Exact managed rehearsal; bounded query fixes first; user-approved vertical resize only if measured |
| Workspace budget lock convoy persists | Preserve serialization, bound scanned rows, record lock/latency evidence; never weaken the hard budget |
| Stream polling change leaks post-cancel deltas | Same-replica and remote race tests, shared 250 ms sampler, no write after observed terminal, CAS-protected persistence |
| Client timeout leaves work or lock waits alive in PostgreSQL | Matching five-second server statement/lock/idle-transaction bounds on application connections; migration pool remains separate |
| Render terminates before bounded shutdown completes | 300-second platform maximum around the calculated and test-bounded 287-second application budget; retain 240-second stream grace |
| 5 GB is selected too late | Blueprint and preflight before creation; stop if a larger database already exists because storage cannot shrink |
| Hobby lacks `checksPass` in practice | Verify before acceptance; stop for user decision, never silently change deploy trigger |
| Infrastructure incident is not alerted externally | Explicitly accepted manual Render-dashboard posture; retain app/log alerts; no replacement agent/collector |
| Single Render operator loses access | MFA/recovery evidence and named ownership outside repository; app roles remain unchanged |
| Hobby log/metric history is too short | New Relic retains approved app/log telemetry; Render infra history remains seven days; incidents record safe evidence promptly |
| Bandwidth/build allowance is exceeded | Render billing notifications, weekly review, and explicit pipeline spend limit; overage is variable cost, not a reason to drop observability or CI |
| Rollback artifact ages out | Expect five recent artifacts but verify live; exercise the immediately previous compatible rollback before aging and before each deploy |
| Three-day PITR weakens deletion/recovery assumptions | Update disclosure, age the window, rehearse isolated restore, retain RPO/RTO |
| Provider spend exceeds expectation | Application USD 100 budget remains hard; paid tests require approval; do not promise “single digits” without evidence |

## Named production-acceptance follow-up

Resolution recorded 2026-08-10: the authorized DigitalOcean/PlanetScale repository amendment
closed all four defects with the approved 15-second content-free heartbeat, 35-second browser
watchdog, authentication-generation 401 fence, and terminal interrupted-response presentation.
Protocol, API, web, and critical Chromium/Firefox/WebKit regressions cover the correction. This
historical section remains below to preserve the original acceptance blocker.

Four previously reviewed P2 defects are outside this infrastructure-sizing amendment's bounded
repository changes, but they are not waived. They have one named home: **Phase 8 production-
acceptance defect closure**, which must land, pass the full relevant gate, and be linked from the
final production acceptance record before any launch claim:

1. **Silent-stream heartbeat:** add a content-free server heartbeat compatible with the locked
   NDJSON protocol so a provider silence window is not mistaken for a dead proxy connection.
2. **Client stream watchdog:** bound a browser stream that becomes silent or truncated without a
   terminal event and recover canonically without duplicating or losing visible content.
3. **Mid-use 401/session transition:** move an already open application cleanly to the signed-out
   boundary when a session expires or is revoked, while fencing stale authenticated completions.
4. **Frozen interrupted-stream presentation:** ensure a canonically interrupted/incomplete response
   cannot remain visually frozen in an active-stream state after recovery or reload.

These defects do not authorize protocol/UI work in this amendment and do not invalidate its sizing
evidence when the exercised flows are otherwise correct. They do block production acceptance. Any
fix that changes the public stream contract or a locked product behavior requires its own explicit
PRD/plan amendment rather than being smuggled into deployment work.

## Phase boundary

The approved amendment is infrastructure sizing, operational posture, and bounded performance work
inside Phase 8. It does not reopen Phases 1–7 or authorize a Phase 9 feature.

Do not add or change documents, retrieval, uploads, tools, agents, memory, images, sharing, teams,
roles, SSO, billing, employee budgets, model controls, providers, content types, conversation
behavior, UI, or transport contracts. Do not perform broad refactors while touching the admission or
streaming coordinators. Extract only a narrow helper if it makes the final control flow more direct
than the existing function; otherwise keep the established pattern.

## Definition of done

Repository implementation is complete only when:

- PRD 02, PRD 06, Phase 8 cross-reference, this amendment, README, Blueprint, audits, and runbooks
  agree on Hobby, Standard, `basic-256mb`, 5 GB, three-day PITR, and the New Relic/Render split;
- no unrelated locked decision changes;
- budget admission scans only the current authoritative period for spend while counting active
  employee chat workflows across periods under the existing lock order;
- migration `0006` and predicate alignment provide measured bounded conversation lookup without
  weakening uniqueness or deletion/accounting behavior;
- one generation-local 250 ms durable-authority sampler shared by the monitor/event loop replaces
  per-event database reads and all terminal, partial-content, accounting, backpressure, and cleanup
  races pass;
- the exact Blueprint and operations audit fail closed on configuration drift;
- application PostgreSQL waits are bounded server-side without constraining the migration pool, and
  migration journal/snapshot continuity is restored through `0006`;
- two fresh-database local Standard rehearsals pass the unchanged workload and every threshold with
  absolute resource evidence;
- all ordinary, migration, PostgreSQL, browser, image, audit, secret, boundary, and AGENTS.md gates
  pass;
- the implementation record states that `basic-256mb`, private Render behavior, Hobby checks-pass,
  managed load, observability integrations, and PITR remain externally unverified until their
  separately authorized rehearsals;
- no dependency, service, cache, queue, worker, collector, agent, replica, secret, paid call, or
  external mutation was introduced;
- no unresolved P1/P2 defect inside this amendment's authorized repository scope or unsupported
  production-readiness claim remains; the four named follow-up P2s above remain explicit production
  acceptance blockers rather than being silently treated as accepted.

Production acceptance is a later gate. It additionally requires exact Render rehearsal, live
Hobby/Standard/database configuration, CI-trigger evidence, DNS/TLS, identity email, New Relic and
Render dashboard verification, privacy sample audit, Ecuador/device/accessibility checks, the
separately authorized minimal OpenRouter smoke, deploy/drain/rollback, and the isolated three-day
PITR rehearsal. It also requires the named production-acceptance defect-closure follow-up to be
implemented and verified.

## Authorization boundary

The user granted both plan approval and repository implementation authorization on 2026-08-09.
That repository grant does not authorize creating or modifying any Render, DNS, Resend, New
Relic, OpenRouter, GitHub, production, load-rehearsal, or recovery resource. Each paid or external
mutation remains a separately announced action with its target, expected cost, and rollback/cleanup
path.
