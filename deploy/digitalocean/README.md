# DigitalOcean host contract

These files implement the approved single-Droplet boundary. They are deliberately not a general
infrastructure framework: one host, two transient application slots, one active-release authority,
one maintenance mode, and one bounded log path.

No file in this directory contains a credential. Do not place a rendered secret, Docker
authentication document, database URL, telemetry key, SSH private key, or TLS private state in the
repository, cloud-init user data, command arguments, or the Droplet root disk.

## Fixed paths and identities

| Purpose | Installed path | Owner and mode |
|---|---|---|
| Host contract | `/etc/capstone-chat/host.env` | `root:root` `0640` |
| Caddy configuration | `/etc/capstone-chat/Caddyfile` | `root:root` `0644` |
| Maintenance route | `/etc/capstone-chat/maintenance.caddy` | `root:root` `0644` |
| Fluent Bit configuration | `/etc/capstone-chat/fluent-bit.conf` | `root:root` `0644` |
| Fluent Bit JSON parser | `/etc/capstone-chat/fluent-bit-parsers.conf` | `root:root` `0644` |
| Root deployment programs | `/opt/capstone-chat/bin/{deploy,cleanup-migrations,operator,request-*,verify-host}.sh` | `root:root` `0750` |
| Fluent Bit data launcher | `/opt/capstone-chat/bin/start-fluent-bit.sh` | `root:capstone-fluent-bit-secrets` `0550` |
| Operator entrypoint | `/opt/capstone-chat/lib/operator-entrypoint.mjs` | `root:root` `0644` |
| GHCR retention program | `/opt/capstone-chat/lib/ghcr-retention.py` | `root:root` `0750` |
| This operator reference | `/opt/capstone-chat/README.md` | `root:root` `0644` |
| systemd units | `/etc/systemd/system/capstone-*.service` | `root:root` `0644` |
| Release state and evidence | `/var/lib/capstone-chat` | `root:root` `0750` |
| Runtime state | `/run/capstone-chat` | `root:root` `0700` |
| Caddy admin/runtime state | `/run/capstone-caddy` | `caddy:capstone-caddy-secrets` `0750` |
| Fluent Bit input | `/run/capstone-fluent-bit/docker.sock` | service-created Unix socket |
| Encrypted Volume mount | `/srv/capstone-secure` | separate DigitalOcean Volume, `nodev,nosuid,noexec` |

The service identities are `caddy` UID `21010`/GID `21003` and `capstone-fluent-bit` UID
`21011`/GID `21004`. Containers remain UID/GID `1000:1000`; the application receives supplemental
GID `21001` and a migration receives supplemental GID `21002`. `capstone-operator` is never added
to the `docker` group.

The encrypted Volume contains only:

```text
/srv/capstone-secure/
  runtime/runtime.json             root:21001 0440
  migration/migration.json         root:21002 0440
  registry/config.json             root:root  0400
  caddy/                            caddy:21003, private writable state
  fluent-bit/new-relic.env          root:21004 0440
```

`runtime.json` is mounted into the application only as `/run/capstone-secrets/runtime.json` and
selected through `CAPSTONE_SECRET_FILE`. It contains exactly `BETTER_AUTH_SECRET`, `DATABASE_URL`,
`OPENROUTER_API_KEY`, `OTEL_EXPORTER_OTLP_HEADERS`, and `RESEND_API_KEY`; the telemetry value is the
single `api-key=…` header and never the non-secret endpoint. `migration.json` contains only
`DATABASE_URL`, is mounted only into the short-lived migration container, and uses the same loader
interface. The application container is never given the migration, registry, Caddy, or Fluent Bit
paths. The reviewed host contract supplies the non-secret New Relic endpoint
`https://otlp.nr-data.net` separately.

## First boot

1. Render `cloud-init.yaml` exactly once with the operator's public SSH key and exact public IPv4
   `/32`. Reject the result if any `__PLACEHOLDER__` remains. Record its SHA-256; the rendered copy
   is provisioning evidence, not a repository file.
2. Create the Ubuntu 24.04 LTS RIC1 Droplet with public IPv6 disabled, attach the reserved IPv4,
   apply the matching DigitalOcean Cloud Firewall, and attach the 1 GiB encrypted Volume named
   `capstone-secure`. Cloud-init configures only baseline Ubuntu packages; it intentionally does not
   install a moving Docker, Caddy, or Fluent Bit version.
