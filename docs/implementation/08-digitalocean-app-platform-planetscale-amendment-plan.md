# Phase 8 amendment: DigitalOcean App Platform source builds and PlanetScale

Status: repository implementation complete; direct staged production provisioning selected;
production acceptance is not granted.

Date: August 12, 2026.

This is the active Phase 8 production amendment. It supersedes the Render and raw-Droplet
deployment adapters and the earlier GHCR/exact-digest version of this App Platform plan. Git
history keeps those attempts as evidence; they are not launch fallbacks.

## Approved decisions

The owner explicitly chose the following candidate:

- one DigitalOcean App Platform dynamic service in managed region `ric`;
- one instance of `apps-s-1vcpu-1gb-fixed` for the service and one
  `apps-s-1vcpu-0.5gb` `PRE_DEPLOY` migration job;
- native DigitalOcean GitHub source builds from `jmjalil96/capstone-chat` and
  `apps/api/Dockerfile`;
- automatic deploys disabled;
- a protected `app-platform-production` release-pointer branch for production and
  `app-platform-rehearsal` for synthetic rehearsal;
- one paid Dedicated Egress pair;
- PlanetScale Postgres PS-5 ARM Single Node in AWS `us-east-1`, 10 GB initially with a hard
  15 GB ceiling, backups every 12 hours retained for 84 hours;
- the public origin `https://chat.capstone.com.ec` through App Platform's managed
  Cloudflare-backed edge;
- Resend Free for transactional mail, New Relic Free for retained application telemetry, and
  Bitwarden Teams as the recoverable secret source; and
- the existing USD 100 monthly model-spend ceiling.

The current infrastructure estimate remains USD 40–41 per month: USD 10 service, up to USD 25
Dedicated Egress, USD 5 PlanetScale, and USD 0–1 Uptime. One Bitwarden Teams owner adds USD 4.
Temporary jobs, rehearsal resources, transfer, storage/WAL overage, taxes, and model use are
additional.

The repository and its historical GHCR package are currently public. Native source deployment
does not expose code that is not already public. No `LICENSE` file exists, so public visibility
does not grant an open-source license. Changing repository visibility or deleting the unused GHCR
package is a separate decision and, for deletion, separate destructive authorization.

DigitalOcean's live catalog currently labels both selected fixed-size slugs as feature preview.
On August 13, 2026, the owner explicitly accepted that provider-lifecycle risk for the selected
production topology rather than switching to a different size.

## Why the release design changed

The earlier adapter published an immutable GHCR image, resolved its digest, introduced and rotated
registry credentials, reconciled GitHub and DigitalOcean release ledgers, guarded custom API spec
mutations, and retained protected image versions. That design was internally safe but made a
managed platform feel like a self-managed host.

App Platform can build the repository Dockerfile directly. The approved simplification removes
the registry and digest control plane and keeps the controls that protect real data and release
authority.

The trade-off is explicit: rebuilding an old source commit is not guaranteed to reproduce a
byte-identical OCI artifact. Recovery authority is now the exact protected Git commit, the
source-controlled Dockerfile and App contracts, green CI evidence, an offline Git bundle,
Bitwarden, and the managed database—not a retained image digest. CI still builds and smokes the
same Dockerfile before the commit can become a release.

## Release authority

GitHub Actions remains the authoritative validation gate. The source integration never follows
`main` directly:

1. The operator starts the protected production workflow from the current `main` commit.
2. The workflow requires the exact commit's CI run to have succeeded.
3. For a normal release, it first verifies the existing App has exactly one named service and one
   named `PRE_DEPLOY` migration job, no other component class, the intended source pointer, and
   autodeploy disabled. The complete live-contract validator remains an acceptance gate and checks
   both desired and actively deployed specs. First provisioning therefore performs one separately
   authorized dashboard transition from bootstrap to the exact final contract and validates its
   provisional active deployment before this workflow can run; the workflow is not a configuration
   mutator.
