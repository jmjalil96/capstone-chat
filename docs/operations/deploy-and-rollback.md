# Deploy and rollback

## Normal deployment

1. Identify the candidate and immediately previous revision. Confirm CI passed on the candidate.
2. Confirm every migration is expand/contract compatible with the previous application revision.
3. Let Render's pre-deploy command run migrations; never run them during application startup.
4. Observe the old instance enter draining: readiness becomes unavailable, new work stops, and active
   streams have up to four minutes to finish before bounded cancellation preserves partial output.
5. Confirm the new instance reports the candidate `RENDER_GIT_COMMIT`, readiness, database access,
   and safe telemetry before sending ordinary traffic.
6. Smoke sign-in, session, recent conversations, one fake rehearsal stream or authorized short live
   stream, cancellation, administration authorization, and identity delivery as appropriate.
7. Record UTC start/end, revisions, migration, drain result, smoke result, and safe error counts.

## Compatible rollback

1. Confirm the previous artifact understands the current expanded schema. If not, stop; rollback is
   not safe and database recovery is not a shortcut.
2. Select the immediately previous successful Render deploy. Do not reverse migrations in place.
3. Observe the same readiness/drain boundary during rollback.
4. Verify the previous release, database readiness, authentication, critical chat flow, settlement,
   and telemetry.
5. If rollback fails, enable maintenance mode, preserve both revisions and the database, and follow
   [incident response](./incident-response.md).

Never delete the newer artifact or database evidence until the incident is closed.
