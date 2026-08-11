#!/usr/bin/env bash
set -euo pipefail

readonly HOST_ENV=/etc/capstone-chat/host.env
readonly STATE_ROOT=/var/lib/capstone-chat
readonly ACTIVE_LINK="${STATE_ROOT}/active"
readonly SECURE_ROOT=/srv/capstone-secure
readonly APP_MEMORY_BYTES=671088640
failures=0

pass() {
  printf 'PASS  %s\n' "$1"
}

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

check() {
  local description=$1
  shift
  if "$@"; then
    pass "${description}"
  else
    fail "${description}"
  fi
}

file_exact() {
  local path=$1 owner=$2 group=$3 mode=$4 identity
  [[ -f ${path} && ! -L ${path} ]] || return 1
  identity=$(stat -c '%U:%G:%a' "${path}") || return 1
  [[ ${identity} == "${owner}:${group}:${mode}" ]]
}

directory_exact() {
  local path=$1 owner=$2 group=$3 mode=$4 identity
  [[ -d ${path} && ! -L ${path} ]] || return 1
  identity=$(stat -c '%U:%G:%a' "${path}") || return 1
  [[ ${identity} == "${owner}:${group}:${mode}" ]]
}

systemd_unit_snapshot() {
  [[ $# -eq 1 ]] || return 1
  local unit=$1 snapshot key value
  local load_state="" active_state="" job=""
  local load_seen=0 active_seen=0 job_seen=0

  snapshot=$(systemctl show \
    --property=LoadState \
    --property=ActiveState \
    --property=Job \
    -- "${unit}") || return 1

  while IFS='=' read -r key value; do
    case "${key}" in
      LoadState)
        ((load_seen += 1))
        load_state=${value}
        ;;
      ActiveState)
        ((active_seen += 1))
        active_state=${value}
        ;;
      Job)
        ((job_seen += 1))
        job=${value}
        ;;
      *) return 1 ;;
    esac
  done <<<"${snapshot}"

  [[ ${load_seen} -eq 1 && ${active_seen} -eq 1 && ${job_seen} -eq 1 ]] || return 1
  [[ ${load_state} =~ ^[a-z-]+$ && ${active_state} =~ ^[a-z-]+$ ]] || return 1
  [[ -z ${job} || ${job} =~ ^[0-9]+[[:space:]][a-z-]+$ ]] || return 1
  printf '%s\t%s\t%s\n' "${load_state}" "${active_state}" "${job}"
}

unit_is_steady_active() {
  local snapshot load_state active_state job
  snapshot=$(systemd_unit_snapshot "$1") || return 1
  IFS=$'\t' read -r load_state active_state job <<<"${snapshot}" || return 1
  [[ ${load_state} == loaded && ${active_state} == active && -z ${job} ]]
}

unit_is_quiescent() {
  local snapshot load_state active_state job
  snapshot=$(systemd_unit_snapshot "$1") || return 1
  IFS=$'\t' read -r load_state active_state job <<<"${snapshot}" || return 1
  [[ ${load_state} == loaded ]] || return 1
  [[ ${active_state} == inactive || ${active_state} == failed ]] || return 1
  [[ -z ${job} ]]
}

