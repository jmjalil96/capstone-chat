# Deploy and rollback

The deploy authority is the root-owned atomic active-release symlink under
`/var/lib/capstone-chat/active`. Its immutable release directory records slot, loopback port, full
revision, image digest, and Caddy upstream. Caddy runtime state, Docker state, and systemd unit state
are observations, not competing authorities. Operators use
`/opt/capstone-chat/bin/request-deploy.sh`; only the supervised `capstone-deploy.service` may invoke
the internal `/opt/capstone-chat/bin/deploy.sh` state machine.

## Normal deployment

1. Identify the full 40-character candidate revision, exact GHCR digest, active release, and
   immediately previous compatible digest. Confirm GitHub Actions passed every required job for the
   candidate and CI recorded the same image label/digest. Never deploy a mutable tag or dirty tree.
2. Confirm the previous digest is protected in GHCR and understands the current expanded schema.
   Confirm the migration is forward-only and expand/contract compatible.
3. Inspect DigitalOcean/PlanetScale/New Relic headroom, the encrypted Volume's distinct block-device
   identity and exact size, anchor route and externally observed reserved outbound IP, database TLS/
   roles/restrictions, backup/storage policy, and host security-update state. The 1 GiB host must
   have enough measured capacity for temporary two-slot overlap; do not use swap. Before the first
   activation, the DNS-only `A` record and public Caddy certificate must already work against the
   generic maintenance response.
4. Submit the candidate through `request-deploy.sh`. It must validate revision/digest/CI evidence,
   acquire the global lock, reconcile current host state to the active symlink, and pull through the
   encrypted-Volume GHCR configuration. Do not run `deploy.sh` from an interactive shell.

   ```sh
   sudo /opt/capstone-chat/bin/request-deploy.sh deploy <full-revision> sha256:<digest>
   ```
5. The supervised deploy runs all forward migrations once in the short-lived non-root migration
   container using `/run/capstone-secrets/migration.json`. API startup never runs migrations.
6. Observe the inactive loopback slot start with the exact runtime restrictions. It must pass
   liveness, readiness, release/digest, migration, database, strict telemetry configuration,
   OpenRouter policy mode, and credential-free direct static/API/anonymous-session smoke before
   Caddy can receive its upstream.
7. Observe the Caddy Unix-socket switch while the durable symlink still names the old release. Public
   static/API/anonymous-session/revision smoke must show new requests reach the candidate. On
   failure, the supervised state machine reloads the old upstream and proves the candidate stopped
   cleanly without committing authority; if that proof fails it preserves container and release
   metadata for reconciliation.
8. Only after public verification may the deploy atomically replace and `fsync` the active symlink.
   It then drains the old slot: 5 seconds ordinary drain, up to 240 seconds for streams, 30 seconds
   forced cleanup, concurrent email/pool cleanup, and bounded telemetry flush within the tested
   shutdown envelope. Docker receives the full 300-second platform grace inside a 330-second
   application-unit bound. The state machine preserves the stopped container until systemd success,
   no OOM, and exit code zero are recorded in a memory-backed acknowledgement; a nonclean exit,
   timeout, or forced systemd kill fails activation. Boot recovery may direct-remove only an exact
   immutable-release container that Docker restored as non-running exit 137 or 255, after persisting
   content-free shutdown evidence; foreign or ambiguous container state fails closed.
9. As the named `adm` operator, collect only the bounded final activation record and copy that one
   content-free line into the authorized external change record. Its UTC `activatedAt`, full
   revision, and digest must match the candidate; release `createdAt` is pre-activation metadata.

   ```sh
   journalctl --unit=capstone-deploy.service --lines=1 --no-pager --output=cat \
     --grep='^capstone-deploy: activation-evidence schema=1 '
   ```
10. Treat the helper's result as “activation complete; credentialed acceptance pending.” Through a
   separately authorized operator session, smoke release identity, sign-in/session, recent
   conversations, one fake rehearsal or separately authorized short live stream, Stop/canonical
   partial recovery, administration authorization, and identity delivery. No deploy credential,
   test-only production route, or authentication bypass is allowed. Record content-free evidence;
   the release remains unaccepted until this gate passes.
11. Run the read-only host verifier and record UTC start/end, revision/digest, old/new slot,
    migration, switch/drain result, smoke result, resource peaks, and safe error counts.

    ```sh
    sudo /opt/capstone-chat/bin/verify-host.sh
    ```

If the deploy process or host fails before the symlink commit, boot/failure reconciliation must
restore traffic to the old release. After commit it must restore the candidate. Never edit the
symlink, Caddy upstream, Docker containers, or systemd slots manually to "finish" a partial deploy.

## Compatible rollback

1. Confirm the immediately previous protected digest understands the current expanded schema. If
   not, stop; migration reversal and PITR are not application rollback shortcuts.
2. Submit that exact previous revision/digest through the same `request-deploy.sh` path. The same
   migration preflight, inactive-slot readiness, Caddy verification, atomic authority commit, and
   bounded drain rules apply.

   ```sh
   sudo /opt/capstone-chat/bin/request-deploy.sh rollback
   ```
3. Collect the rollback's exact final activation record through the same bounded `journalctl`
   command used for deployment. Confirm its UTC `activatedAt`, full previous revision, and digest,
   then copy only that line into the authorized external change record.
4. Verify release/digest, database readiness, authentication, critical chat/cancellation,
   settlement/reconciliation, and telemetry. Preserve the rejected candidate and evidence until the
   incident is closed.
5. If rollback fails, enable the generic maintenance response through the deployment-locked path,
   preserve both releases and database authority, and follow [incident response](./incident-response.md).

   ```sh
   sudo /opt/capstone-chat/bin/request-deploy.sh maintenance-on
   ```

   Disable maintenance only after the complete critical smoke passes:

   ```sh
   sudo /opt/capstone-chat/bin/request-deploy.sh maintenance-off
   ```

## Host patch and reboot

Drain through the same application boundary before a planned reboot. After reboot,
`capstone-boot.service` must mount/verify the encrypted Volume, restore reserved outbound routing,
read the active symlink, start exactly that slot, load its Caddy upstream, and recover Fluent Bit and
DigitalOcean Monitoring in dependency order. Verify there is no stale second slot, public app/admin
port, core dump, root-disk secret/log cache, or unexpected PlanetScale source address before ending
maintenance.
