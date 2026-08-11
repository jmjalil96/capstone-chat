#!/usr/bin/env bash
set -euo pipefail

readonly ARTIFACT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

fail() {
  printf 'DigitalOcean artifact verification failed: %s\n' "$1" >&2
  exit 1
}

for script in cleanup-migrations.sh deploy.sh deploy-state-machine.test.sh fluent-bit-secret.test.sh migration-cleanup.test.sh operator.sh operator-secret.test.sh request-deploy.sh request-lifecycle.sh request-lifecycle.test.sh request-operator.sh start-fluent-bit.sh verify-host.sh verify-host-negative.test.sh verify-artifacts.sh; do
  bash -n "${ARTIFACT_ROOT}/${script}"
done
bash "${ARTIFACT_ROOT}/deploy-state-machine.test.sh"
bash "${ARTIFACT_ROOT}/fluent-bit-secret.test.sh"
bash "${ARTIFACT_ROOT}/migration-cleanup.test.sh"
bash "${ARTIFACT_ROOT}/operator-secret.test.sh"
bash "${ARTIFACT_ROOT}/request-lifecycle.test.sh"
bash "${ARTIFACT_ROOT}/verify-host-negative.test.sh"
python3 - "${ARTIFACT_ROOT}/ghcr-retention.py" "${ARTIFACT_ROOT}/ghcr-retention.test.py" <<'PY'
import pathlib
import sys

for argument in sys.argv[1:]:
    path = pathlib.Path(argument)
    compile(path.read_text(encoding="utf-8"), str(path), "exec")
PY
PYTHONDONTWRITEBYTECODE=1 python3 "${ARTIFACT_ROOT}/ghcr-retention.test.py"
node --check "${ARTIFACT_ROOT}/operator-entrypoint.mjs"
node --check "${ARTIFACT_ROOT}/fluent-bit-privacy.test.mjs"
node "${ARTIFACT_ROOT}/fluent-bit-privacy.test.mjs"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck --severity=warning --exclude=SC1090,SC2016,SC2034,SC2154,SC2155,SC2317 \
    "${ARTIFACT_ROOT}/cleanup-migrations.sh" \
    "${ARTIFACT_ROOT}/deploy.sh" \
    "${ARTIFACT_ROOT}/deploy-state-machine.test.sh" \
    "${ARTIFACT_ROOT}/fluent-bit-secret.test.sh" \
    "${ARTIFACT_ROOT}/migration-cleanup.test.sh" \
    "${ARTIFACT_ROOT}/operator.sh" \
    "${ARTIFACT_ROOT}/operator-secret.test.sh" \
    "${ARTIFACT_ROOT}/request-deploy.sh" \
    "${ARTIFACT_ROOT}/request-lifecycle.sh" \
    "${ARTIFACT_ROOT}/request-lifecycle.test.sh" \
    "${ARTIFACT_ROOT}/request-operator.sh" \
    "${ARTIFACT_ROOT}/start-fluent-bit.sh" \
    "${ARTIFACT_ROOT}/verify-host.sh" \
    "${ARTIFACT_ROOT}/verify-host-negative.test.sh" \
    "${ARTIFACT_ROOT}/verify-artifacts.sh"
fi

ARTIFACT_CLOUD_INIT="${ARTIFACT_ROOT}/cloud-init.yaml" node --input-type=module <<'NODE'
import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(process.env.ARTIFACT_CLOUD_INIT, "utf8"));
if (document?.users?.length !== 1 || document.users[0]?.name !== "capstone-operator") {
  throw new Error("cloud-init operator is missing");
}
if (document?.ssh_pwauth !== false || document?.disable_root !== true) {
  throw new Error("cloud-init SSH boundary changed");
}
if (
  document.users[0]?.sudo !== false ||
  JSON.stringify(document.users[0]?.groups) !== JSON.stringify(["adm"])
) {
  throw new Error("cloud-init operator has broad sudo or unexpected group authority");
}
const sudoers = document.write_files?.find(
  (file) => file?.path === "/etc/sudoers.d/60-capstone-operator",
);
const expectedSudoers =
  "capstone-operator ALL=(root) NOPASSWD: /opt/capstone-chat/bin/request-deploy.sh *, /opt/capstone-chat/bin/request-operator.sh *, /opt/capstone-chat/bin/verify-host.sh\n";