3. Format a new empty Volume as ext4. Mount it by filesystem UUID at `/srv/capstone-secure` with
   `defaults,nodev,nosuid,noexec` in `/etc/fstab`. Never format a Volume that contains recovery
   material. `findmnt --target /srv/capstone-secure` must show a source different from `/` before
   any secret is installed.
4. Select the current reviewed vendor repositories and exact package versions for Docker Engine,
   Caddy, and Fluent Bit. Cloud-init masks `caddy.service`, `caddy-api.service`, and
   `fluent-bit.service` before those packages exist, so a vendor default cannot claim public ports
   or forward logs during installation. Install with `package=EXACT_VERSION`, retain those masks,
   hold the packages, remove any package-added `caddy` membership in `www-data`, and write the
   command outputs below into the content-free host evidence:

   ```text
   docker version --format '{{.Server.Version}}'
   caddy version | awk '{ print $1 }'
   /opt/fluent-bit/bin/fluent-bit --version | awk 'NR == 1 { print $3 }'
   ```

   Remove the membership that Caddy's package may add, without changing its fixed primary group:

   ```sh
   gpasswd --delete caddy www-data 2>/dev/null || true
   ```

   `id -G caddy` must then print only `21003`; `id -G capstone-fluent-bit` must print only `21004`.
   Put the exact version strings in the three `CAPSTONE_EXPECTED_*_VERSION` fields in the rendered
   `host.env`. This avoids claiming unreviewed future package versions while still making version
   drift fail closed. Monthly patching chooses and records a new exact version before installation,
   rechecks the masks and private group memberships afterward, and never delegates these three
   services to unattended upgrades.
5. Replace every remaining `host.env` placeholder with the accepted reserved IPv4, operator `/32`,
   lowercase GHCR owner, and reviewed versions. Production keeps all other committed values,
   including `CAPSTONE_OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net`, exact. The managed
   rehearsal may change only its documented non-production host/origin/provider values.

An assigned reserved IPv4 does not automatically become the Droplet's outbound source. From the
DigitalOcean recovery console, follow the provider's Ubuntu 20.04+ reserved-outbound procedure:

1. Read the anchor gateway from
   `http://169.254.169.254/metadata/v1/interfaces/public/0/anchor_ipv4/gateway`.
2. Save the original `/etc/netplan/50-cloud-init.yaml` checksum in content-free evidence and add
   `/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg` containing exactly
   `network: {config: disabled}`.
3. In `/etc/netplan/50-cloud-init.yaml`, change only the existing `0.0.0.0/0` route's `via` value to
   that anchor gateway. Preserve the generated addresses, interface MAC, MTU, nameservers, private
   interface, and every unrelated field.
4. Run `netplan generate`, apply from the provider console, and verify that
   `curl -4 https://icanhazip.com/` equals `CAPSTONE_EXPECTED_OUTBOUND_IPV4`.
5. Reboot twice and repeat the route, external-IP, SSH `/32`, Caddy, and PlanetScale connection
   checks. Restore the recorded original Netplan through the provider console if either reboot
   loses connectivity.

Every deploy and rollback checks both that the live default gateway equals current DigitalOcean
anchor metadata and that `https://icanhazip.com/` observes the exact reserved IPv4. The host verifier
repeats both checks. PlanetScale's database-wide `/32` remains the authoritative fail-closed proof
for database access.

Cloud-init does not grant general sudo. The named SSH account is outside the `sudo` and `docker`
groups and may run only the installed root-owned `request-deploy.sh`, `request-operator.sh`, and
argument-free `verify-host.sh` paths through the exact `/etc/sudoers.d/60-capstone-operator` rule.
It can never invoke Docker, systemctl, a shell, or `deploy.sh` directly.

Initial package pinning, artifact installation, encrypted-Volume setup, and secret installation use
a separately authorized, time-bounded DigitalOcean recovery-console root session while public root
SSH remains disabled. Open that console only for the named provisioning batch, record content-free
start/end times and actions, run `visudo --check`, finish host verification, then close the console.
Later patching, artifact replacement, secret rotation, or deep recovery repeats that explicit
console authorization; broad or permanent passwordless root is never an escape hatch.

## Artifact installation

From a verified copy of this directory on the host, install it as root:

