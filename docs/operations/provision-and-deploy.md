# Provision and deploy

This procedure creates the approved provisional production topology. It is not authorization to
create accounts/resources, spend money, install credentials, mutate DNS, run inference, or deploy.
Each external batch requires immediate confirmation of its target, maximum/prorated cost, data and
credential boundary, rollback, and cleanup. The separately authorized NYC3 rehearsal follows the
isolated path below; its steps must never be merged into the production order by substitution.

## Authorized NYC3 managed-rehearsal order

This path is disposable and non-production. Actual provider usage is capped at USD 5 excluding
temporary card holds and taxes. It uses no production data, Resend/OpenRouter credential, paid
inference, final production DNS, or production identity. Stop if an action would cross that boundary.

1. **Freeze the rehearsal revision.** Commit the NYC3 test-mode exception, require green GitHub
   Actions, record the full revision and immutable GHCR digest, and independently confirm no P1/P2.
2. **Create only the approved host shell.** In NYC3 create the USD 6 Basic one-vCPU/one-GiB Ubuntu
   24.04 Droplet with the rendered secret-free cloud-init, assigned reserved IPv4, existing exact
   Cloud Firewall, disabled public IPv6, and one encrypted 1 GiB Volume. Attach no backup or larger
   tier. Record the live estimate and deletion path before submission.
3. **Install the secret-free host baseline.** Apply the verified `deploy/digitalocean/` artifacts.
   Render `host.env` with the temporary rehearsal host/origin, `CAPSTONE_NODE_ENV=test`,
   `CAPSTONE_EMAIL_DELIVERY=disabled`, `CAPSTONE_MODEL_GATEWAY=fake`, and
   `CAPSTONE_EXPECTED_REGION=nyc3`. Keep the exact Caddy client-address boundary, one-GiB Volume,
   640 MiB application containment, loopback slots, and package pins.
4. **Establish the fixed database source.** Configure and reboot-test the reserved-IP outbound route.
   Create only the disposable PS-5 ARM Single Node cluster in `us-east-1`, with 10 GB initial/15 GB
   maximum storage, 12-hour backups retained 84 hours, and one database-wide rule for the observed
   reserved `/32`. Create separate disposable application and migration roles and prove their
   allow/deny boundaries with `verify-full` TLS.
5. **Install rehearsal-only credentials.** The runtime file contains only the generated test
   `BETTER_AUTH_SECRET`, application `DATABASE_URL`, and dedicated content-free rehearsal
   `OTEL_EXPORTER_OTLP_HEADERS`; the migration file contains only its separate `DATABASE_URL`.
   Install the GHCR and dedicated rehearsal New Relic credentials in their normal isolated Volume
   paths. Do not create or install Resend or OpenRouter credentials.
6. **Establish only the temporary origin.** Point the approved temporary rehearsal hostname at the
   reserved IPv4, start Caddy in maintenance, and prove public TLS, headers, redirect, proxy
   identity, and maintenance behavior. Do not change `chat.capstone.com.ec`.
7. **Initialize the empty test authority in dependency order.** With no active release, first run
   `sudo /opt/capstone-chat/bin/request-operator.sh identity-bootstrap <revision> <digest>` using the
   rehearsal workspace and a reserved `.test` administrator address. This applies migrations and
   creates only the synthetic pending workspace approval without sending mail. Then run
   `sudo /opt/capstone-chat/bin/request-operator.sh model-policy-initialize <revision> <digest>` for
   that same workspace. It creates only the simulated USD 100, 4,096/8,192/16,384,
   concurrency-two policy and accepts no privacy document or provider key. Both commands validate
   the same CI-approved immutable image, and neither creates active release authority.
8. **Activate through the normal deploy state machine.** Run
   `sudo /opt/capstone-chat/bin/request-deploy.sh deploy <revision> <digest>` and require the same
   migration, static/API/session, public TLS, activation, drain, rollback, reboot, and host checks as
   production. `WEB_ASSETS=production-build` serves the embedded SPA without changing test providers.