if (sudoers?.owner !== "root:root" || sudoers?.permissions !== "0440" || sudoers?.content !== expectedSudoers) {
  throw new Error("cloud-init audited sudo boundary changed");
}
if (!Array.isArray(document?.runcmd) || document.runcmd.length < 15) {
  throw new Error("cloud-init hardening commands are incomplete");
}
NODE

[[ $(grep -o '__OPERATOR_SSH_PUBLIC_KEY__' "${ARTIFACT_ROOT}/cloud-init.yaml" | wc -l | tr -d ' ') == 1 ]] ||
  fail "cloud-init must contain one public-key placeholder"
[[ $(grep -o '__OPERATOR_IPV4_CIDR__' "${ARTIFACT_ROOT}/cloud-init.yaml" | wc -l | tr -d ' ') == 1 ]] ||
  fail "cloud-init must contain one SSH CIDR placeholder"
grep -Fq 'PasswordAuthentication no' "${ARTIFACT_ROOT}/cloud-init.yaml" || fail "password SSH is not disabled"
grep -Fq 'PermitRootLogin no' "${ARTIFACT_ROOT}/cloud-init.yaml" || fail "root SSH is not disabled"
grep -Fq 'AuthenticationMethods publickey' "${ARTIFACT_ROOT}/cloud-init.yaml" || fail "SSH is not key-only"
grep -Fq 'DisableForwarding yes' "${ARTIFACT_ROOT}/cloud-init.yaml" || fail "SSH forwarding is enabled"
! grep -Eq 'NOPASSWD:[[:space:]]*ALL|ALL=\(ALL\)' "${ARTIFACT_ROOT}/cloud-init.yaml" ||
  fail "cloud-init grants broad passwordless root"
grep -Fq '[visudo, --check, --file, /etc/sudoers.d/60-capstone-operator]' \
  "${ARTIFACT_ROOT}/cloud-init.yaml" || fail "narrow sudo rule is not syntax-checked"
grep -Fq '[sshd, -t]' "${ARTIFACT_ROOT}/cloud-init.yaml" || fail "SSH configuration is not validated before restart"
grep -Fq 'IPV6=no' "${ARTIFACT_ROOT}/cloud-init.yaml" || fail "IPv6 firewall is not disabled"
grep -Fq 'kernel.core_pattern=/dev/null' "${ARTIFACT_ROOT}/cloud-init.yaml" || fail "host coredumps remain enabled"
grep -Fq '[systemctl, mask, caddy.service, caddy-api.service, fluent-bit.service]' \
  "${ARTIFACT_ROOT}/cloud-init.yaml" || fail "distribution proxy or log units can start before review"
grep -Fq '[timedatectl, set-ntp, "true"]' "${ARTIFACT_ROOT}/cloud-init.yaml" ||
  fail "host NTP synchronization is not enabled"

grep -Fq 'admin unix//run/capstone-caddy/admin.sock' "${ARTIFACT_ROOT}/Caddyfile" ||
  fail "Caddy admin endpoint is not Unix-only"
grep -Fq 'persist_config off' "${ARTIFACT_ROOT}/Caddyfile" || fail "Caddy API persistence is enabled"
if grep -Eq 'flush_interval|(^|[[:space:]])log([[:space:]]|$)|(^|[[:space:]])encode([[:space:]]|$)' "${ARTIFACT_ROOT}/Caddyfile"; then
  fail "Caddy buffering, access logging, or response transformation appeared"
fi
for header in Forwarded 'X-Forwarded-*' CF-Connecting-IP X-Capstone-Client-IP; do
  grep -Fq "header_up -${header}" "${ARTIFACT_ROOT}/deploy.sh" || fail "generated upstream does not strip ${header}"
done
grep -Fq 'header_up X-Capstone-Client-IP {http.request.remote.host}' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "generated upstream does not overwrite the private client address"
grep -Fq 'Strict-Transport-Security "max-age=31536000"' "${ARTIFACT_ROOT}/Caddyfile" ||
  fail "HSTS does not match the single approved hostname"
! grep -Fq 'includeSubDomains' "${ARTIFACT_ROOT}/Caddyfile" ||
  fail "HSTS claims unapproved sibling or child hosts"
