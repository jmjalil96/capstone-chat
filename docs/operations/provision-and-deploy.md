# Provision and deploy

This is the active DigitalOcean App Platform and PlanetScale procedure. It is not authorization to
create accounts or resources, spend money, install credentials, mutate DNS, send email, run
inference, restore data, or deploy. Each external batch requires an immediate grant naming the
target, region, maximum/prorated cost, data and credential boundary, lifetime, rollback, and
cleanup. The raw-Droplet procedure is historical and must not be substituted.

## Production prerequisites

- The exact repository revision is committed, every required GitHub check is green, the production
  AMD64 GHCR image is published by CI, and an independent review has no unresolved P1/P2.
- A separately authorized disposable App Platform/PlanetScale rehearsal passed twice from clean
  state with 20 signed-in employees, 40 streams, every unchanged latency/correctness gate, real
  managed TLS/streaming, deployment failures, forward rollback, two-address egress, secrets, and
  aged PITR recovery. Historical Render and Droplet results are regression evidence only.
- Current DigitalOcean and PlanetScale contracts, region/size availability, Dedicated Egress,
  Uptime allowance, pooled transfer, backup/WAL/storage costs, and the USD 44–45 operational base
  are recorded. A changed price or resource slug stops provisioning for review.
- The owner has accepted the App Platform/Cloudflare plaintext-processing boundary after reviewing
  current DPA, subprocessors, processing/support regions, request/edge logging and retention,
  employee access, deletion, breach, and incident terms.
- The owner has either verified a provider-supported way to release an accidentally deleted App's
  attached custom domain inside four hours or explicitly amended the RTO for that failure mode.
  Planned detach-before-delete evidence does not close this accidental-deletion gate.
- The dedicated DigitalOcean team contains no unrelated App. Company-owned DigitalOcean,
  PlanetScale, GitHub/GHCR, DNS, New Relic, Resend, OpenRouter, Bitwarden, and administrator-mailbox
  accounts have MFA, recovery, billing alerts, and the intended minimum operators.
- Bitwarden `Production` remains the recoverable credential source. One company-controlled owner and
  the sealed offline kit are verified; the deferred second owner remains an explicit launch risk.
- The compromised planning OpenRouter key is revoked. No production secret appears in Git, a task,
  shell history, a command argument, a local environment dump, or evidence.

## Empty-database first provisioning

Follow the exact renderer and mutation syntax in `deploy/app-platform/README.md`. Contracts are
digest-free and contain no secret values. Every App-spec writer uses the protected non-cancelling
`capstone-chat-production-app-spec` concurrency group and the shared live-fingerprint mutation
boundary.

1. **Freeze release authority.** Record the protected `main` full revision and its immutable GHCR
   digest. Confirm OCI revision label, embedded web revision, non-root UID 1000, runtime files,
   migrations, CI evidence, and AMD64 platform all agree. Protect the candidate, immediately
   previous compatible digest, five recent accepted releases, and recovery pins.
2. **Recheck providers and ownership.** Confirm App Platform managed region `ric`,
   `apps-s-1vcpu-1gb-fixed`, one instance, the 512 MiB job size, Dedicated Egress price, PlanetScale
   PS-5 ARM Single Node in AWS `us-east-1`, 10 GB initial/15 GB ceiling, no HA/replica, and current
   terms. Record the dedicated team, project, planned App identity, and cost without credentials.
3. **Create only the health-only bootstrap App.** Use `bootstrap.contract.yaml`, the exact digest,
   and a short-lived provisioning token without delete or console scope. Submit the first private
   GHCR read credential only through the protected input boundary and only to
   `image.registry_credentials`; immediately fetch and verify DigitalOcean's encrypted
   representation. The bootstrap entrypoint receives no database, auth, email, model, telemetry,
   or runtime secret and returns only fixed health responses plus 404 for every product route.

   ```sh
   export CAPSTONE_TOOL_REVISION="$CAPSTONE_IMAGE_REVISION"
   CAPSTONE_REGISTRY_INPUT_FILE="$work_directory/registry.json" \
     node deploy/app-platform/provision.mjs create-bootstrap
   ```