```sh
install -d -o root -g root -m 0755 /etc/capstone-chat /opt/capstone-chat/bin /opt/capstone-chat/lib
install -d -o root -g root -m 0750 /var/lib/capstone-chat /var/lib/capstone-chat/releases /var/lib/capstone-chat/ci-evidence /var/lib/capstone-chat/recovery-pins /var/lib/capstone-chat/shutdown-failures
install -o root -g root -m 0640 host.env /etc/capstone-chat/host.env
install -o root -g root -m 0644 Caddyfile maintenance.caddy fluent-bit.conf fluent-bit-parsers.conf /etc/capstone-chat/
install -o root -g root -m 0750 cleanup-migrations.sh deploy.sh operator.sh request-deploy.sh request-lifecycle.sh request-operator.sh verify-host.sh /opt/capstone-chat/bin/
install -o root -g capstone-fluent-bit-secrets -m 0550 start-fluent-bit.sh /opt/capstone-chat/bin/start-fluent-bit.sh
install -o root -g root -m 0644 operator-entrypoint.mjs /opt/capstone-chat/lib/operator-entrypoint.mjs
install -o root -g root -m 0750 ghcr-retention.py /opt/capstone-chat/lib/ghcr-retention.py
install -o root -g root -m 0644 README.md /opt/capstone-chat/README.md
install -o root -g root -m 0644 capstone-caddy.service capstone-chat@.service capstone-boot.service capstone-deploy.service capstone-fluent-bit.service capstone-operator.service /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify \
  /etc/systemd/system/capstone-caddy.service \
  /etc/systemd/system/capstone-fluent-bit.service \
  /etc/systemd/system/capstone-chat@.service \
  /etc/systemd/system/capstone-boot.service \
  /etc/systemd/system/capstone-deploy.service \
  /etc/systemd/system/capstone-operator.service
systemctl enable capstone-fluent-bit.service capstone-caddy.service capstone-boot.service
```

Enabling records the boot dependencies only. Do not start any Capstone unit in this artifact batch:
the Fluent Bit secret, public DNS/TLS, and durable release authority do not exist yet.

Create the Volume directories without crossing credential boundaries:

```sh
install -d -o root -g root -m 0711 /srv/capstone-secure
install -d -o root -g capstone-runtime-secrets -m 0750 /srv/capstone-secure/runtime
install -d -o root -g capstone-migration-secrets -m 0750 /srv/capstone-secure/migration
install -d -o root -g root -m 0700 /srv/capstone-secure/registry
install -d -o caddy -g capstone-caddy-secrets -m 0700 /srv/capstone-secure/caddy
install -d -o root -g capstone-fluent-bit-secrets -m 0750 /srv/capstone-secure/fluent-bit
```

Retrieve source credentials from the approved Capstone Bitwarden organization into a protected
memory-backed staging file under `/run`, install them atomically with the modes above, and remove
the staging file. Never type values into a command argument or persist a rendered file under
`/root`, `/home`, `/tmp`, `/etc`, the repository, or the journal. `new-relic.env` contains exactly
one `NEW_RELIC_LICENSE_KEY=...` assignment. Create the GHCR configuration through a password-stdin
login whose `DOCKER_CONFIG` is `/srv/capstone-secure/registry`; then change `config.json` to `0400`.
systemd never parses the New Relic file as an environment file: the group-executable `0550`
launcher validates one bounded safe-character assignment, exports only that value as data, and
executes the Noble package binary at `/opt/fluent-bit/bin/fluent-bit`.

Confirm the distribution proxy and log units remain masked. Validate the exact binaries and then,
after the Fluent Bit secret is installed, start only the log boundary:

```sh
install -d -o caddy -g capstone-caddy-secrets -m 0750 /run/capstone-caddy
install -o root -g capstone-caddy-secrets -m 0640 /etc/capstone-chat/maintenance.caddy /run/capstone-caddy/upstream.caddy
install -d -o capstone-fluent-bit -g capstone-fluent-bit-secrets -m 0750 /run/capstone-fluent-bit
runuser -u caddy -- env \
  CAPSTONE_PUBLIC_HOST=chat.capstone.com.ec \
  XDG_DATA_HOME=/srv/capstone-secure/caddy/data \
  XDG_CONFIG_HOME=/srv/capstone-secure/caddy/config \
  caddy validate --config /etc/capstone-chat/Caddyfile --adapter caddyfile
runuser -u capstone-fluent-bit -- env \
  NEW_RELIC_LICENSE_KEY=validation-placeholder \
  /opt/fluent-bit/bin/fluent-bit --dry-run --config /etc/capstone-chat/fluent-bit.conf
for unit in caddy.service caddy-api.service fluent-bit.service; do test "$(systemctl is-enabled "$unit" 2>/dev/null || true)" = masked; done
systemctl reset-failed capstone-fluent-bit.service
systemctl start capstone-fluent-bit.service
systemctl is-active --quiet capstone-fluent-bit.service
```