grep -Fq 'CapabilityBoundingSet=CAP_NET_BIND_SERVICE' "${ARTIFACT_ROOT}/capstone-caddy.service" ||
  fail "Caddy capability boundary changed"
grep -Fq 'AmbientCapabilities=CAP_NET_BIND_SERVICE' "${ARTIFACT_ROOT}/capstone-caddy.service" ||
  fail "Caddy cannot bind its approved public ports"
grep -Fq 'InaccessiblePaths=/srv/capstone-secure/runtime /srv/capstone-secure/migration /srv/capstone-secure/registry /srv/capstone-secure/fluent-bit' \
  "${ARTIFACT_ROOT}/capstone-caddy.service" || fail "Caddy can traverse unrelated secret boundaries"

for option in \
  '--network host' \
  '--user 1000:1000' \
  '--read-only' \
  '--cap-drop ALL' \
  '--security-opt no-new-privileges=true' \
  '--pids-limit 256' \
  '--memory 640m' \
  '--memory-swap 640m' \
  '--ulimit core=0:0' \
  '--restart no' \
  'fluentd-async=true' \
  'fluentd-buffer-limit=1024' \
  'fluentd-max-retries=10' \
  'fluentd-write-timeout=1s' \
  'mode=non-blocking' \
  'max-buffer-size=4m' \
  'cache-disabled=true'; do
  grep -Fq -- "${option}" "${ARTIFACT_ROOT}/capstone-chat@.service" || fail "container option is missing: ${option}"
done
! grep -Fq -- 'docker run --rm --name capstone-chat-' "${ARTIFACT_ROOT}/capstone-chat@.service" ||
  fail "application auto-removal destroys bounded-shutdown evidence"
grep -Fq 'OnFailure=capstone-boot.service' "${ARTIFACT_ROOT}/capstone-deploy.service" ||
  fail "failed deployment does not reconcile"
grep -Fq 'deploy.sh prepare-caddy' "${ARTIFACT_ROOT}/capstone-caddy.service" ||
  fail "a standalone Caddy restart can forget the durable active release"
grep -Fq 'CAPSTONE_DEPLOY_SUPERVISED=1' "${ARTIFACT_ROOT}/capstone-deploy.service" ||
  fail "deployment supervision fence is missing"
grep -Fq 'TimeoutStartSec=2400s' "${ARTIFACT_ROOT}/capstone-deploy.service" ||
  fail "deployment start budget cannot enclose the valid activation path"
grep -Fq 'TimeoutStopSec=1200s' "${ARTIFACT_ROOT}/capstone-deploy.service" ||
  fail "deployment stop budget cannot enclose fail-safe reconciliation"
grep -Fq 'KillMode=mixed' "${ARTIFACT_ROOT}/capstone-deploy.service" ||
  fail "deployment stop kills reconciliation children before the supervisor trap"
grep -Fq 'TimeoutStartSec=900s' "${ARTIFACT_ROOT}/capstone-boot.service" ||
  fail "boot reconciliation cannot enclose two serial slot stops"
grep -Fq 'TimeoutStopSec=900s' "${ARTIFACT_ROOT}/capstone-boot.service" ||
  fail "boot reconciliation trap has no bounded convergence budget"
grep -Fq 'KillMode=mixed' "${ARTIFACT_ROOT}/capstone-boot.service" ||
  fail "boot timeout kills reconciliation children before the supervisor trap"
grep -Fq 'CAPSTONE_OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net' "${ARTIFACT_ROOT}/host.env" ||
  fail "official New Relic OTLP endpoint changed"
grep -Fq -- '--env OTEL_EXPORTER_OTLP_ENDPOINT=${CAPSTONE_OTEL_EXPORTER_OTLP_ENDPOINT}' \
  "${ARTIFACT_ROOT}/capstone-chat@.service" || fail "application container is missing the OTLP endpoint"
grep -Fq 'INVOCATION_ID' "${ARTIFACT_ROOT}/deploy.sh" || fail "deploy script accepts unsupervised use"
grep -Fq 'flock --exclusive --nonblock' "${ARTIFACT_ROOT}/deploy.sh" || fail "deployment lock is missing"
python3 - "${ARTIFACT_ROOT}/deploy.sh" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
exit_body = source.split("on_exit() {", 1)[1].split("\nmain() {", 1)[0]
if exit_body.index("reconcile_unlocked") > exit_body.index("remove_uncommitted_candidate"):
    raise RuntimeError("candidate cleanup precedes durable traffic reconciliation")