9. **Keep identity synthetic.** Confirm the initialization left only the pending `.test` approval:
   no password, user, account, session, invitation, or real address. The isolated load harness seeds
   its own synthetic users and sessions directly in the disposable database.
10. **Run the accepted qualification matrix.** Follow the managed capacity, deploy/failure, and
    recovery sections of the active amendment twice from clean database state. The load target must
    be the compiled test-only load server with its explicit confirmation and diagnostics fences, and
    the load generator must remain off the candidate host. Do not expose a production test route or
    relabel NYC3 results as RIC1 evidence. The exact managed load-server invocation still requires a
    source-controlled review before this step executes; stop here if it has not landed.
11. **Exercise isolated recovery.** The rehearsal operator permits only recovery marker CRUD and
    `recovery-prepare` in addition to the two initialization commands above. Use a separate restored
    branch and disposable roles; preserve the source, prove RPO/RTO and role/TLS boundaries, then
    remove the restored branch after evidence is accepted.
12. **Clean up deliberately.** After evidence capture, remove temporary DNS, roles/rules, restored
    branches, database, Uptime check, Volume, reserved IPv4, and Droplet. Confirm billing stopped and
    no rehearsal credential, image exception, or firewall attachment became production authority.

The rehearsal operator rejects approval/deactivation, real catalog/attestation/bootstrap, GHCR
retention mutation, and every unknown operation. Production mode retains the complete production
operator surface and remains bound to RIC1, Resend, and OpenRouter.

## Production prerequisites

- The exact repository implementation is committed, GitHub Actions is green, all ordinary/focused
  gates pass, and an independent review has no unresolved P1/P2.
- The managed NYC3 USD 6 Droplet/PS-5 rehearsal has passed twice from clean state with 20 employees,
  40 streams, and response-start p95 at or below 500 ms, plus deploy, rollback, reboot, cold rebuild,
  observability privacy, and aged PITR evidence. Local Render Standard/Starter results are historical
  regression evidence only.
- The Capstone Bitwarden Teams `Production` collection exists under a company-controlled owner with
  MFA and a sealed offline recovery kit. The second recovery owner is deferred and recorded as a
  launch risk. Emergency retrieval and a fresh-Volume restore have met the four-hour RTO.
- The operator controls company-owned DigitalOcean, PlanetScale, GitHub/GHCR, DNS, Resend, New Relic,
  OpenRouter, and administrator-mailbox accounts with MFA/recovery and billing alerts.
- The compromised planning OpenRouter key is revoked. Every production credential is newly issued
  or deliberately retained and recorded; none is pasted into this repository, task, shell history,
  cloud-init, command arguments, or evidence.
- The live estimate confirms USD 6 Droplet, USD 5 PS-5, USD 0.10 Volume, and USD 4 one-owner
  Bitwarden Teams monthly equivalent: USD 15.10 operational base. The 15 GB database ceiling raises
  that to approximately USD 15.73 before tax, backup/WAL/network overage, temporary resources, and
  model use.

## Production provisioning order

1. **Freeze release identity.** Confirm the full commit and protected GHCR digest match source,
   browser build, OCI labels, CI smoke, and candidate evidence. Protect the candidate and immediately
   previous compatible digest. Record the GHCR package policy and any deployment-identity seat cost;
   stop if it changes the accepted estimate.
2. **Prepare provider ownership.** Confirm DigitalOcean team/account and PlanetScale organization
   ownership, billing alerts, MFA/recovery, RIC1 and AWS `us-east-1` availability, provider terms,
   and a content-free external change record. No resource tier may differ from the approved plan.
3. **Create the network/host shell.** Create one RIC1 USD 6 Basic shared-CPU Droplet (one vCPU,
   1 GiB), one assigned reserved IPv4, one encrypted 1 GiB Volume, the exact Cloud Firewall, and one
   HTTPS readiness Uptime check. Publish no DNS yet. Confirm public IPv6 is disabled and SSH is
   restricted to the approved operator `/32`.