Caddy reads the fsynced active-release authority before every start; a first boot, explicit
maintenance marker, or missing authority serves only the generic maintenance response. Its admin API is a Unix socket under
`/run/capstone-caddy`; no TCP port 2019 exists. Caddy access logging, compression, response
buffering, a negative `flush_interval`, and a synthesized stream `Content-Length` are absent. The
generated upstream fragment removes every public forwarding claim and supplies only
`X-Capstone-Client-IP` from Caddy's direct remote peer.

Keep Caddy and boot reconciliation stopped until the DNS-only `A` record names the reserved IPv4.
With no active symlink present, start Caddy first so it obtains public TLS while serving only the
generic maintenance route, then start boot reconciliation:

```sh
systemctl reset-failed capstone-caddy.service capstone-boot.service
systemctl start capstone-caddy.service
systemctl is-active --quiet capstone-caddy.service
systemctl start capstone-boot.service
```

## CI evidence and deployment

The operator verifies the exact revision's GitHub Actions result and immutable GHCR digest outside
the host. Fill `ci-evidence.example.json` with non-secret values, validate that
`previousCompatible` is true, and install it as:

```text
/var/lib/capstone-chat/ci-evidence/<full-lowercase-revision>.json
root:root 0440
```

The evidence file is not an authentication mechanism; it is the local, auditable record of the
required human check. Root authority can always replace it, which is why operator identity, GitHub
MFA, and the external UTC change record remain part of the launch evidence. Installing each new
evidence document is a named, time-bounded recovery-console root action; close that console before
using the routine deployment helper.

The first production activation requires the DNS-only `A` record to already name the reserved IPv4
and Caddy to have obtained and served the public certificate while its upstream remains the generic
maintenance response. Do not use an internal certificate, alternate hostname, or temporary Caddy
configuration to make the first deploy pass.

Request a deploy only with non-secret immutable identifiers:

```sh
sudo /opt/capstone-chat/bin/request-deploy.sh deploy <40-character-revision> sha256:<64-hex-digest>
```

The helper writes one root-only request and starts `capstone-deploy.service`. `deploy.sh` refuses an
interactive or unsupervised invocation. The unit acquires one lock, reconciles to
`/var/lib/capstone-chat/active`, proves the secure mount has a different block-device `MAJ:MIN` from
the root filesystem and the exact one-GiB size, checks secrets/reserved source/CI evidence, pulls
and verifies the digest, runs forward migrations with the separate credential, starts the inactive
loopback slot, and runs credential-free direct and public static/API/anonymous-session/revision
smoke. It then fsyncs the new active symlink and gives the previous slot its bounded 340-second stop.
The old container is not auto-removed: the state machine requires a successful systemd stop, exit
code zero, no OOM, and an explicit memory-backed acknowledgement before removal. A nonclean exit,
timeout, or forced systemd kill fails activation. On reboot, reconciliation may remove only an
exact immutable-release container stopped with Docker's power-loss sentinel 137 or 255, after
persisting content-free evidence under `/var/lib/capstone-chat/shutdown-failures`; every foreign
identity fails closed. A unit failure first
restores durable Caddy/runtime authority and only then removes an uncommitted candidate; if
restoration fails, it preserves the candidate for the 900-second boot reconciliation.

The application container is non-root with a read-only root filesystem, 32 MiB `noexec` tmpfs,
all capabilities dropped, `no-new-privileges`, 256 PIDs, 640 MiB memory and memory+swap, core size
zero, no restart policy, and host networking with an exact `127.0.0.1:3001` or `:3002` bind. Docker
uses only the bounded Fluentd Unix path. Async queue exhaustion or ten failed delivery attempts
drops telemetry rather than blocking the application or writing a dual-log cache to root disk.
Fluent Bit rejects raw records above 16 KiB, discards the Docker envelope after JSON parsing, and
applies an exact `record_modifier` allowlist before HTTPS output. Prompt/response text, email,
cookies, authorization, raw URLs/queries/provider bodies, database URLs, and every other unlisted
field cannot reach New Relic even if an application log accidentally includes them.