stop_body = source.split("stop_slot() {", 1)[1].split("\nstage_caddy_fragment() {", 1)[0]
for required in ("systemctl stop", ".State.ExitCode == 0", "write_shutdown_acknowledgement", 'docker rm "${initial_id}"'):
    if required not in stop_body:
        raise RuntimeError(f"clean shutdown contract lacks {required}")
if stop_body.index("write_shutdown_acknowledgement") > stop_body.index('docker rm "${initial_id}"'):
    raise RuntimeError("container is removed before clean-shutdown acknowledgement")
prune_body = source.split("prune_release_if_safe() {", 1)[1].split("\nprune_releases() {", 1)[0]
if prune_body.index('docker image rm "${image}"') > prune_body.index('find "${release}" -depth -delete'):
    raise RuntimeError("release metadata is deleted before bounded image removal succeeds")
if 'docker ps --all --quiet --filter "label=io.capstone.revision=${revision}"' not in prune_body:
    raise RuntimeError("release pruning ignores stopped containers")
if "docker image ls --digests --no-trunc --format" not in prune_body:
    raise RuntimeError("release pruning does not inventory real RepoDigests")
PY
python3 - "${ARTIFACT_ROOT}" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])

def timeout(unit, name):
    match = re.search(rf"^{name}=(\d+)s$", (root / unit).read_text(), re.MULTILINE)
    if match is None:
        raise RuntimeError(f"{unit} lacks exact {name}")
    return int(match.group(1))

deploy_start = timeout("capstone-deploy.service", "TimeoutStartSec")
deploy_stop = timeout("capstone-deploy.service", "TimeoutStopSec")
boot_start = timeout("capstone-boot.service", "TimeoutStartSec")
boot_stop = timeout("capstone-boot.service", "TimeoutStopSec")
operator_start = timeout("capstone-operator.service", "TimeoutStartSec")
operator_stop = timeout("capstone-operator.service", "TimeoutStopSec")
application_stop = timeout("capstone-chat@.service", "TimeoutStopSec")

# Serial valid-path maxima from the individually bounded subprocesses, plus the
# explicitly reviewed host/daemon headroom recorded beside the unit budgets.
if deploy_start < 575 + 210 + 485 + 245 + 330 + 155:
    raise RuntimeError("deployment start budget does not enclose the 2,000-second valid path")
if deploy_stop < 30 + 790 + 60:
    raise RuntimeError("deployment stop budget does not enclose signal forwarding and convergence")
if boot_start < 2 * 385 + 100 or boot_stop < 2 * 385 + 100:
    raise RuntimeError("boot budget does not enclose both slot stops and authority verification")
if operator_start < 255 + 485 + 610 + 60:
    raise RuntimeError("operator start budget does not enclose pull, migration, command, and cleanup")
if operator_stop < 30 + 60 + 30:
    raise RuntimeError("operator stop budget does not enclose child and post-stop cleanup")
if application_stop < 300 + 30:
    raise RuntimeError("application stop budget does not enclose Docker's grace period")
PY
grep -Eq 'rollback[[:space:]]*\|[[:space:]]*prune[[:space:]]*\|[[:space:]]*maintenance-on' "${ARTIFACT_ROOT}/request-deploy.sh" ||
  fail "bounded release pruning is not accepted by the request helper"
grep -Fq 'prune_releases' "${ARTIFACT_ROOT}/deploy.sh" || fail "bounded release pruning is not dispatched"
grep -Fq 'mv -fT "${temporary}" "${ACTIVE_LINK}"' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "active authority is not atomically replaced"
grep -Fq 'run_migrations "${revision}" "${digest}"' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "forward migration step is missing"
grep -Fq 'apps/api/dist/entrypoint.js migrate' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "migration bypasses the strict production entrypoint"
grep -Fq 'keys == ["DATABASE_URL"]' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "migration secret accepts extra runtime credentials"
grep -Fq 'http://localhost/config/' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "Caddy switch is not checked against its live admin state"
grep -Fq 'x-capstone-revision:' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "deployment does not verify the candidate revision response"
grep -Fq 'https://icanhazip.com/' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "deployment does not verify the externally observed reserved IPv4"
grep -Fq 'static_application_is_served' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "deployment lacks credential-free static smoke"
grep -Fq 'anonymous_session_is_rejected' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "deployment lacks credential-free API/session smoke"
grep -Fq 'X-Capstone-Client-IP: 192.0.2.1' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "direct Caddy-mode API smoke lacks a private client address"
grep -Fq 'activation-evidence schema=1 activatedAt=${activated_at} revision=${revision} digest=${digest}' \
  "${ARTIFACT_ROOT}/deploy.sh" || fail "activation has no exact content-free journal record"
