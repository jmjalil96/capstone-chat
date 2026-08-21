# Deploy and rollback

The release authority is one full commit reachable from protected `main`. Both hosted environments
use the repository-local deployment action and independent App Platform source builds. A release is
accepted only when the migration succeeds, desired and active contracts match, both components
report the exact commit, no deployment remains in progress, and public readiness reports that
revision.

Protected pointers have no direct human writers, reject force pushes and deletion, and move only
forward. Their one-time creation belongs to provisioning; the routine workflows require them to
already exist. App Platform autodeploy and native rollback are disabled.

## One-time GitHub setup

1. Protect `app-platform-staging` and `app-platform-production` before creating them. Block force
   push and deletion, but allow merge commits because each pointer must accept the exact green
   `main` commit.
2. Create GitHub environments `staging` and `production`. Restrict production to `main`, require
   the owner as reviewer, and disable unreviewed bypass. Staging may run automatically from the
   `main` CI workflow.
3. In each environment store only its fixed `DIGITALOCEAN_APP_ID` and a dedicated
   `DIGITALOCEAN_DEPLOY_TOKEN`. Limit the token to the required App read/update and supporting
   read scopes; omit create, delete, console, database, registry, and account-wide write access.
   DigitalOcean grants those scopes at team level rather than App ID, so the fixed environment
   variable, source overlay, live contract, and workflow checks provide the target binding.
4. Under separate Git authorization, create each pointer once at a reviewed green commit and
   verify the remote SHA. No routine workflow has an absent-pointer mode.

## Staging deployment

Every `main` push runs quality/integration/build/container smoke and the full Playwright job. Only
after both jobs succeed, CI deploys that exact `github.sha` to the protected staging environment:

The staging deployment job is serialized and never cancels a running deployment. GitHub may
replace an older pending job with a newer pending `main` commit; that older workflow is not
staging-accepted and cannot be selected for production. The surviving job only advances the
pointer, so the newer commit includes every skipped ancestor.

1. Validate the current desired/active staging contract and current active component revision.
2. Prove the pointer and active release are ancestors of the candidate, non-force fast-forward
   `app-platform-staging`, and verify the remote SHA.
3. Ask App Platform for one source rebuild. Its only pre-deploy component runs migrations with the
   staging migration URL. A build or migration failure leaves the previous active deployment
   authoritative; do not request a second deployment while state is ambiguous.
4. Require the terminal deployment to be active, revalidate both component SHAs and the complete
   staging overlay, and require `https://staging.chat.capstone.com.ec/api/health/ready` to return
   `200`, `{"status":"ready"}`, and the exact revision header.
5. Exercise the accepted staging identity/chat/email/browser checks with synthetic data and only
   allowlisted recipients. Record safe evidence in the successful CI run.

## Production promotion

Production is manual and never infers a moving target:

1. Select one exact 40-character staging-accepted commit as `release_revision`.
2. The workflow proves the commit exists, is reachable from `main`, is strictly ahead of the
   production pointer, and has a successful completed `main` push run of `ci.yml`. Because staging
   is a required job in that workflow, a successful run is also exact staging evidence.
3. The protected `production` environment pauses for reviewer approval. Confirm the fixed App ID,
   current production contract/readiness, migration compatibility, database health/backups,
   Dedicated Egress, telemetry, and incident state before approval.
4. The shared action non-force fast-forwards `app-platform-production`, requests one source build,
   and follows the same migration, terminal-state, exact-contract, component-SHA, and readiness
   checks as staging. Production additionally requires exactly two assigned Dedicated Egress
   addresses and its fixed domain/size/credentials.
5. Record UTC time, commit, CI run, deployment ID, migration, readiness, duration, and safe resource
   peaks. Do not claim the staging and production builds are byte-identical.

The production overlay is strict: both components require
`CAPSTONE_ENVIRONMENT=production`, predecessor deployment sentinels are absent, and the migration
job receives only its migration `DATABASE_URL` plus non-secret deployment metadata.
API startup never applies migrations. Additive `0009`, schema-1 initialization, version-1
predecessor writes, and Phase 11 version-2 writes remain compatible. No migration `0010` exists or
is pending; a future compatibility-removal migration requires separate approval. There is no
quiesce, database copy/replacement, or deployment cutover step.

## Failure and forward revert

If a deployment stops in `ERROR`, `CANCELED`, or `SUPERSEDED`, preserve the previous active release,
freeze the pointer/configuration, and inspect the recorded deployment ID. Never reverse a migration,
move a pointer backward, force-push, use native rollback, or introduce startup migration.

Rollback is a normal descendant release:

1. Identify a compatible accepted source state and create a reviewed `git revert` on `main`.
2. Let the revert pass the entire CI workflow and staging deployment.
3. Promote that exact descendant through protected production approval.
4. Re-run migration, source/readiness identity, authentication, chat/Stop, settlement,
   reconciliation, email category, and telemetry checks.

Configuration changes can themselves rebuild source. Freeze releases, record the active deployment,
make one separately authorized change, then rerun the focused validator and public revision check.
Never combine an unrelated configuration change with a code release.