4. **Enable and freeze Dedicated Egress.** Enable `egress.type: DEDICATED_IP`; record both assigned
   exclusive IPv4 addresses separately and verify they persist across a harmless deployment. Every
   subsequent spec update must preserve the pair. Never enable VPC integration or continue with
   changing/default egress.
   Set the returned App ID and active deployment ID, then run
   `node deploy/app-platform/provision.mjs advance bootstrap egress`. Preserve the returned sorted
   pair in `CAPSTONE_EXPECTED_EGRESS_IPV4S` for every later stage and refresh
   `CAPSTONE_PROVISIONING_BASE_DEPLOYMENT_ID` after each accepted transition. A stale base prevents
   a blind retry; an already-applied target is accepted only as its immediate successor.
5. **Create PlanetScale and roles.** Create PostgreSQL PS-5 Single Node in `us-east-1`, database
   `capstone_chat`, 10 GB initial storage, hard 15 GB ceiling, backups every 12 hours retained 84
   hours, and no HA/replica. Create distinct steady application and migration roles plus distinct
   short-lived initialization application/migration roles. Allowlist both egress addresses as
   individual `/32`s for each applicable role before delivering any database credential. Use
   direct port 5432 and `sslmode=verify-full`; prove runtime DDL/admin denial, migration authority,
   reconnect behavior, extensions, timeouts, connection limits, and unrelated-source denial.
6. **Preflight and attach the domain in maintenance.** Follow `domain-and-tls.md`: recheck
   authoritative DNSSEC and CAA, attach exactly `chat.capstone.com.ec` as `PRIMARY` with TLS 1.2,
   publish the DNS-only CNAME to the current provider target, preserve the fetched `DEFAULT` domain,
   and verify its HTTPS 308 redirect. Product routes must still return the bootstrap 404. Do not
   install runtime secrets or send an invitation yet.
7. **Run the one-time initialization deployment.** Add only the temporary
   `initialization.contract.yaml` job using the exact digest and its separately encrypted,
   initialization-only variables: two distinct bootstrap database URLs, one short-lived catalog
   key, and one schema-versioned canonical initialization document of at most 32 KiB UTF-8. It
   receives no final database role, Better Auth secret, Resend key, or New Relic credential.
8. **Verify ordered, latched initialization.** The job runs migration, creates/checks the durable
   document-hash latch before provider work, bootstraps database-only workspace/administrator
   authority, closes its pool, validates catalog metadata, and commits model policy. Verify each
   recorded phase, exact-repeat idempotency, conflict rejection before provider work, one canonical
   workspace/administrator approval, and no email. Output and evidence remain content-free.
9. **Remove initialization authority.** Remove the temporary job and all initialization-only
   variables from the live spec. Revoke both temporary database roles and the temporary OpenRouter
   key. Confirm the completed latch and canonical state, and prove an attempted historical replay
   cannot mutate them. Provider-retained encrypted history is not a recoverable secret source.
10. **Install only steady component secrets.** The service receives the application database role,
    Better Auth, OpenRouter, Resend, and New Relic values. The `PRE_DEPLOY` job receives only its
    separate migration `DATABASE_URL`. The recovery role is absent. Preserve the encrypted GHCR
    credential independently on every image-bearing component and verify no plaintext value is
    returned or logged.
11. **Deploy the final candidate.** Render `app.contract.yaml` with the exact revision/digest and
    current encrypted live values. Require one `apps-s-1vcpu-1gb-fixed` service, one
    `apps-s-1vcpu-0.5gb` `PRE_DEPLOY` job, port 3000, readiness/liveness, 110-second edge drain,
    300-second post-`SIGTERM` grace, exact domain/redirect, disabled edge cache/email obfuscation,
    and unchanged Dedicated Egress. Migration failure must block replacement; readiness failure
    must leave the bootstrap release serving.
12. **Evict unsafe history.** Re-deploy the unchanged exact final spec through the provider's
    supported create-deployment action until neither the pre-egress bootstrap nor initialization
    deployment appears among the ten rollbackable successful deployments. Label these events
    `bootstrap-history-eviction`; they are not new releases. The live validator must fail until the
    history is safe.