4. Under one non-cancelling production concurrency group, it advances
   `app-platform-production` to that commit with a non-force fast-forward push. Its bounded
   `prepare-source` operation can create an absent pointer or confirm the same commit, but cannot
   advance an existing pointer; this allows the branch to exist before the first App is created
   without becoming a post-provisioning bypass.
5. App Platform builds from that pointer with `deploy_on_push: false`.
6. The workflow requests one deployment and waits for a terminal provider result.
7. Acceptance requires the service and `PRE_DEPLOY` job to report the authorized
   `source_commit_hash`, the migration to succeed, and public readiness to report the same runtime
   revision.

The pointer removes the race in which `main` could advance after CI verification but before the
provider fetches source. Branch rules block force pushes and deletion. The production workflow is
the only authorized steady writer; the repository administrator remains a platform-level bypass
authority and is monitored rather than falsely claimed away. The rehearsal pointer has the same
purpose but no production authority. During a separately authorized synthetic rehearsal, the
operator may create or non-force fast-forward it to the recorded green commit, verify the remote
value immediately, and must never move it backward or reuse it for production.

DigitalOcean's GitHub integration is limited to this repository. Pull-request preview Apps remain
disabled. A source integration or branch-protection change is a release-authority change and must
be reviewed like a deployment workflow change.

## Docker and revision identity

DigitalOcean exposes `${_self.COMMIT_HASH}` as a runtime bindable but does not make bindables
available as Dockerfile build arguments. Therefore:

- `apps/api/Dockerfile` must build without `DEPLOYMENT_REVISION`;
- the production service and job receive `DEPLOYMENT_REVISION=${_self.COMMIT_HASH}` at runtime;
- the API validates that value as a full commit and reports it through readiness and safe
  telemetry;
- the browser bundle's compiled revision is `unknown`; it is diagnostic only and is not release
  authority;
- the Node/Alpine build and runtime base use the same pinned multi-platform digest so rebuilding an
  accepted commit cannot silently pick up a different base image;
- the Dockerfile frontend is pinned by digest for the same reason; and
- CI verifies the non-root runtime, required files, migration, health behavior, and runtime
  revision override against its local container build.

Service and job source commits must match. A mixed-source deployment, missing commit, build
failure, failed migration, or readiness mismatch is rejected.

## Provider contract

The source-controlled adapter contains four contracts only:

- `bootstrap.contract.yaml`: production health-only service;
- `app.contract.yaml`: final production service and migration job;
- `rehearsal-bootstrap.contract.yaml`: synthetic health-only service; and
- `rehearsal.contract.yaml`: final synthetic load service and migration job.

Each contract fixes repository, release-pointer branch, root source directory, Dockerfile,
autodeploy-off policy, region, size, count, command, health checks, termination budgets,
environment names/scopes, alerts, and—where final—Dedicated Egress, domain, TLS, and edge policy.
Contracts contain no secret, encrypted provider value, or per-release commit.

A small read-only validator accepts a mode, expected full commit, and a protected `0600` capture
from `doctl apps get --output json`. It validates the complete expected topology, encrypted secret
scope, two assigned Dedicated Egress IPv4 addresses, domain/edge policy, active deployment, and
component source commits. It cannot create, update, delete, deploy, open a console, or rotate a
credential.

Intermediate egress, domain, and initialization states are guided runbook steps rather than six
duplicated contract files. The operator checks provider state immediately after each step and
cannot treat the App as final until the final contract validator passes.

## Staged first provisioning

Native source builds do not weaken the security-sensitive ordering:

1. Connect this repository and the rehearsal release pointer with autodeploy disabled.
2. Create only the health-only bootstrap service. It receives no database, auth, email, model,
   telemetry, or application secret. Custom-domain-only edge fields remain absent.
3. Enable Dedicated Egress and wait for exactly two stable, assigned IPv4 addresses.
4. Create PlanetScale and its separate application, migration, initialization, recovery, and
   temporary load roles. Allowlist both egress addresses as individual `/32`s before delivering a
   database credential. Never use `0.0.0.0/0`.
