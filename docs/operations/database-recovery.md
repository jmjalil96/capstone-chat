# Database and host recovery

PlanetScale PITR creates a new separately billed branch. This procedure never restores over or
deletes the source. Production schedules backups every 12 hours and retains them for 84 hours so at
least 72 continuously accessible hours remain after the schedule has aged. Creating, cutting over
to, or deleting recovery resources requires immediate action-specific authorization. The retention
window is an operating restore contract, not an undocumented claim about physical-media deletion.

Run marker commands from the exact deployed image through the audited migration/operator container;
it reads `/run/capstone-secrets/migration.json` and never prints or accepts a database URL on the
command line:

```sh
sudo /opt/capstone-chat/bin/request-operator.sh recovery-marker-create
sudo /opt/capstone-chat/bin/request-operator.sh recovery-marker-list
sudo /opt/capstone-chat/bin/request-operator.sh recovery-marker-delete
```

The create helper prompts for `pre` or `post`; deletion prompts for the marker UUID. These private
or mutable values never enter shell arguments.

After disposable recovery resources have been accepted and removed, validate the closed,
content-free evidence before storing it outside the repository:

```sh
pnpm verify:recovery -- "replace-with-safe-evidence.json"
```

The validator recomputes RPO/RTO, verifies release/migration/source/cleanup fields, and rejects
extra fields. It does not create or claim a provider restore.

## Backup and restore preflight

1. Confirm PlanetScale shows PostgreSQL 18.4, PS-5 ARM Single Node, AWS `us-east-1`, 10 GB initial
   storage, a 15 GB hard ceiling, backups every 12 hours retained 84 hours, and no replica/HA.
2. Record the oldest selectable PITR point across a backup-expiry rotation boundary. Do not claim
   three continuous days until the schedule has aged and remains at least 72 hours after an older
   backup expires.
3. Confirm the source database has a database-wide IP rule containing only the verified Droplet
   `/32`, separate application/migration roles, and the default provider role absent from runtime.
4. Confirm Bitwarden emergency retrieval and a fresh encrypted Volume can be recovered within the
   four-hour RTO. Record the deferred second-owner risk.

## Isolated rehearsal or incident restore

1. Record source branch, UTC incident/rehearsal start, full release/digest, migration, readiness, and
   non-sensitive pre/post marker boundary. The latest expected recovered marker must place observed
   RPO at or below 15 minutes.
2. Select an eligible restore point inside the aged window and request authorization for the exact
   new branch, expected prorated cost, lifetime, credential/IP boundaries, and cleanup.
3. Restore to a new PlanetScale branch in `us-east-1`. Keep the source untouched. Recreate
   `unaccent`, application/migration roles, database-wide `/32`, backup/storage settings, and
   `verify-full` URLs because they are not assumed to transfer with a restore.
4. During the separately authorized recovery-console root window, stage separate restored-branch
   application and migration `DATABASE_URL` documents under the root-only
   `/run/capstone-input` boundary, close the console, and run
   `sudo /opt/capstone-chat/bin/request-operator.sh recovery-prepare` from the trusted Droplet. The
   command receives both roles and rejects equal authority. Verify PostgreSQL version, migration
   ledger, generated search objects, constraints, indexes, extensions, statement and lock timeouts,
   and role denial before application validation; then remove both staged source files.
5. Attach only an isolated validation slot using fake model delivery and disabled email. Never
   contact OpenRouter or Resend. Validate content-free counts/status for workspaces, memberships,
   immutable conversation structure, drafts, search, compactions, generations, reservations,
   accounting, Better Auth, reconciliation, and the expected markers.
6. Exercise liveness/readiness, one dedicated recovery identity sign-in, one isolated fake
   read/write, and reconciliation. Measure RPO at most 15 minutes and elapsed RTO at most four hours.
7. If validation fails, keep production on the untouched source. Trying another point or changing
   provider resources requires renewed authorization.

## Real database-authority cutover

Ordinary blue/green deployment must never overlap two database authorities.

1. Acquire the deployment/recovery lock and enable the generic Caddy maintenance response for all
   employee traffic.
2. Mark every old-authority slot unready, cancel/drain active requests through the bounded shutdown
   contract, stop both slots, and prove no process, pool, or write remains connected to the source.
3. Atomically install the validated restored-branch runtime credential on the encrypted Volume while
   maintenance remains active.
4. Start exactly one slot on the restored branch. Verify release, migration, markers, readiness,
   critical fake-or-authorized smoke, and that every connection targets only the new branch.
5. Disable maintenance, run public critical smoke, and establish the accepted new-authority write
   window. Preserve the old source and both credential versions until independent cutover acceptance
   and an explicit data-divergence/rollback decision.

## Cold Droplet rebuild

Droplet snapshots and backups are not used. For the authorized rehearsal, create a new approved
NYC3 Droplet; for production host loss, create a new approved RIC1 Droplet. Attach an encrypted
1 GiB Volume, apply the committed secret-free host artifacts, recover only the
required files from Bitwarden, pull the exact protected GHCR digest, reassign the reserved IPv4,
restore its outbound route, reconnect to the untouched PlanetScale source, and reconcile the durable
active release. Verify firewall, Caddy, TLS, secrets, telemetry, readiness, database restrictions,
and critical flow within four hours. Remove the failed host/Volume only after evidence and secret
exposure review are accepted.

Delete any disposable validation slot/branch/role/IP rule only after evidence is accepted. Never
delete the source until a real cutover and its rollback/data-authority decision have been separately
accepted.