file_does_not_match() {
  [[ $# -eq 2 ]] || return 1
  local pattern=$1 path=$2 status=0
  grep -Eq "${pattern}" "${path}" || status=$?
  [[ ${status} -eq 1 ]]
}

text_does_not_match() {
  [[ $# -eq 2 ]] || return 1
  local pattern=$1 value=$2 status=0
  grep -Eq "${pattern}" <<<"${value}" || status=$?
  [[ ${status} -eq 1 ]]
}

secure_directories_are_exact() {
  directory_exact /srv/capstone-secure root root 711 &&
    directory_exact /srv/capstone-secure/runtime root capstone-runtime-secrets 750 &&
    directory_exact /srv/capstone-secure/migration root capstone-migration-secrets 750 &&
    directory_exact /srv/capstone-secure/registry root root 700 &&
    directory_exact /srv/capstone-secure/caddy caddy capstone-caddy-secrets 700 &&
    directory_exact /srv/capstone-secure/fluent-bit root capstone-fluent-bit-secrets 750
}

service_identities_cannot_cross_read() {
  runuser --user caddy -- test ! -r /srv/capstone-secure/runtime/runtime.json &&
    runuser --user caddy -- test ! -r /srv/capstone-secure/migration/migration.json &&
    runuser --user caddy -- test ! -r /srv/capstone-secure/registry/config.json &&
    runuser --user caddy -- test ! -r /srv/capstone-secure/fluent-bit/new-relic.env &&
    runuser --user capstone-fluent-bit -- test ! -r /srv/capstone-secure/runtime/runtime.json &&
    runuser --user capstone-fluent-bit -- test ! -r /srv/capstone-secure/migration/migration.json &&
    runuser --user capstone-fluent-bit -- test ! -r /srv/capstone-secure/registry/config.json &&
    runuser --user capstone-fluent-bit -- test ! -r /srv/capstone-secure/caddy &&
    runuser --user capstone-operator -- test ! -r /srv/capstone-secure/runtime/runtime.json &&
    runuser --user capstone-operator -- test ! -r /srv/capstone-secure/migration/migration.json &&
    runuser --user capstone-operator -- test ! -r /srv/capstone-secure/registry/config.json &&
    runuser --user capstone-operator -- test ! -r /srv/capstone-secure/fluent-bit/new-relic.env
}

image_repository_is_exact() {
  [[ ${CAPSTONE_IMAGE_REPOSITORY:-} =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*/capstone-chat$ ]]
}

mount_field() {
  findmnt --noheadings --output "$2" --target "$1"
}

block_device_size_bytes() {
  local identity=$1 sectors
  [[ ${identity} =~ ^[0-9]+:[0-9]+$ ]] || return 1
  [[ -r /sys/dev/block/${identity}/size ]] || return 1
  sectors=$(<"/sys/dev/block/${identity}/size") || return 1
  [[ ${sectors} =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$((sectors * 512))"
}

mount_is_restricted_volume() {
  local target options root_identity secure_identity
  target=$(mount_field "${SECURE_ROOT}" TARGET) || return 1
  options=$(mount_field "${SECURE_ROOT}" OPTIONS) || return 1
  root_identity=$(mount_field / MAJ:MIN) || return 1
  secure_identity=$(mount_field "${SECURE_ROOT}" MAJ:MIN) || return 1
  [[ ${target} == "${SECURE_ROOT}" && ${root_identity} =~ ^[0-9]+:[0-9]+$ &&
    ${secure_identity} =~ ^[0-9]+:[0-9]+$ && ${secure_identity} != "${root_identity}" ]] || return 1
  block_device_size_bytes "${secure_identity}" >/dev/null || return 1
  for option in nodev nosuid noexec; do
    [[ ,${options}, == *,${option},* ]] || return 1
  done
}

volume_has_exact_size() {
  local identity size
  identity=$(mount_field "${SECURE_ROOT}" MAJ:MIN) || return 1
  size=$(block_device_size_bytes "${identity}") || return 1
  [[ ${size} == "${CAPSTONE_EXPECTED_VOLUME_BYTES}" ]]
}

region_matches_host_contract() {
  local region
  region=$(curl --fail --silent --show-error --max-time 3 \
    http://169.254.169.254/metadata/v1/region) || return 1
  [[ ${region} == "${CAPSTONE_EXPECTED_REGION}" ]]
}

runtime_contract_is_exact() {
  case "${CAPSTONE_NODE_ENV:-}" in
    production)
      [[ ${CAPSTONE_EMAIL_DELIVERY:-} == resend &&
        ${CAPSTONE_MODEL_GATEWAY:-} == openrouter &&
        ${CAPSTONE_EXPECTED_REGION:-} == ric1 ]]
      ;;
    test)
      [[ ${CAPSTONE_EMAIL_DELIVERY:-} == disabled &&
        ${CAPSTONE_MODEL_GATEWAY:-} == fake &&
        ${CAPSTONE_EXPECTED_REGION:-} == nyc3 &&
        -n ${CAPSTONE_PUBLIC_HOST:-} &&
        ${CAPSTONE_PUBLIC_HOST} != chat.capstone.com.ec &&
        ${CAPSTONE_PUBLIC_ORIGIN:-} == "https://${CAPSTONE_PUBLIC_HOST}" ]]
      ;;
    *) return 1 ;;
  esac
}

outbound_source_is_reserved() {
  local observed
  observed=$(curl --fail --silent --show-error --max-time 5 https://icanhazip.com/ |
    tr -d '[:space:]') || return 1
  [[ ${observed} == "${CAPSTONE_EXPECTED_OUTBOUND_IPV4}" ]]
}

default_route_uses_anchor_gateway() {
  local route gateway="" anchor_gateway
  anchor_gateway=$(curl --fail --silent --show-error --max-time 3 \
    http://169.254.169.254/metadata/v1/interfaces/public/0/anchor_ipv4/gateway) || return 1
  route=$(ip -4 route show default) || return 1
  gateway=$(awk '{ for (index = 1; index <= NF; index += 1) if ($index == "via") { print $(index + 1); exit } }' \
    <<<"${route}") || return 1
  [[ ${gateway} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  [[ ${anchor_gateway} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  [[ ${gateway} == "${anchor_gateway}" ]]
}

no_active_swap() {
  local swap
  swap=$(swapon --noheadings --show) || return 1
  [[ -z ${swap} ]]
}

ipv6_is_disabled() {
  local all default loopback
  all=$(sysctl -n net.ipv6.conf.all.disable_ipv6) || return 1
  default=$(sysctl -n net.ipv6.conf.default.disable_ipv6) || return 1
  loopback=$(sysctl -n net.ipv6.conf.lo.disable_ipv6) || return 1
  [[ ${all} == 1 && ${default} == 1 && ${loopback} == 1 ]]
}

core_dumps_are_disabled() {
  local suid_dumpable core_pattern
  suid_dumpable=$(sysctl -n fs.suid_dumpable) || return 1
  core_pattern=$(sysctl -n kernel.core_pattern) || return 1
  [[ ${suid_dumpable} == 0 ]] &&
    [[ ${core_pattern} == /dev/null ]] &&
    grep -Eq '^Storage=none$' /etc/systemd/coredump.conf.d/60-capstone-production.conf &&
    grep -Eq '^ProcessSizeMax=0$' /etc/systemd/coredump.conf.d/60-capstone-production.conf
}

utc_clock_is_synchronized() {
  local timezone synchronized
  timezone=$(timedatectl show --property=Timezone --value) || return 1
  synchronized=$(timedatectl show --property=NTPSynchronized --value) || return 1
  [[ ${timezone} == Etc/UTC && ${synchronized} == yes ]]
}

only_operator_has_interactive_shell() {
  local passwd user shell
  [[ -r /etc/passwd ]] || return 1
  passwd=$(</etc/passwd) || return 1
  while IFS=: read -r user _ _ _ _ _ shell; do
    case "${shell}" in
      /bin/bash | /bin/sh | /bin/zsh)
        [[ ${user} == root || ${user} == capstone-operator ]] || return 1
        ;;
    esac
  done <<<"${passwd}"
}

no_ordinary_docker_group_member() {
  local record group password gid members remainder
  record=$(getent group docker) || return 1
  IFS=: read -r group password gid members remainder <<<"${record}" || return 1
  [[ ${group} == docker && -n ${password} && ${gid} =~ ^[0-9]+$ && -z ${remainder} ]] || return 1
  [[ -z ${members} ]]
}

service_identities_are_exact() {
  local caddy_uid caddy_gid caddy_groups fluent_uid fluent_gid fluent_groups
  caddy_uid=$(id -u caddy) || return 1
  caddy_gid=$(id -g caddy) || return 1
  caddy_groups=$(id -G caddy) || return 1
  fluent_uid=$(id -u capstone-fluent-bit) || return 1
  fluent_gid=$(id -g capstone-fluent-bit) || return 1
  fluent_groups=$(id -G capstone-fluent-bit) || return 1
  [[ ${caddy_uid} == 21010 && ${caddy_gid} == 21003 && ${caddy_groups} == 21003 ]] &&
    [[ ${fluent_uid} == 21011 && ${fluent_gid} == 21004 && ${fluent_groups} == 21004 ]]
}

distribution_units_are_masked() {
  local unit snapshot key value load_state unit_file_state load_seen unit_file_seen
  for unit in caddy.service caddy-api.service fluent-bit.service; do
    load_state=""
    unit_file_state=""
    load_seen=0
    unit_file_seen=0
    snapshot=$(systemctl show --property=LoadState --property=UnitFileState -- "${unit}") || return 1
    while IFS='=' read -r key value; do
      case "${key}" in
        LoadState)
          ((load_seen += 1))
          load_state=${value}
          ;;
        UnitFileState)
          ((unit_file_seen += 1))
          unit_file_state=${value}
          ;;
        *) return 1 ;;
      esac
    done <<<"${snapshot}"
    [[ ${load_seen} -eq 1 && ${unit_file_seen} -eq 1 ]] || return 1
    [[ ${load_state} == masked && ${unit_file_state} == masked ]] || return 1
  done
}

operator_sudo_boundary_is_exact() {
  local groups expected actual
  local -a group_list
  local group has_operator=0 has_adm=0
  groups=$(id -Gn capstone-operator) || return 1
  read -r -a group_list <<<"${groups}" || return 1
  [[ ${#group_list[@]} -eq 2 ]] || return 1
  for group in "${group_list[@]}"; do
    case "${group}" in
      capstone-operator) has_operator=1 ;;
      adm) has_adm=1 ;;
      *) return 1 ;;
    esac
  done
  [[ ${has_operator} -eq 1 && ${has_adm} -eq 1 ]] || return 1
  file_exact /etc/sudoers.d/60-capstone-operator root root 440 || return 1
  expected='capstone-operator ALL=(root) NOPASSWD: /opt/capstone-chat/bin/request-deploy.sh *, /opt/capstone-chat/bin/request-operator.sh *, /opt/capstone-chat/bin/verify-host.sh'
  actual=$(tr -d '\r\n' </etc/sudoers.d/60-capstone-operator) || return 1
  [[ ${actual} == "${expected}" ]] && visudo --check --file /etc/sudoers.d/60-capstone-operator >/dev/null
}

installed_artifacts_are_exact() {
  local path
  for path in \
    /etc/capstone-chat/Caddyfile \
    /etc/capstone-chat/fluent-bit-parsers.conf \
    /etc/capstone-chat/fluent-bit.conf \
    /etc/capstone-chat/maintenance.caddy \
    /opt/capstone-chat/README.md; do
    file_exact "${path}" root root 644 || return 1
  done
  for path in \
    /opt/capstone-chat/bin/deploy.sh \
    /opt/capstone-chat/bin/cleanup-migrations.sh \
    /opt/capstone-chat/bin/operator.sh \
    /opt/capstone-chat/bin/request-deploy.sh \
    /opt/capstone-chat/bin/request-lifecycle.sh \
    /opt/capstone-chat/bin/request-operator.sh \
    /opt/capstone-chat/bin/verify-host.sh \
    /opt/capstone-chat/lib/ghcr-retention.py; do
    file_exact "${path}" root root 750 || return 1
  done
  file_exact /opt/capstone-chat/bin/start-fluent-bit.sh root capstone-fluent-bit-secrets 550 || return 1
  file_exact /opt/fluent-bit/bin/fluent-bit root root 755 || return 1
  file_exact /opt/capstone-chat/lib/operator-entrypoint.mjs root root 644 || return 1
  for path in \
    /etc/systemd/system/capstone-boot.service \
    /etc/systemd/system/capstone-caddy.service \
    /etc/systemd/system/capstone-chat@.service \
    /etc/systemd/system/capstone-deploy.service \
    /etc/systemd/system/capstone-fluent-bit.service \
    /etc/systemd/system/capstone-operator.service; do
    file_exact "${path}" root root 644 || return 1
  done
}

operator_boundary_is_idle() {
  local ids
  unit_is_quiescent capstone-deploy.service || return 1
  unit_is_quiescent capstone-operator.service || return 1
  ids=$(timeout --signal=TERM --kill-after=5s 15s \
    docker ps --all --quiet --filter name=^/capstone-operator$) || return 1
  [[ -z ${ids} ]] || return 1
  [[ ! -e /run/capstone-operator/operator-secret.json &&
    ! -L /run/capstone-operator/operator-secret.json ]]
}

managed_container_inventory_is_exact() {
  local application_ids slot_a_ids slot_b_ids migration_ids migration_name_ids
  local initial_migration_name_ids all_ids id application_id="" all_id=""
  local application_count=0 named_application_count=0 all_count=0
  application_ids=$(timeout --signal=TERM --kill-after=5s 15s \
    docker ps --all --quiet --filter label=io.capstone.slot) || return 1
  while IFS= read -r id; do
    [[ -n ${id} ]] || continue
    [[ ${id} =~ ^[0-9a-f]{12,64}$ ]] || return 1
    ((application_count += 1))
    application_id=${id}
  done <<<"${application_ids}"
  [[ ${application_count} -eq 1 ]] || return 1

  slot_a_ids=$(timeout --signal=TERM --kill-after=5s 15s \
    docker ps --all --quiet --filter name=^/capstone-chat-a$) || return 1
  slot_b_ids=$(timeout --signal=TERM --kill-after=5s 15s \
    docker ps --all --quiet --filter name=^/capstone-chat-b$) || return 1
  while IFS= read -r id; do
    [[ -n ${id} ]] || continue
    [[ ${id} =~ ^[0-9a-f]{12,64}$ ]] || return 1
    ((named_application_count += 1))
    [[ ${id} == "${application_id}" ]] || return 1
  done <<<"${slot_a_ids}"$'\n'"${slot_b_ids}"
  [[ ${named_application_count} -eq 1 ]] || return 1

  migration_ids=$(timeout --signal=TERM --kill-after=5s 15s \
    docker ps --all --quiet --filter label=io.capstone.migration=true) || return 1
  migration_name_ids=$(timeout --signal=TERM --kill-after=5s 15s \
    docker ps --all --quiet --filter name=^/capstone-migration-) || return 1
  initial_migration_name_ids=$(timeout --signal=TERM --kill-after=5s 15s \
    docker ps --all --quiet --filter name=^/capstone-initial-migration-) || return 1
  [[ -z ${migration_ids} && -z ${migration_name_ids} && -z ${initial_migration_name_ids} ]] ||
    return 1

  all_ids=$(timeout --signal=TERM --kill-after=5s 15s docker ps --all --quiet) || return 1
  while IFS= read -r id; do
    [[ -n ${id} ]] || continue
    [[ ${id} =~ ^[0-9a-f]{12,64}$ ]] || return 1
    ((all_count += 1))
    all_id=${id}
  done <<<"${all_ids}"
  [[ ${all_count} -eq 1 && ${all_id} == "${application_id}" ]]
}

migration_secret_schema_is_exact() {
  jq --exit-status \
    'keys == ["DATABASE_URL"] and (.DATABASE_URL | type == "string" and length > 0)' \
    "${CAPSTONE_MIGRATION_SECRET_PATH}" >/dev/null
}

runtime_secret_schema_is_exact() {
  case "${CAPSTONE_NODE_ENV}" in
    production)
      jq --exit-status \
        'keys == ["BETTER_AUTH_SECRET", "DATABASE_URL", "OPENROUTER_API_KEY", "OTEL_EXPORTER_OTLP_HEADERS", "RESEND_API_KEY"] and
         all(.[]; type == "string" and length > 0)' \
        "${CAPSTONE_RUNTIME_SECRET_PATH}" >/dev/null
      ;;
    test)
      jq --exit-status \
        'keys == ["BETTER_AUTH_SECRET", "DATABASE_URL", "OTEL_EXPORTER_OTLP_HEADERS"] and
         all(.[]; type == "string" and length > 0)' \
        "${CAPSTONE_RUNTIME_SECRET_PATH}" >/dev/null
      ;;
    *) return 1 ;;
  esac
}

ufw_contract() {
  local status verbose line operator_address address_pattern
  local rule_count=0 ssh_rule=0 http_rule=0 https_rule=0
  status=$(ufw status numbered) || return 1
  verbose=$(ufw status verbose) || return 1
  grep -Fq 'Status: active' <<<"${status}" || return 1
  grep -Eq '^Default: deny \(incoming\), allow \(outgoing\), disabled \(routed\)$' \
    <<<"${verbose}" || return 1
  text_does_not_match '\(v6\)' "${status}" || return 1
  [[ ${CAPSTONE_OPERATOR_IPV4_CIDR} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]] || return 1
  operator_address=${CAPSTONE_OPERATOR_IPV4_CIDR%/32}
  address_pattern=${operator_address//./\.}
  while IFS= read -r line; do
    [[ ${line} =~ ^\[[[:space:]]*[0-9]+\] ]] || continue
    ((rule_count += 1))
    if [[ ${line} =~ ^\[[[:space:]]*[0-9]+\][[:space:]]+22/tcp[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+${address_pattern}(/32)?([[:space:]]+\#.*)?$ ]]; then
      ((ssh_rule += 1))
    elif [[ ${line} =~ ^\[[[:space:]]*[0-9]+\][[:space:]]+80/tcp[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+Anywhere([[:space:]]+\#.*)?$ ]]; then
      ((http_rule += 1))
    elif [[ ${line} =~ ^\[[[:space:]]*[0-9]+\][[:space:]]+443/tcp[[:space:]]+ALLOW[[:space:]]+IN[[:space:]]+Anywhere([[:space:]]+\#.*)?$ ]]; then
      ((https_rule += 1))
    else
      return 1
    fi
  done <<<"${status}"
  [[ ${rule_count} -eq 3 && ${ssh_rule} -eq 1 && ${http_rule} -eq 1 && ${https_rule} -eq 1 ]]
}

tcp_listener_allowlist_is_exact() {
  local listeners line endpoint
  local ssh_count=0 http_count=0 https_count=0 application_count=0
  local dns_stub_count=0 dns_proxy_count=0
  listeners=$(ss --tcp --listening --numeric --no-header) || return 1
  while IFS= read -r line; do
    [[ -n ${line} ]] || continue
    endpoint=$(awk '{ print $4 }' <<<"${line}") || return 1
    case "${endpoint}" in
      0.0.0.0:22) ((ssh_count += 1)) ;;
      0.0.0.0:80) ((http_count += 1)) ;;
      0.0.0.0:443) ((https_count += 1)) ;;
      127.0.0.1:3001 | 127.0.0.1:3002) ((application_count += 1)) ;;
      127.0.0.53%lo:53) ((dns_stub_count += 1)) ;;
      127.0.0.54:53) ((dns_proxy_count += 1)) ;;
      *) return 1 ;;
    esac
  done <<<"${listeners}"
  [[ ${ssh_count} -eq 1 && ${http_count} -eq 1 && ${https_count} -eq 1 ]] || return 1
  [[ ${application_count} -eq 1 ]] || return 1
  [[ ${dns_stub_count} -eq 1 && ${dns_proxy_count} -eq 1 ]]
}

one_active_slot() {
  local slot snapshot load_state active_state job
  local count=0
  for slot in a b; do
    snapshot=$(systemd_unit_snapshot "capstone-chat@${slot}.service") || return 1
    IFS=$'\t' read -r load_state active_state job <<<"${snapshot}" || return 1
    [[ ${load_state} == loaded && -z ${job} ]] || return 1
    case "${active_state}" in
      active) ((count += 1)) ;;
      inactive | failed) ;;
      *) return 1 ;;
    esac
  done
  [[ ${count} -eq 1 ]]
}

active_release_is_valid() {
  [[ -L ${ACTIVE_LINK} ]] || return 1
  local release release_identity revision digest image slot port expected_source
  local image_revision image_source image_user container_revision container_digest
  release=$(readlink --canonicalize-existing "${ACTIVE_LINK}") || return 1
  [[ ${release} =~ ^${STATE_ROOT}/releases/[0-9a-f]{40}$ ]] || return 1
  [[ -d ${release} && ! -L ${release} ]] || return 1
  release_identity=$(stat -c '%U:%G:%a' "${release}") || return 1
  [[ ${release_identity} == root:root:550 ]] || return 1
  file_exact "${release}/release.json" root root 440 || return 1
  file_exact "${release}/upstream.caddy" root root 440 || return 1
  revision=$(jq --exit-status --raw-output .revision "${release}/release.json") || return 1
  digest=$(jq --exit-status --raw-output .digest "${release}/release.json") || return 1
  image=$(jq --exit-status --raw-output .image "${release}/release.json") || return 1
  slot=$(jq --exit-status --raw-output .slot "${release}/release.json") || return 1
  port=$(jq --exit-status --raw-output .port "${release}/release.json") || return 1
  [[ ${release} == "${STATE_ROOT}/releases/${revision}" ]] || return 1
  [[ ${digest} =~ ^sha256:[0-9a-f]{64}$ && ${image} == "${CAPSTONE_IMAGE_REPOSITORY}@${digest}" ]] || return 1
  [[ ${slot}:${port} == a:3001 || ${slot}:${port} == b:3002 ]] || return 1
  expected_source="https://github.com/${CAPSTONE_IMAGE_REPOSITORY#ghcr.io/}"
  image_revision=$(docker image inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image}") || return 1
  image_source=$(docker image inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.source" }}' "${image}") || return 1
  image_user=$(docker image inspect --format '{{ .Config.User }}' "${image}") || return 1
  container_revision=$(docker inspect --format \
    '{{ index .Config.Labels "io.capstone.revision" }}' "capstone-chat-${slot}") || return 1
  container_digest=$(docker inspect --format \
    '{{ index .Config.Labels "io.capstone.digest" }}' "capstone-chat-${slot}") || return 1
  [[ ${image_revision} == "${revision}" ]] || return 1
  [[ ${image_source} == "${expected_source}" ]] || return 1
  [[ ${image_user} == node ]] || return 1
  [[ ${container_revision} == "${revision}" && ${container_digest} == "${digest}" ]]
}

container_contract() {
  local release slot name inspection
  release=$(readlink --canonicalize-existing "${ACTIVE_LINK}") || return 1
  slot=$(jq --exit-status --raw-output .slot "${release}/release.json") || return 1
  name="capstone-chat-${slot}"
  inspection=$(docker inspect "${name}") || return 1
  jq --exit-status \
    --argjson memory "${APP_MEMORY_BYTES}" \
    --arg secret "${CAPSTONE_RUNTIME_SECRET_PATH}" \
    --arg otlp "${CAPSTONE_OTEL_EXPORTER_OTLP_ENDPOINT}" \
    '.[0] as $container |
     $container.Config.User == "1000:1000" and
     ($container.Config.Env | index("OTEL_EXPORTER_OTLP_ENDPOINT=" + $otlp) != null) and
     $container.HostConfig.AutoRemove == false and
     $container.HostConfig.Privileged == false and
     $container.HostConfig.ReadonlyRootfs == true and
     $container.HostConfig.NetworkMode == "host" and
     (($container.HostConfig.PortBindings // {}) | length) == 0 and
     $container.HostConfig.Memory == $memory and
     $container.HostConfig.MemorySwap == $memory and
     $container.HostConfig.PidsLimit == 256 and
     $container.HostConfig.RestartPolicy.Name == "no" and
     $container.HostConfig.CapDrop == ["ALL"] and
     (($container.HostConfig.CapAdd // []) | length) == 0 and
     (($container.HostConfig.Devices // []) | length) == 0 and
     ($container.HostConfig.SecurityOpt | index("no-new-privileges=true") != null) and
     $container.HostConfig.GroupAdd == ["21001"] and
     $container.HostConfig.Tmpfs["/tmp"] == "rw,noexec,nosuid,nodev,size=32m,mode=1777" and
     ($container.HostConfig.Ulimits | any(.Name == "core" and .Soft == 0 and .Hard == 0)) and
     $container.HostConfig.LogConfig.Type == "fluentd" and
     $container.HostConfig.LogConfig.Config["fluentd-address"] == "unix:///run/capstone-fluent-bit/docker.sock" and
     $container.HostConfig.LogConfig.Config["fluentd-async"] == "true" and
     $container.HostConfig.LogConfig.Config["fluentd-buffer-limit"] == "1024" and
     $container.HostConfig.LogConfig.Config["fluentd-retry-wait"] == "1s" and
     $container.HostConfig.LogConfig.Config["fluentd-max-retries"] == "10" and
     $container.HostConfig.LogConfig.Config["fluentd-write-timeout"] == "1s" and
     $container.HostConfig.LogConfig.Config.mode == "non-blocking" and
     $container.HostConfig.LogConfig.Config["max-buffer-size"] == "4m" and
     $container.HostConfig.LogConfig.Config["cache-disabled"] == "true" and
     ($container.Mounts | length) == 1 and
     ($container.Mounts[0].Source == $secret and $container.Mounts[0].Destination == "/run/capstone-secrets/runtime.json" and $container.Mounts[0].RW == false)' \
    <<<"${inspection}" >/dev/null
}

caddy_contract() {
  local socket_owner socket_mode listeners line
  unit_is_steady_active capstone-caddy.service || return 1
  [[ -S /run/capstone-caddy/admin.sock ]] || return 1
  socket_owner=$(stat -c '%U' /run/capstone-caddy/admin.sock) || return 1
  socket_mode=$(stat -c '%a' /run/capstone-caddy/admin.sock) || return 1
  [[ ${socket_owner} == caddy ]] || return 1
  [[ ${socket_mode} =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#${socket_mode} & 8#077) == 0 )) || return 1
  caddy validate --config /etc/capstone-chat/Caddyfile --adapter caddyfile >/dev/null || return 1
  grep -Eq '^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$' \
    /etc/systemd/system/capstone-caddy.service || return 1
  grep -Eq '^InaccessiblePaths=/srv/capstone-secure/runtime /srv/capstone-secure/migration /srv/capstone-secure/registry /srv/capstone-secure/fluent-bit$' \
    /etc/systemd/system/capstone-caddy.service || return 1
  grep -Eq '^[[:space:]]*protocols[[:space:]]+h1[[:space:]]+h2$' \
    /etc/capstone-chat/Caddyfile || return 1
  file_does_not_match '(^|[[:space:]])h3([[:space:]]|$)' /etc/capstone-chat/Caddyfile || return 1
  listeners=$(ss --tcp --listening --numeric) || return 1
  while IFS= read -r line; do
    [[ ! ${line} =~ (^|:)2019([[:space:]]|$) ]] || return 1
  done <<<"${listeners}"
  file_does_not_match \
    'flush_interval|(^|[[:space:]])log([[:space:]]|$)|(^|[[:space:]])encode([[:space:]]|$)' \
    /etc/capstone-chat/Caddyfile
}

fluent_bit_secret_schema_is_exact() {
  local path=${CAPSTONE_FLUENT_BIT_ENV_PATH} line value size lines
  [[ -f ${path} && ! -L ${path} ]] || return 1
  size=$(wc -c <"${path}") || return 1
  lines=$(awk 'END { print NR }' "${path}") || return 1
  [[ ${size} -le 1024 && ${lines} == 1 ]] || return 1
  IFS= read -r line <"${path}" || return 1
  [[ ${line} =~ ^NEW_RELIC_LICENSE_KEY=[A-Za-z0-9._-]+$ ]] || return 1
  value=${line#NEW_RELIC_LICENSE_KEY=}
  [[ ${#value} -ge 1 && ${#value} -le 512 ]]
}

fluent_bit_contract() {
  local socket_identity
  unit_is_steady_active capstone-fluent-bit.service || return 1
  [[ -S /run/capstone-fluent-bit/docker.sock ]] || return 1
  socket_identity=$(stat -c '%U:%G:%a' /run/capstone-fluent-bit/docker.sock) || return 1
  [[ ${socket_identity} == capstone-fluent-bit:capstone-fluent-bit-secrets:660 ]] &&
    grep -Eq '^ExecStart=/opt/capstone-chat/bin/start-fluent-bit\.sh$' /etc/systemd/system/capstone-fluent-bit.service &&
    file_does_not_match '^EnvironmentFile=' /etc/systemd/system/capstone-fluent-bit.service &&
    file_exact "${CAPSTONE_FLUENT_BIT_ENV_PATH}" root capstone-fluent-bit-secrets 440 &&
    fluent_bit_secret_schema_is_exact &&
    grep -Eq '^[[:space:]]*Buffer_Max_Size[[:space:]]+16K$' /etc/capstone-chat/fluent-bit.conf &&
    grep -Eq '^[[:space:]]*Mem_Buf_Limit[[:space:]]+8M$' /etc/capstone-chat/fluent-bit.conf &&
    grep -Eq '^[[:space:]]*storage\.type[[:space:]]+memory$' /etc/capstone-chat/fluent-bit.conf &&
    grep -Eq '^[[:space:]]*Reserve_Data[[:space:]]+Off$' /etc/capstone-chat/fluent-bit.conf &&
    grep -Eq '^[[:space:]]*Name[[:space:]]+record_modifier$' /etc/capstone-chat/fluent-bit.conf &&
    grep -Eq '^[[:space:]]*Retry_Limit[[:space:]]+10$' /etc/capstone-chat/fluent-bit.conf &&
    grep -Eq '^[[:space:]]*Remove[[:space:]]+log$' /etc/capstone-chat/fluent-bit.conf &&
    grep -Eq '^[[:space:]]*Format[[:space:]]+json$' /etc/capstone-chat/fluent-bit.conf &&
    grep -Eq '^[[:space:]]*Name[[:space:]]+capstone_json$' /etc/capstone-chat/fluent-bit-parsers.conf &&
    file_does_not_match \
      'storage\.path|filesystem|^[[:space:]]*Name[[:space:]]+newrelic' \
      /etc/capstone-chat/fluent-bit.conf
}

version_contract() {
  local docker_version caddy_version fluent_version
  docker_version=$(docker version --format '{{.Server.Version}}') || return 1
  caddy_version=$(caddy version | awk '{ print $1 }') || return 1
  fluent_version=$(/opt/fluent-bit/bin/fluent-bit --version |
    awk 'NR == 1 { print $3 }') || return 1
  [[ ${docker_version} == "${CAPSTONE_EXPECTED_DOCKER_VERSION}" ]] &&
    [[ ${caddy_version} == "${CAPSTONE_EXPECTED_CADDY_VERSION}" ]] &&
    [[ ${fluent_version} == "${CAPSTONE_EXPECTED_FLUENT_BIT_VERSION}" ]]
}

public_readiness() {
  local release revision headers count value
  release=$(readlink --canonicalize-existing "${ACTIVE_LINK}") || return 1
  revision=$(jq --exit-status --raw-output .revision "${release}/release.json") || return 1
  headers=$(mktemp /run/capstone-chat/verify-headers.XXXXXX) || return 1
  if ! curl --fail --silent --show-error --dump-header "${headers}" --output /dev/null --max-time 5 \
    --resolve "${CAPSTONE_PUBLIC_HOST}:443:127.0.0.1" \
    "https://${CAPSTONE_PUBLIC_HOST}/api/health/ready"; then
    rm -f "${headers}"
    return 1
  fi
  count=$(awk 'tolower($1) == "x-capstone-revision:" { count += 1 } END { print count + 0 }' \
    "${headers}") || {
    rm -f "${headers}"
    return 1
  }
  value=$(awk 'tolower($1) == "x-capstone-revision:" { sub(/^[^:]+:[[:space:]]*/, ""); gsub(/\r/, ""); print }' \
    "${headers}") || {
    rm -f "${headers}"
    return 1
  }
  rm -f "${headers}" || return 1
  [[ ${count} -eq 1 && ${value} == "${revision}" ]]
}

candidate_compute_is_exact() {
  local processors memory_kib
  processors=$(nproc) || return 1
  memory_kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo) || return 1
  [[ ${processors} == 1 ]] || return 1
  [[ ${memory_kib} =~ ^[0-9]+$ ]] || return 1
  [[ ${memory_kib} -ge 850000 && ${memory_kib} -le 1150000 ]]
}

main() {
  [[ ${EUID} -eq 0 ]] || {
    printf 'verify-host must run through sudo\n' >&2
    exit 1
  }
  file_exact "${HOST_ENV}" root root 640 || {
    printf 'host contract is missing or unsafe\n' >&2
    exit 1
  }
  if ! file_does_not_match '__[A-Z0-9_]+__' "${HOST_ENV}"; then
    printf 'host contract still contains a placeholder\n' >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  source "${HOST_ENV}"

  check "GHCR image repository is the approved Capstone package" image_repository_is_exact
  check "Ubuntu 24.04 LTS" bash -c '. /etc/os-release && [[ $ID == ubuntu && $VERSION_ID == 24.04 ]]'
  check "candidate compute remains one vCPU inside the 1 GiB memory class" candidate_compute_is_exact
  check "runtime providers and region match the exact environment contract" runtime_contract_is_exact
  check "Droplet metadata matches the expected contract region" region_matches_host_contract
  check "encrypted Volume is distinct and nodev,nosuid,noexec" mount_is_restricted_volume
  check "encrypted Volume is exactly 1 GiB" volume_has_exact_size
  check "secure Volume directories preserve exact cross-read boundaries" secure_directories_are_exact
  check "service identities cannot cross-read another boundary's secrets" service_identities_cannot_cross_read
  check "swap is disabled" no_active_swap
  check "public IPv6 is disabled" ipv6_is_disabled
  check "host core dumps are disabled" core_dumps_are_disabled
  check "host clock is synchronized in UTC" utc_clock_is_synchronized
  check "only the operator has an ordinary interactive account" only_operator_has_interactive_shell
  check "no ordinary user belongs to the docker group" no_ordinary_docker_group_member
  check "operator sudo is restricted to three audited root-owned paths" operator_sudo_boundary_is_exact
  check "service identities have only their fixed private groups" service_identities_are_exact
  check "distribution proxy and log units remain masked" distribution_units_are_masked
  check "UFW exposes only 80/443 and operator-restricted SSH" ufw_contract
  check "default route uses the DigitalOcean anchor gateway" default_route_uses_anchor_gateway
  check "external observation sees the reserved IPv4" outbound_source_is_reserved
  check "TCP listeners are exactly SSH, HTTP/S, one loopback app, and Ubuntu DNS stubs" tcp_listener_allowlist_is_exact
  check "runtime secret is isolated" file_exact "${CAPSTONE_RUNTIME_SECRET_PATH}" root capstone-runtime-secrets 440
  check "runtime secret matches the exact environment schema" runtime_secret_schema_is_exact
  check "migration secret is isolated" file_exact "${CAPSTONE_MIGRATION_SECRET_PATH}" root capstone-migration-secrets 440
  check "migration secret contains only its database credential" migration_secret_schema_is_exact
  check "registry credential is root-only" file_exact "${CAPSTONE_REGISTRY_CONFIG_DIR}/config.json" root root 400
  check "installed host artifacts have exact ownership and modes" installed_artifacts_are_exact
  check "ephemeral operator boundary is idle and clean" operator_boundary_is_idle
  check "all-state application and migration container inventory is exact" managed_container_inventory_is_exact
  check "Caddy boundary is active and non-buffering" caddy_contract
  check "Fluent Bit path is bounded and memory-only" fluent_bit_contract
  check "installed runtime versions match reviewed pins" version_contract
  check "exactly one application slot is active" one_active_slot
  check "active release symlink, metadata, and container labels agree" active_release_is_valid
  check "active container restrictions and logging options are exact" container_contract
  check "custom-origin readiness succeeds through Caddy" public_readiness

  if [[ ${failures} -ne 0 ]]; then
    printf '%s host verification check(s) failed\n' "${failures}" >&2
    exit 1
  fi
  printf 'All content-free host verification checks passed.\n'
}

if [[ ${CAPSTONE_VERIFY_HOST_TEST_SOURCE:-0} == 1 ]]; then
  [[ ${BASH_SOURCE[0]} != "$0" ]] || {
    printf 'test-source mode requires sourcing verify-host.sh\n' >&2
    exit 1
  }
else
  main "$@"
fi