13. **Install steady deployment authority last.** Only after history eviction, install the pinned
    App ID and long-lived token with exactly `app:update`, `app:read`, `regions:read`, `sizes:read`,
    and `actions:read` in the protected GitHub production environment. Revoke the provisioning
    token. It has no create, delete, or console permission.
14. **Send the initial invitation after readiness.** From one verified ready service instance, use
    the bounded application-role invitation command for the existing administrator approval. Its
    input arrives through standard input, it cannot create/change authority, and it records only a
    content-free sent/retry-safe outcome. Verify delivery before the administrator follows the
    production-origin link.
15. **Complete telemetry and provider gates.** Verify App Platform Insights/alerts, deployment/job/
    domain notifications, one independent DigitalOcean Uptime check, PlanetScale alerts/backups/
    Query Insights, New Relic OTLP and bounded direct logs, and telemetry-outage behavior. No
    telemetry failure may block product requests after valid startup.
16. **Run production acceptance and stop.** Verify exact release identity, TLS/origin/cookies,
    client-address spoof/omission resistance, identity, complete application behavior, long NDJSON,
    heartbeat/watchdog, Stop/recovery, Ecuador/device/accessibility, privacy sampling, and capacity.
    Paid three-tier inference, real email, PITR, and launch acceptance remain separately authorized.

## Recovery is not initialization

Cold recreation against an initialized source or restored branch never receives the original
initialization document, never adds the temporary initialization job or its roles/key, never
rewrites the latch, and never sends an initial administrator invitation. It verifies the completed
latch, existing administrator authority and policy, then uses a health-only bootstrap solely to
obtain a new App ID and egress pair before installing steady credentials. A missing, incomplete, or
conflicting latch fails recovery; it does not convert recovery into first provisioning.

## Disposable managed rehearsal

A rehearsal requires its own grant naming one temporary `ric` App, Dedicated Egress, one temporary
PS-5 database/branch, a temporary hostname, exact digest, fake model, disabled/fake email, synthetic
`.test` identities, content-free telemetry, maximum spend/lifetime, and mandatory cleanup. Exercise
first initialization, egress, role/TLS boundaries, GHCR rotation/retention, unsafe-history replay
and eviction, two full load passes, five-minute streaming, deploy failures, forward rollback,
secret rotation, aged PITR, and controlled cold recreation. Production DNS, credentials, data,
Resend, OpenRouter inference, and administrator identity are prohibited.

The external generator receives one temporary rehearsal-only authentication secret equal to the
rehearsal service's `BETTER_AUTH_SECRET`, exposed to the generator as
`CAPSTONE_LOAD_AUTH_SECRET`, solely so the bounded harness can forge synthetic `.test` sessions.
It never receives a production or reusable identity secret. Immediately before the bounded load
window, create a dedicated PlanetScale load-operator role with only the table operations required
by the source-controlled fixture, inspection, and reconciliation queries and a provider-enforced
24-hour TTL. Restrict that role to the one named generator IPv4 `/32`; never place its URL in an App
spec or component environment. Before issuance, preserve denial from the generator. During the
window, prove success from that generator and denial from an unrelated source.

Cleanup is a rehearsal gate, not best effort. First terminate the generator, erase its temporary
auth-secret environment, and force-close its
database pool because removing a CIDR affects only new connections. Then explicitly revoke/delete
the role without relying on TTL expiry, remove the generator `/32`, remove/rotate the rehearsal
service auth secret as part of rehearsal teardown, and prove connection denial again. A failure in
any cleanup or post-cleanup denial check fails the rehearsal and remains a prominent unresolved
item until independently corrected.

## Retiring the historical Droplet rehearsal

Deleting the existing disposable Droplet, Volume, reserved IP, firewall, tag, root-password item,
or recovery-console access is a separate destructive action. After authorization, first prove that
no authoritative data or production credential was installed, lock root access, close the console,
detach every temporary domain, delete resources in the provider-safe order, revoke temporary
credentials, and verify zero continuing charge. The historical amendment and Git history remain;
the host is not kept as a production fallback.

If any step fails, preserve the last known-good App and database authority. Do not silently resize,
enable HA, remove Dedicated Egress, open PlanetScale, lower workload or latency gates, add a second
service, or use native rollback.
