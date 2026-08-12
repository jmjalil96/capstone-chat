# Provision and deploy

This is the active DigitalOcean App Platform source-build and PlanetScale procedure. It is not
authorization to create accounts/resources, spend, install credentials, mutate DNS, send email,
run inference, restore data, or deploy. Each external batch needs an immediate grant naming target,
region, maximum/prorated cost, data/credential boundary, lifetime, rollback, and cleanup.

## Prerequisites

- The exact protected `main` commit is reviewed and all CI checks pass, including the local
  production Docker build/smoke. Follow the one-time GitHub environment, token, branch-rule, and
  `prepare-source` setup in [Deploy and rollback](./deploy-and-rollback.md).
  `app-platform-production` accepts only non-force workflow updates. App Platform autodeploy and
  preview Apps are off.
- DigitalOcean's GitHub integration is limited to `jmjalil96/capstone-chat`. Record that the
  repository is already public and obtain explicit production acceptance of that state; public
  access is not a license grant.
- Two clean managed rehearsals pass on the exact final size with 20 signed-in employees, 40
  streams, unchanged latency/correctness gates, managed TLS, deployment failures, forward revert,
  egress, secret isolation, aged PITR, and cold recreation.
- Current provider sizes/regions/terms/costs are recorded. Feature-preview sizes require explicit
  production acceptance or replacement and re-rehearsal.
- The App Platform/Cloudflare privacy boundary, domain-deletion exception, company ownership/MFA,
  Bitwarden recovery, and revoked planning OpenRouter key are all current.

## First provisioning

Proceed in order. App Platform configuration changes can rebuild source, so keep the intended
release pointer fixed and verify the resulting component source commit after every stage.

1. **Freeze source.** Record protected `main` and green CI. For production, run the workflow's
   bounded `prepare-source` operation before the first App exists. For a separately authorized
   synthetic rehearsal, create or non-force fast-forward `app-platform-rehearsal` to that exact
   green commit, verify the remote value immediately, and never move it backward. Confirm the
   Dockerfile builds without a revision argument and CI proved non-root UID 1000, required files,
   migrations, health, and runtime revision injection.
2. **Confirm topology/cost.** Region `ric`; one 1-GiB service; one 512-MiB pre-deploy job; paid
   Dedicated Egress; PlanetScale PS-5 ARM Single Node in `us-east-1`; 10/15 GB; no HA, replica,
   autoscaling, scale-to-zero, second service, or worker.
3. **Create the health-only App.** Connect the appropriate release pointer and
   `apps/api/Dockerfile`, disable autodeploy, and use the bootstrap contract. The entrypoint is
   `egress-bootstrap`; no database, auth, email, model, telemetry, or runtime secret is present.
   Custom-domain-only edge settings remain absent. Validate the captured App read-only.
4. **Enable Dedicated Egress.** Wait for exactly two distinct stable assigned IPv4 addresses and
   record them safely. Prove they survive a harmless source redeployment.
5. **Create PlanetScale/roles.** Create `capstone_chat` with the approved backup/storage policy.
   Create distinct application, migration, recovery, initialization application/migration, and
   temporary load roles as required. Allowlist both egress addresses as separate `/32`s before
   delivering any URL. Use direct 5432 and `sslmode=verify-full`; never `0.0.0.0/0`.
6. **Attach the domain.** Follow [Domain and TLS](./domain-and-tls.md). Attach the exact primary
   hostname while the health-only service still returns 404 for product routes. Introduce edge
   cache/email-obfuscation/threat settings only with the custom domain.
7. **Run one-time initialization.** Temporarily add one source-built `PRE_DEPLOY` initialization
   job. Give it only distinct bootstrap database URLs, the short-lived catalog key where needed,
   and the schema-versioned initialization document (maximum 32 KiB). It receives no final role,
   Better Auth, Resend, or New Relic credential. Production uses
   `node apps/api/dist/entrypoint.js initialize`, `NODE_ENV=production`,
   `MODEL_GATEWAY=openrouter`, `CAPSTONE_INITIALIZATION_SCHEMA_VERSION=1`, and secrets
   `CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL`, `CAPSTONE_BOOTSTRAP_DATABASE_URL`,
   `OPENROUTER_API_KEY`, and `CAPSTONE_INITIALIZATION_DOCUMENT`. Rehearsal uses
   `node apps/api/dist/entrypoint.js initialize-rehearsal`, `NODE_ENV=test`, the managed-rehearsal
   profile, and the same two database/document secrets without an OpenRouter key. Both jobs use
   the appropriate release pointer, Dockerfile, 512-MiB size, runtime commit binding, deployment
   target, and platform secret source.