4. **Install the secret-free host baseline.** For this exact batch, authorize and open a
   time-bounded DigitalOcean recovery-console root session; public root SSH remains disabled. Apply
   the reviewed Ubuntu 24.04 artifacts from `deploy/digitalocean/`; pin/record package sources and
   versions. Close the root console when the batch finishes. Verify the named non-root SSH operator
   is outside the `sudo`/`docker` groups and can sudo only the three audited root-owned request/
   verification paths, plus UFW, unattended security updates, time sync, no swap,
   host/unit/container core-dump denial, systemd sandboxing, Docker, Caddy, Fluent Bit, boot/deploy
   units, and loopback-only application ports. Run
   `bash deploy/digitalocean/verify-artifacts.sh` from the verified secret-free artifact copy before
   installation, then check package versions, UFW, users/groups, mounts, listeners, swap, IPv6,
   time sync, and enable the exact Fluent Bit, Caddy, and boot units without starting them. Do not
   use `enable --now`. Do not run the full `verify-host.sh` yet: by design it
   requires installed secrets, one active release/container, public TLS readiness, and provider
   connectivity, so its first valid place in this sequence is after step 13.

   ```sh
   systemctl enable capstone-fluent-bit.service capstone-caddy.service capstone-boot.service
   ```
5. **Make the reserved address authoritative.** Configure the persistent outbound reserved-IP route
   and prove it survives reboot. Record only the expected address needed for the PlanetScale rule.
6. **Create PlanetScale.** Create PostgreSQL 18.4 PS-5 ARM Single Node in `us-east-1`, initial
   10 GB storage, autoscaling enabled with a hard 15 GB ceiling, no replica/HA, backups every 12
   hours retained 84 hours, and one database-wide IP rule containing only the Droplet `/32`.
7. **Create database roles.** Rotate the default near-superuser credential into Bitwarden only.
   Create separate least-privilege application and migration roles; test application DDL/admin
   denial and migration success. All URLs use direct port 5432 and `sslmode=verify-full`; never
   weaken CA/hostname verification or add an operator-laptop IP.
8. **Install encrypted secrets.** Populate separate Bitwarden items and root-owned files beneath
   `/srv/capstone-secure` for runtime, migration, GHCR, Fluent Bit/New Relic, and Caddy state. Mount
   only `/run/capstone-secrets/runtime.json` or `migration.json` into the relevant non-root
   container. Prove cross-read denial and scan cloud-init, root disk, image, units, Docker inspection,
   process arguments, logs, and telemetry for absence.
   Reset failure state and start only `capstone-fluent-bit.service`; prove it is active and bounded.
   Caddy and boot reconciliation remain stopped.

   ```sh
   systemctl reset-failed capstone-fluent-bit.service
   systemctl start capstone-fluent-bit.service
   systemctl is-active --quiet capstone-fluent-bit.service
   ```
9. **Configure telemetry.** Enable DigitalOcean Monitoring and alerts. Create dedicated New Relic
   production OTLP and Log API credentials, safe service/release labels, ingest warning, dashboard,
   and notification channel. Validate the unprivileged bounded Fluent Bit HTTPS path with no disk or
   Docker dual-log cache. Confirm PlanetScale's protected database metrics/backups/Query Insights
   remain in PlanetScale rather than New Relic.
10. **Prepare production providers.** Verify the Resend `mail.capstone.com.ec` domain, exact sender,
    send-only key, and tracking disabled. Create the new OpenRouter key in the dedicated private
    workspace and verify ZDR/data-collection settings. Install credentials through Bitwarden and the
    runtime secret file; do not run paid inference yet.
11. **Publish DNS and establish TLS in maintenance.** Create the one DNS-only `A` record for
    `chat.capstone.com.ec` at the reserved IPv4; create no `AAAA`, proxy, CDN, or tunnel. Start Caddy
    with no active release so it serves only the generic maintenance response, obtains the public
    certificate, and passes redirect, hostname, chain, HSTS, security-header, admin-socket, and
    certificate-renewal checks. Do not use `tls internal`, an alternate hostname, or a temporary
    configuration. Reset failure state, start `capstone-caddy.service`, prove public TLS and the
    maintenance response, and only then start `capstone-boot.service`. Keep the application
    unavailable during this step.

    ```sh
    systemctl reset-failed capstone-caddy.service capstone-boot.service
    systemctl start capstone-caddy.service
    systemctl is-active --quiet capstone-caddy.service
    systemctl start capstone-boot.service
    ```
