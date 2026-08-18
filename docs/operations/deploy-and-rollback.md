# Deploy and rollback

The release authority is one full protected-main Git commit that passed CI and was advanced
without force to `app-platform-production`. DigitalOcean builds that pointer with automatic
deploys disabled. A release is accepted only when the service and `PRE_DEPLOY` job report the
authorized `source_commit_hash` and public readiness reports the same runtime revision.

The release pointer has no direct human writers and does not accept force pushes. The protected
workflow is the only steady deployment writer. App Platform's native rollback action is
prohibited because it can restore historical secrets, pre-egress configuration, or initialization
authority.

## One-time GitHub release setup

1. In repository Actions settings, allow the repository `GITHUB_TOKEN` read/write workflow
   permissions. This workflow narrows its own token to `actions: read` and `contents: write`; no
   other production permission is granted.
2. Create a branch rule or ruleset matching `app-platform-production` before the branch exists.
   Block force pushes and deletion and require linear history. Do not require pull requests on
   this machine-written pointer. Repository-admin authority cannot be eliminated in a personal
   repository, so direct human updates remain prohibited by procedure and are checked against the
   recorded release evidence.
3. Create the protected GitHub environment `production`, restrict it to `main`, add the owner as
   required reviewer, and do not permit an unreviewed administrator bypass.
4. After the App exists, store its UUID as the environment variable `DIGITALOCEAN_APP_ID`. Store a
   dedicated DigitalOcean token as `DIGITALOCEAN_DEPLOY_TOKEN`. Its custom scopes are exactly
   `app:update` plus DigitalOcean's required `app:read`, `regions:read`, `sizes:read`, and
   `actions:read`; omit `app:create`, `app:delete`, `app:access_console`, database, registry, and
   account-wide write scopes.
5. Before the first App exists, copy the exact full SHA from the green `main` CI run and dispatch
   `Deploy production` with `operation=prepare-source` and that SHA as `release_revision`. The run
   creates an absent `app-platform-production` pointer (or confirms it is already at that SHA) and
   records that no App was contacted. Verify the remote pointer equals the SHA, then connect that
   branch in App Platform with autodeploy disabled.

The App ID and DigitalOcean token are intentionally unnecessary for `prepare-source`. That mode is
one-time/idempotent-only: it creates an absent pointer or confirms the existing pointer already
equals the requested SHA; it cannot advance an existing pointer. Every later production run uses
`operation=deploy`. A full SHA can also be obtained from a clean local clone with
`git fetch origin main && git rev-parse origin/main`; it must equal the current green push run.

## Normal deployment

1. Confirm the candidate is the exact current protected `main` HEAD, every required CI check is
   green, the tree is clean, and no App deployment or configuration change is in progress.
2. Review migration compatibility with the active release and a forward-revert candidate. CI must
   have built and smoked `apps/api/Dockerfile`, verified UID 1000, required runtime files and the
   latest migration, and exercised readiness with the candidate runtime revision.
3. Inspect App Platform service/job/domain/egress/health/alerts, the independent Uptime check,
   PlanetScale connections/locks/storage/backups, and New Relic application signals.
4. Run the protected `Deploy production` workflow from `main` with `operation=deploy` and the exact
   40-character green `main` SHA as `release_revision`. Its non-cancelling concurrency group
   checks the current App topology/source and autodeploy-off state before it advances
   `app-platform-production` by non-force fast-forward, then requests one App Platform deployment
   and waits for a terminal result.
5. Observe the `PRE_DEPLOY` migration job. It receives only the migration `DATABASE_URL`, connects
   directly on port 5432 with `verify-full`, and exits nonzero on configuration or migration
   failure. API startup never runs migrations. A failed build/job/replacement must leave the
   current ready release serving.
   The workflow records the provider deployment ID immediately, then polls that exact deployment
   for up to DigitalOcean's one-hour build limit; it does not rely on `doctl --wait`'s shorter
   timeout. If the workflow becomes red or loses connectivity after recording the ID, freeze the
   release pointer and all App configuration, inspect that exact ID in App Platform, and resume
   only after its terminal state is known. Never request a second deployment to resolve ambiguity.
