# Database and App recovery

PlanetScale PITR creates a new separately billed branch. This procedure never restores over or
deletes the source. Production schedules backups every 12 hours and retains them for 84 hours so at
least 72 continuously accessible hours remain after the schedule has aged. Creating, connecting,
cutting over to, or deleting a branch/App/domain/egress pair requires immediate action-specific
authorization. The retention window is an operating restore contract, not a claim about physical
media deletion.

Recovery uses the exact current or immediately previous compatible GHCR digest, the non-secret App
contract, Bitwarden source credentials, PlanetScale backups/configuration evidence, and
company-controlled DNS/provider recovery. App Platform's ephemeral filesystem and provider-
encrypted variables are not recovery sources.

Validate completed content-free evidence outside the repository with:

```sh
pnpm verify:recovery -- "replace-with-safe-evidence.json"
```

The validator recomputes RPO/RTO and checks release, migration, source, authority, and cleanup
fields. It does not create or claim a provider restore.

## Backup and restore preflight

1. Confirm PlanetScale shows PS-5 ARM Single Node in AWS `us-east-1`, 10 GB initial storage, a
   hard 15 GB ceiling, no HA/replica, backups every 12 hours retained 84 hours, and an oldest
   selectable point at least 72 continuous hours old across an expiry boundary.
2. Confirm the source has distinct application and migration roles, direct port 5432,
   `sslmode=verify-full`, and both current App Platform Dedicated Egress addresses allowlisted as
   individual `/32`s. The default near-superuser and recovery role are absent from the App spec.
3. Record a non-sensitive pre/post recovery-marker boundary through the reviewed bounded recovery
   command. Private marker IDs arrive through standard input and never shell arguments.
4. Confirm exact current/previous GHCR digests, migration compatibility, Bitwarden emergency
   retrieval, protected recovery pins, DNS/provider ownership, and one separately authorized
   recovery environment can be recreated inside the four-hour controlled-recovery RTO.
5. Record the provider exception approved on August 12, 2026: accidental App deletion while its
   domain remains attached is best-effort with a maximum 24-hour domain-binding recovery objective.
   This does not amend the four-hour controlled-recovery RTO.

## Isolated PITR rehearsal or incident restore

1. Record UTC start, source branch, intended restore point, full release/digest, migration, safe
   marker boundary, maximum prorated cost/lifetime, and cleanup authorization. The latest expected
   recovered marker must keep observed RPO at or below 15 minutes.
2. Restore to a new isolated PlanetScale branch in `us-east-1`; keep the source untouched. Recreate
   extensions, settings, application/migration/recovery roles, exact per-role IP restrictions,
   backup/storage configuration, and `verify-full` URLs because restore does not imply them.
3. Use a separately authorized isolated recovery App or bounded operator environment. If an App is
   used, create the runtime-secret-free health bootstrap only to obtain a new App ID and Dedicated
   Egress pair; allowlist both new `/32`s before delivering the temporary recovery credentials.
   Never open PlanetScale to `0.0.0.0/0` or a provider-wide range.
4. Run the reviewed recovery-preparation operation with distinct restored-branch application and
   migration roles. Verify PostgreSQL version, migration ledger, generated search objects,
   constraints/indexes, `unaccent`, statement/lock/session timeouts, prepared-statement posture,
   connection limits, application DDL/admin denial, and forced reconnect after restriction change.
5. Verify the durable initialization latch is complete and matches the existing canonical
   workspace, administrator authority, and model policy. Recovery must not receive the original
   initialization document, add the temporary initialization job/key/roles, rewrite the latch, or
   send an initial invitation. A missing/incomplete/conflicting latch fails recovery for
   investigation; it does not become first initialization.
6. Deploy the exact digest with only steady service/migration variables and the normal
   `PRE_DEPLOY` job. Use fake/disabled providers where the authorized rehearsal boundary requires
   them. Validate content-free counts/status, immutable conversation integrity, drafts/search,
   compactions, generations, reservations/accounting, Better Auth, reconciliation, and markers.
7. Exercise readiness/liveness, one dedicated recovery identity, one isolated read/write,
   role denial, pool release, and reconciliation. Measure RPO at most 15 minutes and controlled RTO
   at most four hours. A second point or larger resource requires renewed authorization.

## Database-authority cutover

App Platform may overlap old and new containers, so a cutover must fence the old authority before
any new-authority write.

1. Serialize App-spec mutation and enable the reviewed edge maintenance posture so new employee
   traffic is rejected without changing the public origin.
2. Mark current instances unready, drain/cancel work through the bounded shutdown contract, and
   prove zero active generations and zero remaining source writes.
3. Revoke the old application role or remove its IP authorization. Force pool reconnection and
   prove old retained deployments fail readiness rather than writing.
4. Prepare the restored branch's steady application/migration roles and both current egress `/32`s.
   Install new component-scoped encrypted database variables without exposing them.
5. Deploy through the current-spec forward migration/readiness path. Prove exactly one database
   authority receives writes and the source remains untouched after the fence.
6. Verify release/migration/latch/markers, authentication, critical application flow, accounting,
   and telemetry before disabling maintenance. Mark every deployment containing old database
   authority non-rollbackable and retain the old source until cutover/divergence decisions are
   explicitly accepted.

## Cold App recreation

Preserve the App ID when possible. If a new App is required:

1. Use a short-lived provisioning token and health-only bootstrap contract to create the new App.
   Allocate its fresh Dedicated Egress pair; the old pair cannot be recovered or assumed.
2. Recreate/rotate steady database roles, allowlist both new `/32`s, force fresh connections, and
   verify the initialized source/restored branch before installing only steady component secrets.
3. Deploy the exact digest and `PRE_DEPLOY` migration job. Verify the completed latch and existing
   identity/policy/accounting without initialization or invitation.
4. Evict the new pre-egress bootstrap deployment from rollbackable history before installing the
   steady GitHub App ID/token and revoking provisioning authority.
5. For controlled replacement, enable maintenance, detach `chat.capstone.com.ec` from the old App,
   verify provider release, attach it to the ready replacement, complete smoke, and only then seek
   separate authorization to delete the old App. Never delete first.
6. Prove old credentials/deployments cannot write, measure end-to-end RTO, accept evidence, then
   remove disposable branch/App/domain/egress/roles only under explicit cleanup authorization.

If accidental deletion leaves the domain bound beyond four hours, classify it under the approved
24-hour exception rather than falsifying controlled-RTO evidence. Escalate to DigitalOcean support
while preserving database and credential authority. Exceeding 24 hours remains an RTO failure.
