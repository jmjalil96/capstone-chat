# Database and App recovery

PlanetScale PITR creates a new separately billed branch and never overwrites/deletes the source.
Backups run every 12 hours and are retained for 84 hours. Creating, connecting, cutting over to,
or deleting any branch/App/domain/egress pair requires immediate action-specific authorization.

Recovery authority is the exact accepted Git commit, source-controlled Dockerfile/contracts,
green CI evidence, encrypted offline Git bundle, Bitwarden source credentials, PlanetScale
backups/configuration, and company-owned DNS/provider access. Source rebuilds are not guaranteed
to be byte-identical. App Platform's filesystem and encrypted variables are not recovery sources.

Validate content-free evidence outside the repository with:

```sh
pnpm verify:recovery -- "replace-with-safe-evidence.json"
```

## Preflight

1. Confirm PS-5 ARM Single Node in `us-east-1`, 10/15 GB, no HA/replica, 12-hour backups,
   84-hour retention, and at least 72 continuously selectable hours after ageing.
2. Confirm separate application/migration/recovery roles, direct 5432, `verify-full`, and both
   current Dedicated Egress `/32`s. Recovery authority is absent from the App.
3. Record a non-sensitive marker boundary through the bounded recovery command.
4. Confirm the exact accepted commit exists in protected Git history and the offline bundle,
   Dockerfile/contracts are present, migrations are compatible, and Bitwarden/provider recovery
   works inside the four-hour controlled RTO.
5. Preserve the approved exception: accidental App deletion with an attached domain has a
   best-effort maximum 24-hour binding objective; controlled recovery remains four hours.

## Isolated PITR

1. Record UTC start, source database, restore point, source commit, migration, safe marker,
   maximum cost/lifetime, and cleanup authorization. Required RPO is at most 15 minutes.
2. Restore to a new isolated PlanetScale branch. Recreate extensions/settings/roles/IP rules,
   backups/storage policy, and `verify-full` URLs; restore does not imply them.
3. Use an authorized isolated recovery App or bounded environment. If using an App, start
   health-only to obtain a new egress pair, allowlist both `/32`s, then deliver temporary recovery
   credentials. Never open a general range.
4. Verify PostgreSQL version, migration ledger, search objects, constraints/indexes, `unaccent`,
   timeouts, connections, application DDL/admin denial, and forced reconnect after restriction.
   Content-free preparation must also prove every assistant-rule and model-policy head references
   its immutable ledger, every policy revision has exactly fast/balanced/pro tiers, and every
   generation references its captured policy revision and, where required, prompt revision.
5. Verify the schema-2 initialization latch and existing workspace/admin/model/prompt authority.
   Never provide the original initialization document/job/key/roles or send the first invitation.
6. Deploy the exact source commit with only steady service/migration variables. Require service/job
   `source_commit_hash`, migration, runtime revision, readiness, content-free integrity counts,
   authentication, reconciliation, and markers.
7. Measure at most 15-minute RPO and four-hour controlled RTO, then perform all authorized cleanup.

## Database-authority cutover

1. Freeze source/configuration changes and enable maintenance.
2. Make current instances unready, drain/cancel work, and prove zero active writes.
3. Revoke the old application role or IP authorization; force reconnection and prove old releases
   cannot write.
4. Prepare new application/migration roles restricted to both current egress `/32`s and install
   their encrypted component variables.
5. Deploy through the normal forward migration/readiness path and prove exactly one database
   authority receives writes.
6. Verify source/migration/latch/markers, auth, critical flow, accounting, and telemetry before
   ending maintenance. Retain the old source until divergence decisions are explicit.

Workspace behavior history is database authority, not rebuildable configuration. Never rewrite a
prompt or model-policy ledger row, repoint a head by hand, or substitute current policy for a
generation's captured revision. If restored heads or references fail integrity, keep the target
isolated and choose another restore point. Once migration `0009` has committed, recovery and
rollback candidates must be forward-compatible descendants; do not reverse the migration.

## Cold App recreation

1. Recover the exact commit from protected Git or the tested offline bundle. Create a health-only
   replacement App and allocate its new Dedicated Egress pair.
2. Recreate/rotate steady database roles, allowlist both new `/32`s, force new connections, and
   verify the initialized database before installing steady values.
3. Deploy service/job from the exact commit. Verify the completed latch and existing authority
   without initialization or invitation.
4. For controlled replacement, enable maintenance, detach the production domain from the old App,
   verify release, attach it to the ready replacement, smoke it, then seek separate deletion
   authorization. Never delete first.
5. Prove old credentials cannot write, measure RTO, accept safe evidence, then clean up only under
   explicit authority.
