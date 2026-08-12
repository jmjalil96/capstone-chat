# Deploy and rollback

The active release authority is the accepted full Git revision plus immutable GHCR digest recorded
by GitHub production Deployment evidence and confirmed by App Platform readiness. The fetched live
App spec is current configuration authority. Display names, mutable image tags, control-panel state,
and DigitalOcean's native rollback list are not competing authorities.

Every App-spec writer uses the protected `capstone-chat-production-app-spec` concurrency group with
`cancel-in-progress: false` and the mutation boundary documented in `deploy/app-platform/README.md`.
The DigitalOcean control panel is read-only for App configuration after acceptance.

## Normal forward deployment

1. Identify the full 40-character protected `main` HEAD, current accepted release, exact candidate
   GHCR digest, and immediately previous compatible accepted digest. The candidate must equal the
   current protected HEAD, differ from the active revision, and strictly descend from it. Require
   every named GitHub check and image-publication gate.
2. Verify the candidate image is AMD64, runs as UID 1000, contains the expected migrations and web
   assets, and has matching OCI label, runtime revision, and embedded web revision. Never deploy a
   mutable tag, an equal/old/divergent commit, or a dirty tree.
3. Confirm the migration is expand/contract compatible with the active and immediately previous
   web/API builds. Protect both digests in GHCR before mutation.
4. Inspect App Platform CPU/memory/restarts/requests/latency, deployment/job/domain state, the
   independent Uptime check, PlanetScale connections/locks/storage/backups, New Relic application
   signals, and the current absence of an in-progress deployment.
5. Fetch the complete live spec without printing it. Work only in a fresh mode-0600 temporary
   directory with tracing disabled and guaranteed cleanup. Verify the pinned App ID, active
   deployment, region `ric`, one service/job, sizes, instance count, health, termination, domain,
   edge settings, both dedicated egress addresses, and exact component secret-key sets. Preserve
   every provider-encrypted value byte-for-byte.
6. Resolve the candidate full-SHA GHCR tag to its immutable digest and render the source-controlled
   digest-free contract. Patch only the service and migration-job image digest. Both components must
   use the same artifact; `DEPLOYMENT_REVISION` remains image-owned and cannot be overridden.
7. Immediately before submission, re-resolve protected `main` and re-fetch the App/deployment/spec/
   egress fingerprint. Abort on any movement, drift, control-panel edit, or in-progress deployment.
8. Submit through the protected production deployment workflow. Its steady token is pinned to the
   recorded App ID and has only `app:update`, `app:read`, `regions:read`, `sizes:read`, and
   `actions:read`. It cannot create, delete, or open a console.
9. Observe the exact-digest `PRE_DEPLOY` migration job. It receives only the migration role, uses
   direct 5432 with `verify-full`, and exits nonzero on configuration or migration failure. A failed
   job must leave the current service authoritative; API startup never runs migrations.
10. Observe readiness-gated rolling replacement. The candidate must pass liveness, database/policy
    readiness, release identity, static/API smoke, and telemetry startup. App Platform allows 110
    seconds of edge drain before `SIGTERM` and 300 seconds for the application's bounded shutdown.
    A readiness failure must preserve the old release.
11. Fetch state again and prove the live spec equals the prior fingerprint plus only the reviewed
    digest patch, Dedicated Egress is unchanged, the expected deployment ID succeeded, and public
    readiness reports the candidate revision. Treat any unexpected difference as an incident.
12. Run the separately authorized credentialed smoke: origin/session, owned conversation, one
    permitted response, Stop and canonical partial recovery, administration authorization, email
    category, and content-free telemetry. Record only UTC times, deployment ID, revision, digest,
    migration, status, duration, safe counts, and resource peaks.

A DigitalOcean maintenance restart of the same digest is a platform lifecycle event, not a new
Capstone release. Evidence must distinguish it from an approved revision change.

## Compatible forward rollback

DigitalOcean's native rollback action is prohibited in production because it can restore stale App
configuration, encrypted variables, and a pre-egress spec. Retained deployment history is discovery
evidence only.

1. Identify the immediately previous compatible accepted revision/digest from GitHub release
   evidence. Confirm it supports the current expanded schema and current database authority. A
   migration reversal or PITR is not an application rollback shortcut.
2. Fetch and validate the **current** live spec and its complete fingerprint. Preserve current
   domain, egress pair, encrypted GHCR/runtime variables, health, termination, and alerts.
3. Invoke the reviewed `deploy/app-platform/rollback.mjs` path through the same protected
   environment and concurrency group. It may patch only the service/job digest to that one prior
   artifact; it may not select any arbitrary historical deployment.
4. Re-run the idempotent pre-deploy migration and readiness-gated replacement. Verify release,
   database readiness, authentication, chat/Stop, settlement/reconciliation, and telemetry.
5. Preserve the rejected candidate and content-free evidence until the incident closes. If the
   forward rollback fails, keep or enable the reviewed maintenance spec mutation and follow
   `incident-response.md`; never click native rollback.

Rollback never reverses a database migration or crosses an incompatible schema. After a database
authority change, every artifact bearing the old credential is non-rollbackable even if its code is
otherwise compatible.

## Bootstrap-history eviction

The successful health-only pre-egress deployment can omit Dedicated Egress; the initialization
deployment can retain revoked encrypted bootstrap values. Before installing steady deployment
authority, use only exact-final-spec same-digest deployments until neither is present among the ten
rollbackable successful deployments. Verify history structurally after every bounded attempt.

These `bootstrap-history-eviction` events are not accepted releases, do not change the spec, and do
not enter recent-release retention. A separately authorized disposable rehearsal must attempt the
unsafe historical rollback once and record whether the provider blocks it, preserves egress, or
releases/replaces the pair. Production proceeds only after the unsafe entries are proven absent.

## GHCR retention

The planner in `deploy/app-platform/ghcr-retention.py` is a separate protected two-step workflow,
serialized with deployment:

1. Fetch the complete bounded package inventory and protect the active-serving, desired-spec, and
   in-progress digest; the immediately previous compatible release; five recent distinct accepted
   releases; and every sealed recovery pin. Unknown, malformed, beyond-bound, or conflicting state
   is never deleted.
2. Produce a content-free dry-run plan and SHA-256 plan hash, then stop for human review.
3. A separate authorized delete invocation re-fetches App state, GitHub Deployment evidence,
   recovery pins, and GHCR inventory. It deletes only if the plan is byte-for-byte identical and the
   hash matches. Any authority drift aborts all deletion.

The package-delete credential is distinct from the App's read-only GHCR pull credential and is
never installed in DigitalOcean. Partial deletion and API errors remain visible safe evidence; they
never cause broader retry/deletion.