grep -Fq 'org.opencontainers.image.source' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "deployment does not verify the OCI source repository"
grep -Fq 'capstone-chat$' "${ARTIFACT_ROOT}/request-deploy.sh" ||
  fail "deployment request accepts a foreign GHCR package"
grep -Fq 'inspect_container_if_present' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "container authority probes are not bounded and absence-aware"
grep -Fq 'hung-docker-reconcile' "${ARTIFACT_ROOT}/deploy-state-machine.test.sh" ||
  fail "hung Docker interruption does not have a convergence fixture"
grep -Fq 'ExitCode == 255' "${ARTIFACT_ROOT}/deploy.sh" ||
  fail "boot cannot recover Docker's power-loss exit sentinel"
grep -Fq 'protocols h1 h2' "${ARTIFACT_ROOT}/Caddyfile" ||
  fail "Caddy can open the unreviewed HTTP/3 UDP listener"

grep -Fq 'CAPSTONE_OPERATOR_SUPERVISED=1' "${ARTIFACT_ROOT}/capstone-operator.service" ||
  fail "operator command supervision fence is missing"
grep -Fq 'flock --exclusive --nonblock' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "operator commands do not share the deployment lock"
grep -Fq 'apps/api/dist/entrypoint.js' "${ARTIFACT_ROOT}/operator-entrypoint.mjs" ||
  fail "operator commands bypass the strict production entrypoint"
grep -Fq -- '--log-driver none' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "operator container can persist Docker logs"
grep -Fq 'secret_target=/run/capstone-secrets/operator.json' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "identity or model operator commands do not use the ephemeral composite"
! grep -Fq 'secret_target=/run/capstone-secrets/runtime.json' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "operator container receives the application runtime secret"
grep -Fq 'validate_migration_secret_file "${secret_source}" "${secret_gid}"' \
  "${ARTIFACT_ROOT}/operator.sh" || fail "a migration-secret mount bypasses exact schema validation"
grep -Fq 'mount_field / MAJ:MIN' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "operator secrets can be read before block-device identity validation"
grep -Fq '/sys/dev/block/${identity}/size' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "operator secret mount size is not verified"
grep -Fq 'model-policy-initialize' "${ARTIFACT_ROOT}/request-operator.sh" ||
  fail "first release has no supervised policy-initialization path"
grep -Fq 'prepare_initial_operator_image' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "initial policy does not use an immutable verified image"
grep -Fq 'run_initial_migrations' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "initial policy path does not migrate before bootstrap"
grep -Fq 'timeout --signal=TERM --kill-after=30s 180s' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "initial image pull is unbounded"
grep -Fq 'timeout --signal=TERM --kill-after=30s 300s' "${ARTIFACT_ROOT}/operator.sh" ||
  fail "initial migration is unbounded"
grep -Fq 'TimeoutStartSec=1800s' "${ARTIFACT_ROOT}/capstone-operator.service" ||
  fail "operator unit does not enclose initialization and command bounds"
grep -Fq 'TimeoutStopSec=210s' "${ARTIFACT_ROOT}/capstone-operator.service" ||
  fail "operator cleanup stop bound changed"
grep -Fq 'KillMode=mixed' "${ARTIFACT_ROOT}/capstone-operator.service" ||
  fail "operator timeout kills cleanup children before the supervisor"
grep -Fq 'ghcr-retention-plan' "${ARTIFACT_ROOT}/request-operator.sh" ||
  fail "GHCR retention has no explicit dry run"
grep -Fq 'ghcr-retention-show' "${ARTIFACT_ROOT}/request-operator.sh" ||
  fail "named operator cannot inspect the content-free retention plan"
grep -Fq 'candidateVersions: .core.candidateVersions' "${ARTIFACT_ROOT}/request-operator.sh" ||
  fail "retention review omits exact candidate IDs, digests, or tags"