5. Attach the temporary rehearsal domain, then apply the exact final edge settings:
   `disable_edge_cache: true`, `disable_email_obfuscation: true`, and
   `enhanced_threat_control_enabled: false`.
6. Add the one-time initialization `PRE_DEPLOY` job with only its two bootstrap database URLs,
   temporary catalog credential where applicable, and the bounded canonical initialization
   document. Run and verify the durable document-hash latch.
7. Remove the initialization job and variables; revoke its database roles and temporary provider
   credential. Prove historical replay cannot mutate initialized authority.
8. Under the separately authorized first-provisioning grant, transition the dashboard from the
   bootstrap configuration to the exact final contract. Install only steady component-scoped
   secrets: the service receives the application database role and its application/provider
   credentials; the migration job receives only its migration `DATABASE_URL`; the recovery role is
   absent. Keep the source pointer fixed while this provisional deployment runs.
9. Validate both the desired App spec and `active_deployment.spec` against the final contract,
   including expected source commit, successful migration, readiness, domain, edge, egress,
   secret-scope, and absence of extra active components. The provisional production deployment is
   not accepted or opened to employee traffic.
10. Run the protected production workflow to establish the accepted source release, then repeat
    the active-contract, source-identity, readiness, and telemetry checks.
11. Keep the service closed while every pre-invitation launch gate runs, including bounded
    production smokes, Ecuador/browser/accessibility, aged isolated PITR, controlled cold
    recreation, and the pre-invitation review. Only then send the initial owner invitation as the
    final controlled email gate. Prove invitation, verification, and password-reset delivery and
    record final acceptance before inviting a second employee.

Production repeats the same sequence under separate authorization and with production-owned
credentials/data. A managed rehearsal may use only synthetic `.test` identities, fake model
behavior, disabled/fake email, content-free telemetry, and an isolated database.

## Database boundary

PlanetScale remains ordinary PostgreSQL from the application's perspective. Connections use
direct port 5432 and `sslmode=verify-full`. The application role cannot perform migrations or
administration. The migration role exists only in the `PRE_DEPLOY` job. Recovery credentials are
never installed in the App. The database admits both exclusive Dedicated Egress `/32`s and no
general Internet source.

No database transaction or connection is held across a network wait. The established pool,
statement, lock, idle-transaction, and connection timeouts remain unchanged.

## Secret and privacy boundary

Recoverable values live in the Capstone Bitwarden organization. App Platform copies are encrypted,
component-scoped `RUN_TIME` variables. No secret is a Docker build argument, build-time variable,
source file, GitHub artifact, process argument, command output, App spec capture, or evidence field.

The service, migration, initialization, recovery, source integration, and deployment token are
separate authorities. Provider-encrypted values are not treated as recoverable source copies.
Configuration changes are performed in the dashboard only after freezing the release pointer and
confirming the intended source commit; App Platform configuration changes can trigger a rebuild.

The App Platform/Cloudflare plaintext-processing boundary accepted on August 12, 2026 remains in
force. The application trusts only DigitalOcean's `do-connecting-ip` boundary and strips all other
forwarding headers. Edge caching and email obfuscation are disabled for the custom domain.

## Deployment and rollback

Normal release is the protected workflow described above. There is no GHCR publication, image
pull credential, digest patch, registry rotation, retention planner, custom provider API adapter,
or GitHub Deployment ledger.

Rollback remains forward-only:

1. identify the last compatible accepted source commit;
2. create and review a normal `git revert` on `main`;
3. run every CI gate on the new descendant commit;
4. deploy that new commit through the production release-pointer workflow; and
5. verify migration compatibility, source identity, readiness, long streaming, and safe telemetry.

DigitalOcean native rollback is prohibited because it can restore historical configuration,
secrets, pre-egress state, or initialization authority. Database rollback is not coupled to an
application rollback; destructive migrations require their own forward recovery plan.

## Recovery