12. **Initialize identity, schema, and policy before the first release.** First bootstrap the real
    workspace/admin through the exact protected candidate. Then stage the current privacy
    attestation under `/run/capstone-input` and initialize policy for that same workspace:

    ```sh
    sudo /opt/capstone-chat/bin/request-operator.sh identity-bootstrap <full-revision> sha256:<digest>
    sudo /opt/capstone-chat/bin/request-operator.sh model-policy-initialize <full-revision> sha256:<digest>
    ```

    Both commands must reject any existing active symlink, validate exact CI evidence and OCI
    identity, verify the secure Volume's distinct block device/size/restrictions, and run every
    committed migration with the migration-only credential. Identity bootstrap creates the
    workspace before policy references it and sends the invitation through the verified sender;
    do not follow the link while Caddy remains in maintenance. Policy initialization then creates
    the exact three model mappings, USD 100 budget, 4,096/8,192/16,384 output ceilings, concurrency
    two, 20% margin, and privacy attestation with that same image. Verify the migration ledger,
    extensions, objects, role denial, timeouts, and prepared-statement posture. Catalog metadata
    access is not paid inference. Remove the staged attestation afterward; neither command creates
    an active release.
13. **Activate the first release through public TLS.** Submit the protected digest with
    `sudo /opt/capstone-chat/bin/request-deploy.sh deploy <full-revision> sha256:<digest>`. Confirm
    the idempotent migration preflight, inactive-slot readiness, direct and public credential-free
    static/API/anonymous-session/revision smoke, exact release identity, active-symlink authority,
    clean bounded stop evidence, Caddy routing, bounded logs, and host verification. The helper must
    report activation complete and credentialed acceptance pending; do not call the release accepted
    yet. From the named operator's `adm` journal access, collect the bounded final activation record:

    ```sh
    journalctl --unit=capstone-deploy.service --lines=1 --no-pager --output=cat \
      --grep='^capstone-deploy: activation-evidence schema=1 '
    ```

    Copy only the one exact final line beginning `capstone-deploy: activation-evidence schema=1`
    into the authorized external change record. Confirm its UTC `activatedAt`, full revision, and
    digest match the submitted candidate. Do not copy broader journal output, and do not treat the
    release metadata's pre-activation `createdAt` as activation evidence.
14. **Complete administrator activation.** Confirm the pre-activation invitation used the verified
    sender and final origin, then complete fragment-based verification and sign-in only after the
    release is active. If bootstrap must be retried after activation, use the no-image form so the
    operator runs through active release authority.
15. **Complete the separately authorized credentialed acceptance smoke.** Verify custom-origin
    sign-in/session, onboarding/reset, ownership isolation, complete chat and administration
    behavior, three tier labels without raw models, NDJSON and Stop/partial recovery, heartbeat/
    watchdog, mid-use revocation, frozen-interruption recovery, telemetry privacy, disconnect and
    long-stream reload/switch behavior, and infrastructure headroom. This gate uses no authentication
    bypass or production test route. Paid three-tier OpenRouter smoke remains a fresh explicit
    authorization; the release remains unaccepted until the resulting content-free evidence is
    recorded.
16. **Record and stop before launch claim.** Record exact resources, prices, revision/digest,
    migration, roles/restrictions, backup/storage policy, alerts, smoke, remaining device/Ecuador/
    accessibility/paid-inference/recovery gates, and the deferred second owner. Do not call the
    system production-ready until every Phase 8 launch checklist item is accepted.

If any step fails, preserve the last known-good application/database authority, remove only
explicitly disposable resources after evidence is accepted, and return the measured cause. Do not
silently resize, enable HA, relax a firewall/TLS/privacy rule, change providers, lower the workload,
or weaken an acceptance threshold.