8. **Verify and remove initialization.** Require the ordered durable document-hash latch,
   idempotent exact repeat, conflict rejection before provider work, one workspace/admin approval,
   and no email. Remove the job/variables and revoke both roles/key before continuing. Prove replay
   cannot mutate authority.
9. **Stage the exact final contract once.** Under the separately authorized first-provisioning
   grant, use the App Platform dashboard to replace the bootstrap service configuration with
   `app.contract.yaml` (or `rehearsal.contract.yaml`) exactly: steady service command and health,
   liveness, termination, alerts, ingress, edge and environment declarations; exactly one
   `PRE_DEPLOY` migration job; and no other component. Service secrets use the application role,
   Better Auth, OpenRouter, Resend, and New Relic. The migration job receives only its separate
   `DATABASE_URL`; the recovery role is absent. All secrets are encrypted component-scoped
   `RUN_TIME` values, never build arguments. Keep the release pointer fixed. This dashboard save
   creates a provisional deployment because the protected workflow intentionally cannot mutate App
   configuration.
10. **Validate the provisional active deployment.** Observe its migration and readiness, capture
    the App response in an owner-only temporary file, and run the complete read-only `live` (or
    `rehearsal`) validator against the frozen source commit. It must prove both the desired App spec
    and `active_deployment.spec`, the active service/job source hashes, exact final topology,
    encrypted variable scope, domain/edge/egress, and no in-progress deployment. A desired/active
    mismatch fails closed. The provisional production deployment is not an accepted release and
    must not receive employee traffic or trigger the first invitation.
11. **Establish the protected production release.** Only after step 10 passes, run the protected
    production workflow. It validates the already-final App before moving the source pointer,
    requests a fresh deployment of the exact green commit, and revalidates the active contract and
    readiness. Require the same source commit for service/job, successful migration, exact
    domain/redirect/edge policy, unchanged egress, and health/drain/grace settings. This one-time
    dashboard transition is not a steady release path; every later code release uses the workflow.
12. **Send the first invitation.** Only after final readiness, use the bounded application-role
    command for the existing administrator approval. It cannot create/change authority and records
    no email or action URL.
13. **Complete launch gates.** Verify App Platform/PlanetScale/New Relic/Resend/Uptime signals,
    source identity, TLS/cookies/client address, application flows, long NDJSON/Stop/recovery,
    Ecuador/device/accessibility, privacy sampling, capacity, paid inference authorization, PITR,
    offline Git recovery, and final independent review.

## Managed rehearsal

A rehearsal requires a separate grant for one temporary `ric` App, Dedicated Egress, isolated
PlanetScale branch/database, temporary hostname, fake model, disabled/fake email, synthetic `.test`
identities, content-free telemetry, maximum spend/lifetime, and mandatory cleanup. Use
`app-platform-rehearsal`, never production source/credentials/data.

The rehearsal pointer is synthetic-only and is not advanced by the production workflow. Under the
rehearsal grant, the operator may create or non-force fast-forward it to the recorded green `main`
commit, must verify `git ls-remote` immediately, and must not bypass force-push/deletion rules. The
live validator still requires every rehearsal component to report that exact commit.

The external load generator receives only a temporary rehearsal auth secret and a dedicated
PlanetScale load role with provider-enforced 24-hour TTL and its one source IPv4 `/32`. Its URL
never enters an App variable. After testing, close its pool, revoke/delete the role immediately,
remove the `/32`, rotate/remove the auth secret, prove denial, and delete temporary resources under
cleanup authorization.

## Recovery is not initialization

Cold recreation against initialized data never receives the original initialization document,
job, roles, key, or invitation. It verifies the completed latch and existing authority, obtains a
new egress pair through a health-only App, restricts PlanetScale, and installs only steady values.
If any step fails, preserve the last known-good App/database authority. Do not silently resize,
remove egress, open PlanetScale, lower gates, add a service, or use native rollback.