6. Require exactly one service and one migration job built from the authorized source commit.
   Verify region, sizes, instance count, domain, edge policy, two Dedicated Egress addresses,
   health checks, drain/grace budgets, secret scopes, and active deployment ID using the read-only
   live validator.
7. Verify public readiness returns the authorized revision, then exercise origin/session, an owned
   conversation, one response, Stop and canonical recovery, authorization, email category, and
   content-free telemetry under separate smoke authorization.
8. Record only UTC times, source revision, deployment/build IDs, migration, status, duration, safe
   counts, and resource peaks.

The workflow uses the production environment's pinned App ID and least-privilege DigitalOcean
token. It cannot create or delete an App or open a console. A repository source build is not a
byte-identical rebuild guarantee; accepted release evidence is the source commit, CI build/smoke,
provider source hashes, and runtime readiness revision.

## Phase 11 clean-slate cutover

Phase 11 is the one approved synchronized exception to the normal expand/contract release path. It
is valid only while the recorded no-users, no-application-data, and no-active-client premise
remains true.

1. Freeze source and App configuration. Capture and validate the active predecessor, then apply
   `cutover-quiesced.contract.yaml` through the separately authorized dashboard change. The
   production domain continues serving the health-only entrypoint with no database, auth, email,
   model, or telemetry secret and no job.
2. From green protected `main`, dispatch `operation=cutover-stage`. The workflow accepts only an
   active quiesced predecessor, non-force fast-forwards `app-platform-production`, requests one
   deployment, and proves the candidate SHA is still running the quiesced topology.
3. Apply `cutover-initialize.contract.yaml`. Its temporary `PRE_DEPLOY` job receives exactly the
   two bootstrap database URLs, initialization document, and short-lived OpenRouter key, declares
   initialization schema `2`, runs migration `0009` and the unified initializer, and leaves the
   public service health-only. Do not reset or clean a non-empty database to satisfy `0009`.
4. Require one complete document-hash latch plus matching prompt and model-policy revision-1
   ledgers and heads. Revoke the initialization roles/key and remove the temporary job and
   variables.
5. Apply and validate `app.contract.yaml`, then run the normal protected `deploy` operation for the
   same candidate. Accept only exact service/job source hashes, migration completion, readiness,
   ledger integrity, and the authorized runtime revision.

Before step 3 commits, restore the quiesced predecessor contract. After `0009` or initialization
commits, rollback is forward-only: keep the App quiesced and prepare a compatible descendant
release; never move Git backward or reverse the database migration.

## Configuration changes

App Platform configuration changes can rebuild the source. Freeze deployments, confirm
`app-platform-production` points to the accepted commit, and record the active deployment before a
domain, maintenance, secret, size, or other authorized dashboard change. Afterward, rerun the
read-only live validator and require all component source hashes and public readiness to remain on
that commit. Never combine an unrelated configuration change with a release.

## Compatible forward rollback

Rollback is a new forward release:

1. Identify the last compatible accepted commit and prove it supports the current schema and
   database authority.
2. Create a normal reviewed `git revert` on `main`; do not move a pointer backward or force-push.
3. Let the new descendant commit pass every CI gate.
4. Deploy it through the normal workflow and current App configuration.
5. Re-run migration, readiness, source-identity, authentication, chat/Stop,
   settlement/reconciliation, and telemetry checks.

Rollback never reverses a database migration or crosses an incompatible schema. After a database
credential/authority change, source compatibility alone is insufficient.

## Recovery material

After every accepted production release, refresh the encrypted offline Git bundle containing
protected `main`, `app-platform-production`, and accepted release commits. Test that it can produce
the exact source tree without GitHub. The bundle contains no secret. Historical GHCR packages are
unused and are not recovery authority; their cleanup requires separate destructive authorization.