grep -Fq 'GHCR or local protection state changed after the dry run' "${ARTIFACT_ROOT}/ghcr-retention.py" ||
  fail "GHCR deletion is not fenced by a fresh protection snapshot"

grep -Eq '^[[:space:]]*Mem_Buf_Limit[[:space:]]+8M$' "${ARTIFACT_ROOT}/fluent-bit.conf" ||
  fail "Fluent Bit memory boundary changed"
grep -Eq '^[[:space:]]*storage\.type[[:space:]]+memory$' "${ARTIFACT_ROOT}/fluent-bit.conf" ||
  fail "Fluent Bit is not memory-only"
grep -Eq '^[[:space:]]*Retry_Limit[[:space:]]+10$' "${ARTIFACT_ROOT}/fluent-bit.conf" ||
  fail "Fluent Bit retry boundary changed"
grep -Eq '^[[:space:]]*Remove[[:space:]]+log$' "${ARTIFACT_ROOT}/fluent-bit.conf" ||
  fail "unexpected non-JSON application output is not removed"
grep -Eq '^[[:space:]]*Reserve_Data[[:space:]]+Off$' "${ARTIFACT_ROOT}/fluent-bit.conf" ||
  fail "parsed logs retain unreviewed Docker fields"
grep -Eq '^[[:space:]]*Name[[:space:]]+record_modifier$' "${ARTIFACT_ROOT}/fluent-bit.conf" ||
  fail "structured application logs lack an explicit field allowlist"
grep -Eq '^[[:space:]]*Buffer_Max_Size[[:space:]]+16K$' "${ARTIFACT_ROOT}/fluent-bit.conf" ||
  fail "oversized raw records are not rejected at the reviewed bound"
grep -Eq '^[[:space:]]*Format[[:space:]]+json$' "${ARTIFACT_ROOT}/fluent-bit.conf" ||
  fail "New Relic payload is not valid JSON"
if grep -Eq 'storage\.path|filesystem|^[[:space:]]*Name[[:space:]]+newrelic' "${ARTIFACT_ROOT}/fluent-bit.conf"; then
  fail "Fluent Bit gained disk storage or an external output plugin"
fi
grep -Fq 'ExecStart=/opt/capstone-chat/bin/start-fluent-bit.sh' "${ARTIFACT_ROOT}/capstone-fluent-bit.service" ||
  fail "Fluent Bit does not use the data-only secret launcher"
! grep -Fq 'EnvironmentFile=' "${ARTIFACT_ROOT}/capstone-fluent-bit.service" ||
  fail "systemd parses the Fluent Bit secret as executable environment syntax"
grep -Fq 'exec /opt/fluent-bit/bin/fluent-bit --config /etc/capstone-chat/fluent-bit.conf' \
  "${ARTIFACT_ROOT}/start-fluent-bit.sh" || fail "Fluent Bit launcher uses the wrong vendor binary"
grep -Fq 'io.capstone.migration' "${ARTIFACT_ROOT}/cleanup-migrations.sh" ||
  fail "migration survivor cleanup lacks an exact label fence"
grep -Fq 'cleanup-migrations.sh post-stop' "${ARTIFACT_ROOT}/capstone-deploy.service" ||
  fail "deployment interruption cannot reap an exact migration survivor"
grep -Fq 'cleanup-migrations.sh post-stop' "${ARTIFACT_ROOT}/capstone-operator.service" ||
  fail "operator interruption cannot reap an exact migration survivor"
grep -Fq 'capstone_request_unit_accepts_new_work' "${ARTIFACT_ROOT}/request-deploy.sh" ||
  fail "deployment request lifecycle is not bound to systemd state"
grep -Fq 'capstone_request_unit_accepts_new_work' "${ARTIFACT_ROOT}/request-operator.sh" ||
  fail "operator request lifecycle is not bound to systemd state"

if command -v cloud-init >/dev/null 2>&1; then
  cloud-init schema --config-file "${ARTIFACT_ROOT}/cloud-init.yaml"