## Supervised operator commands

Administrative and recovery commands use the active release's exact immutable image, never host
`pnpm`, an unpacked checkout, or a mutable tag. The sole pre-activation exception is
`model-policy-initialize`: only while no active symlink exists, it validates and pulls the requested
full revision/digest against exact CI evidence, runs forward migrations with the migration-only
secret, and bootstraps policy with that same image. Invoke only the interactive request helper; it
collects private values through `/dev/tty`, writes one root-only request under `/run`, and starts the
bounded `capstone-operator.service` oneshot:

```sh
sudo /opt/capstone-chat/bin/request-operator.sh identity-bootstrap
sudo /opt/capstone-chat/bin/request-operator.sh identity-approve
sudo /opt/capstone-chat/bin/request-operator.sh identity-deactivate
sudo /opt/capstone-chat/bin/request-operator.sh model-catalog-refresh
sudo /opt/capstone-chat/bin/request-operator.sh model-policy-initialize <40-character-revision> sha256:<64-hex-digest>
sudo /opt/capstone-chat/bin/request-operator.sh model-policy-bootstrap
sudo /opt/capstone-chat/bin/request-operator.sh model-policy-attest
sudo /opt/capstone-chat/bin/request-operator.sh recovery-marker-create
sudo /opt/capstone-chat/bin/request-operator.sh recovery-marker-list
sudo /opt/capstone-chat/bin/request-operator.sh recovery-marker-delete
```

The initialization command is the only supported first-database path: it is retry-safe, rejects an
active release, mutable target, unverified digest, or extra migration-secret key, and creates no
release authority. A normal deploy reruns the same forward migrations idempotently before startup.
The helper maps each operation to the compiled `apps/api/dist/entrypoint.js` allowlist. Production
model bootstrap fixes OpenRouter mode, USD 100, 4,096/8,192/16,384 output limits, concurrency two,
and the 20% reservation margin; it performs catalog metadata access but no generation. Identity and
model operations never receive the application database role. The root supervisor constructs one
operation-specific `0440` secret under memory-backed `/run`: the migration/operator `DATABASE_URL`
plus only `BETTER_AUTH_SECRET` and `RESEND_API_KEY` for identity, only `OPENROUTER_API_KEY` for
catalog refresh/bootstrap, and no runtime key for privacy re-attestation. The container receives it
with migration GID `21002`; the source runtime and migration documents are never mounted together
or exposed through Docker arguments, inspection, or logs. Recovery markers and every other
migration-secret consumer validate that `migration.json` contains exactly `DATABASE_URL`
immediately before mounting it.
Every container is non-root, read-only, capability-free, `no-new-privileges`, 128-PID/384-MiB
bounded, core-disabled, log-driver `none`, and gives each container command a nine-minute bound
inside the operator unit's 1,800-second end-to-end envelope. Requests and
private input values never appear in Docker arguments, inspection, or the journal. Safe command
outcomes do; review the terminal before retaining any transcript.

Privacy attestations and restored-branch credentials must first exist only in the memory-backed
root staging directory. Do not put them in the repository, `/tmp`, a home directory, or a shell
argument. Create and populate this root-only staging boundary during a separately authorized,
time-bounded recovery-console session, then close the console before invoking the operator helper:

```sh
install -d -o root -g root -m 0700 /run/capstone-input
# Retrieve into /run/capstone-input through the approved secret workflow, then:
chown root:root /run/capstone-input/<file>.json
chmod 0400 /run/capstone-input/<file>.json
```

The attestation operations prompt for one staged JSON path. `recovery-prepare` prompts for two
separate staged documents, each containing exactly one restored-branch `DATABASE_URL`: an
application-role URL and a migration-role URL. It mounts both only for the compiled preparation
command and never substitutes production runtime/migration credentials. Run it as:

```sh
sudo /opt/capstone-chat/bin/request-operator.sh recovery-prepare
```

The composite operator secret and all copied request/input files are removed on success, failure,
timeout, or unit cleanup. The operator unit and deployment unit share
`/var/lib/capstone-chat/deploy.lock`, so administrative, recovery-preparation, migration,
activation, rollback, and maintenance work cannot overlap. Remove each source under
`/run/capstone-input` immediately after the supervised command; the unit removes its own request
copies even on failure.