Before launch, create an encrypted offline Git bundle containing protected `main`, both release
pointers, and accepted release commits. Test cloning and checking out the recorded commit without
GitHub. The bundle contains source only—never credentials.

Controlled App recreation uses the exact accepted commit, Dockerfile, final contract, Bitwarden
source credentials, and a newly restricted egress pair. It must not receive the original
initialization document or rerun first initialization. The completed latch and existing
administrator/model authority must be verified. The custom domain is detached before the old App
is deleted whenever deletion is controlled.

PlanetScale PITR remains an isolated restore procedure with at most 15-minute RPO and four-hour
controlled-recovery RTO. Backups run every 12 hours and are retained for 84 hours. The
owner-approved exception for accidental App deletion while the custom domain remains attached is
best-effort with a maximum 24-hour domain-binding objective.

## Observability and acceptance

App Platform Insights/alerts own deployment, domain, job, CPU, memory, restart, request, and
latency signals. One DigitalOcean Uptime check owns independent public readiness/TLS/latency.
PlanetScale owns protected database signals. New Relic receives vendor-neutral OTLP plus the
bounded content-free direct log mirror. No provider receives prompts, responses, drafts,
summaries, titles, searches, recipient addresses, action URLs, cookies, authorization headers,
database URLs, or raw provider bodies.

On August 13, 2026, the owner explicitly replaced the two disposable managed rehearsals with
direct staged production provisioning. This explicitly waives the two managed synthetic
20-employee/40-stream passes and accepts the two clean one-CPU/one-GiB container repetitions as
capacity evidence. The test-only fake load server correctly refuses production mode and the
production hostname; neither that server nor its diagnostic routes are introduced into the final
production contract. Before any invitation or real employee data, the empty production stack must
still pass bounded real-path model-event, cancellation, five-minute streaming,
build/migration/readiness failure-preservation, forward-revert, egress, database, source-identity,
secret-isolation, DNS/TLS, telemetry, and Ecuador checks. Aged PITR and controlled cold recreation
also remain required before the first invitation. That initial owner invitation is the final
controlled email gate; invitation, verification, and password-reset delivery plus final acceptance
are required before any second employee is invited.

Public-source acceptance, live provider terms, Ecuador latency/device/accessibility checks, paid
OpenRouter smoke, Resend delivery, DNS/TLS, New Relic, PITR, and final security review remain
external gates. The feature-preview size risk was accepted on August 13, 2026.

## Repository simplification

The approved implementation removes the obsolete GHCR/digest control plane rather than preserving
compatibility shims:

- CI image publication;
- GHCR retention workflow, planner, fixtures, and recovery pins;
- registry credential introduction, preservation, and rotation;
- digest resolution, exact-image reconciliation, release ledger, and predecessor rollback;
- custom App Platform create/update/configuration API clients and mutation fingerprints;
- custom provisioning and console-tunnel helpers; and
- the six intermediate contract duplicates and their tests.

The retained deployment surface is the four contracts, one read-only validator and CLI, one small
protected production release workflow, the production Dockerfile, and the operator runbooks.
Application runtime code, initialization/migration commands, telemetry, database safety, load
harness, and recovery evidence validation remain unchanged except where release identity moves
from digest to source commit. The abandoned Caddy client-address mode is also removed; local/test
uses the socket address and production/rehearsal uses the App Platform boundary only.

The historical GHCR package is unused external state. It is not deleted by repository work.

## Verification and implementation record

Repository implementation completed on August 12, 2026 against frozen base revision
`08ed205398da1f662658cff7f837032bc3700c14`.

The simplification changed 69 tracked paths: 34 obsolete files were removed, including two
workflows and 32 App Platform adapter files. The resulting diff removes 12,246 lines and adds
2,561, for a net reduction of 9,685 lines. A repository-wide reference audit found no active
caller for the removed GHCR, digest, registry-credential, provider-mutation, native-rollback,
Droplet, Render, or Caddy paths. Historical decision records and negative audit fixtures remain
intentionally.

Local verification passed:

- `pnpm run ci`, including formatting, repository and operations audits, TypeScript, 1,012
  unit/PostgreSQL tests, production builds, and the bundle report;
- 42 Playwright scenarios across Chromium and the critical Firefox/WebKit matrix;
- strict App Platform contract, desired-spec, active-deployment-spec, workflow-schema, and
  source-release guard coverage;
- a production Docker image built without a revision argument, running as `node`, containing
  migration `0007`, and passing a runtime-revision/container smoke against a disposable database;
- two five-wave load repetitions inside a one-CPU/one-GiB container envelope. The recorded worst
  `response.started` p95 was 263.48 ms, peak application RSS was 190,984,192 bytes, and every
  concurrency, cancellation, reconciliation, cleanup, memory-slope, and no-restart gate passed;
- the high/critical production dependency gate, with one existing moderate development advisory;
  and
- `git diff --check`, secret/boundary scans, and a final active-authority reference audit.

The final independent read-only review found no remaining P1 or P2 repository findings.

### Bootstrap source-build proof

The owner separately authorized one disposable bootstrap-only rehearsal on August 12, 2026 with a
USD 1 actual-spend ceiling, four-hour lifetime, and deletion in the same grant. The protected
`app-platform-rehearsal` pointer was created non-force at green commit
`080131854a001460140f02d1875e84485abe748f`. Its active branch rule blocks deletion and force
pushes and requires linear history. The DigitalOcean GitHub installation was narrowed to only
`jmjalil96/capstone-chat`, and automatic deploys remained disabled.

DigitalOcean's provider-side proposal accepted the exact health-only spec in `ric` at USD 10 per
month. App `85794e59-748e-488e-b3de-59ef0bcaf150` created deployment
`3ae925c9-4782-4f56-b507-4a566f63672a` from the expected source commit. The Dockerfile build and
deployment completed successfully, the desired and active specs contained exactly one
one-container service, readiness and liveness returned 200, and a product route returned 404.
No database, Dedicated Egress, custom domain, job, secret, telemetry, email, inference, or load
traffic was introduced.

The live capture exposed one provider canonicalization absent from the repository fixtures:
DigitalOcean injects top-level `features: [buildpack-stack=ubuntu-22]` into both desired and active
specs, including Dockerfile builds. The four contracts and validator now require that exact
singleton value and reject missing, changed, or additional values. With only that fail-closed
correction, the untouched live response passed the complete `rehearsal-bootstrap` validator.

The App existed from 21:14:53 UTC until verified deletion at 21:23:21 UTC—eight minutes and 28
seconds, well inside both caps. The provider API returns 404 for the deleted ID and the rehearsal
token sees zero Apps. The repository-scoped GitHub installation and protected rehearsal pointer
remain as authorized. This source-build proof is not either of the two full managed rehearsal
passes; Dedicated Egress, PlanetScale, domain/TLS, initialization, migration, telemetry, load,
PITR, and cold recreation remain unverified.

Repository verification alone authorizes no DigitalOcean App, PlanetScale resource, domain,
secret, email, model call, deployment, or billable action. The owner supplied the production
direction recorded below; every external batch still follows the approved target, cost, data,
credential, rollback, and cleanup boundaries and stops when it needs broader authority.

### Direct-production decision

On August 13, 2026, the owner ended the disposable managed-rehearsal path and directed the launch
to the real production stack. This decision accepts the selected DigitalOcean feature-preview
sizes and explicitly waives the two managed qualification passes in favor of the two existing
resource-capped container passes plus bounded production smokes. It does not change the approved
USD 44–45 monthly operational baseline, the separate USD 100 workspace model ceiling, any data,
privacy, secret-scope, database, egress, TLS, initialization, deployment, rollback, or recovery
boundary, or the prohibition on employee traffic before the closed production checks above pass.
Production resources are persistent rather than covered by the prior rehearsal cleanup grant;
failed partial provisioning is removed or revoked before retry, while an accepted live release
uses compatible forward recovery rather than provider-native rollback.