fi
if [[ -x /opt/fluent-bit/bin/fluent-bit ]]; then
  fluent_config=$(mktemp "${TMPDIR:-/tmp}/capstone-fluent-bit.XXXXXX")
  sed "s#/etc/capstone-chat/fluent-bit-parsers.conf#${ARTIFACT_ROOT}/fluent-bit-parsers.conf#" \
    "${ARTIFACT_ROOT}/fluent-bit.conf" >"${fluent_config}"
  NEW_RELIC_LICENSE_KEY=validation-placeholder /opt/fluent-bit/bin/fluent-bit --dry-run --config "${fluent_config}"
  rm -f "${fluent_config}"
fi
if [[ $(uname -s) == Linux ]] && ! command -v systemd-analyze >/dev/null 2>&1; then
  fail "systemd-analyze is required for deterministic Linux unit validation"
fi
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd_root=$(mktemp --directory "${TMPDIR:-/tmp}/capstone-systemd.XXXXXX")
  cleanup_systemd_root() {
    [[ -d ${systemd_root} && ! -L ${systemd_root} && ${systemd_root} == */capstone-systemd.* ]] ||
      fail "temporary systemd root is unsafe"
    find "${systemd_root}" -depth -delete
  }
  trap cleanup_systemd_root EXIT
  install -d -m 0755 \
    "${systemd_root}/etc/capstone-chat" \
    "${systemd_root}/etc/systemd/system" \
    "${systemd_root}/etc" \
    "${systemd_root}/opt/capstone-chat/bin" \
    "${systemd_root}/opt/fluent-bit/bin" \
    "${systemd_root}/run/capstone-chat" \
    "${systemd_root}/srv/capstone-secure" \
    "${systemd_root}/usr/bin"
  install -m 0644 /etc/os-release "${systemd_root}/etc/os-release"
  install -m 0644 "${ARTIFACT_ROOT}"/*.service "${systemd_root}/etc/systemd/system/"
  install -m 0644 /dev/null "${systemd_root}/etc/capstone-chat/host.env"
  install -m 0644 /dev/null "${systemd_root}/run/capstone-chat/slot-.env"
  install -D -m 0644 /dev/null "${systemd_root}/opt/capstone-chat/README.md"
  for executable in \
    /opt/capstone-chat/bin/cleanup-migrations.sh \
    /opt/capstone-chat/bin/deploy.sh \
    /opt/capstone-chat/bin/operator.sh \
    /opt/capstone-chat/bin/start-fluent-bit.sh \
    /opt/fluent-bit/bin/fluent-bit \
    /usr/bin/caddy \
    /usr/bin/docker \
    /usr/bin/rm \
    /usr/bin/timeout \
    /usr/bin/true; do
    install -D -m 0755 /dev/null "${systemd_root}${executable}"
  done
  for target in sysinit.target basic.target multi-user.target network-online.target shutdown.target; do
    printf '[Unit]\nDescription=Capstone verifier fixture for %s\nDefaultDependencies=no\n' "${target}" \
      >"${systemd_root}/etc/systemd/system/${target}"
  done
  printf '%s\n' \
    '[Unit]' \
    'Description=Capstone verifier Docker fixture' \
    'After=network-online.target' \
    '' \
    '[Service]' \
    'Type=oneshot' \
    'ExecStart=/usr/bin/true' \
    'RemainAfterExit=yes' \
    >"${systemd_root}/etc/systemd/system/docker.service"
  printf '%s\n' \
    '[Unit]' \
    'Description=Capstone verifier secure Volume fixture' \
    'DefaultDependencies=no' \
    '' \
    '[Mount]' \
    'What=/dev/null' \
    'Where=/srv/capstone-secure' \
    'Type=none' \
    >"${systemd_root}/etc/systemd/system/srv-capstone\\x2dsecure.mount"
  systemd-analyze verify --root="${systemd_root}" \
    capstone-caddy.service \
    capstone-fluent-bit.service \
    capstone-chat@.service \
    capstone-boot.service \
    capstone-deploy.service \
    capstone-operator.service
  trap - EXIT
  cleanup_systemd_root
fi

printf 'DigitalOcean source artifact checks passed.\n'
if ! command -v caddy >/dev/null 2>&1; then
  printf 'Caddy binary is unavailable locally; installed-host validation remains required.\n'
fi
if [[ ! -x /opt/fluent-bit/bin/fluent-bit ]]; then
  printf 'Fluent Bit binary is unavailable locally; installed-host dry-run remains required.\n'
fi