Rollback is only to the previous release recorded by the current immutable metadata and never
reverses a migration:

```sh
sudo /opt/capstone-chat/bin/request-deploy.sh rollback
```

Do not run `docker image prune` or delete a release directory manually. After accepted evidence is
recorded, invoke the bounded local cleanup:

```sh
sudo /opt/capstone-chat/bin/request-deploy.sh prune
```

It retains the five newest accepted releases, the active and immediately previous releases, and
every revision represented by a root-owned `0440` file in
`/var/lib/capstone-chat/recovery-pins/`. It refuses to delete a running revision, deletes only a
validated immutable release path, and removes an OCI digest only after its release metadata is no
longer authoritative.

Local pruning does not delete GHCR package versions. The persistent deployment PAT remains
`read:packages` only. For a deliberate remote cleanup, create a separate short-lived classic PAT
with only `read:packages` and `delete:packages`, stage no copy on disk, and run the content-free dry
run through the protected prompt:

```sh
sudo /opt/capstone-chat/bin/request-operator.sh ghcr-retention-plan
sudo /opt/capstone-chat/bin/request-operator.sh ghcr-retention-show
```

The plan intersects current GHCR inventory with exact accepted CI evidence, keeps the five newest
accepted digests still present remotely, and additionally protects active, immediately previous,
and every recovery-pinned digest. Unknown or manually published versions are reported and left
untouched. The plan request prints the exact content-free candidate IDs, digests, tags, and SHA-256.
Run `ghcr-retention-show` again to review the same root-owned plan without gaining file or root
access, record that printed SHA-256, then invoke the separately explicit deletion and enter that
exact hash:

```sh
sudo /opt/capstone-chat/bin/request-operator.sh ghcr-retention-delete
```

Deletion refetches GHCR and recomputes all local protections; any drift, plan older than one hour,
hash mismatch, unexpected inventory shape, or inventory above 1,000 versions fails closed. Revoke
the short-lived deletion PAT after the result is accepted. Never add `delete:packages` to the
encrypted persistent pull credential. The committed API scope is `users` for the current personal
package owner; moving the repository/package to an organization requires an explicit host-contract
change to `orgs` and a repeated dry run.

## Maintenance and database-authority cutover

Maintenance is not an ordinary deployment tool:

```sh
sudo /opt/capstone-chat/bin/request-deploy.sh maintenance-on
sudo /opt/capstone-chat/bin/request-deploy.sh maintenance-off
```

`maintenance-on` first fsyncs a durable marker, switches Caddy to a generic uncached 503 with
`Retry-After`, and then stops both slots through the full bounded application shutdown. Boot and
failure reconciliation preserve maintenance while the marker exists. After an independently
validated restored-database credential is atomically installed, `maintenance-off` starts exactly
the durable active release, proves readiness, fsyncs removal of the marker, and only then restores
public traffic. The source database and both externally escrowed credential generations remain
preserved until the separate recovery decision.

## Read-only verification

Run after install, deploy, reboot, patch, rollback, or recovery:

```sh
sudo /opt/capstone-chat/bin/verify-host.sh
```

It reads metadata but never secret contents. It checks the candidate OS/CPU/RAM class, restricted
Volume with a distinct block-device identity and exact size, no swap/IPv6/core dumps, accounts and
firewall, reserved outbound source,
an exact TCP-listener allowlist (public SSH/HTTP/HTTPS, one loopback application slot, and Ubuntu's
two loopback `systemd-resolved` stubs only), all-state application/migration container inventory,
file boundaries, exact package pins, Caddy/Fluent Bit boundaries, one active release,
container labels/restrictions/logging, and readiness through the custom-origin TLS path. DigitalOcean
Cloud Firewall, provider-side Volume encryption, reserved-IP reassignment, Monitoring/Uptime,
PlanetScale `/32`/roles/backups, external DNS, and New Relic receipt require separate provider
evidence; this host script does not pretend to verify them.

Before production acceptance, kill the supervised deploy at every migration/start/reload/public
verification/symlink/drain boundary and power-cycle before and after the symlink commit. In every
case `capstone-boot.service` must choose only the fsynced authority, retain canonical partial
responses, and expose neither application port nor a stale candidate.
