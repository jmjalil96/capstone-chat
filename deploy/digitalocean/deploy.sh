#!/usr/bin/env bash
set -Eeuo pipefail

readonly HOST_ENV=/etc/capstone-chat/host.env
readonly STATE_ROOT=/var/lib/capstone-chat
readonly RELEASE_ROOT="${STATE_ROOT}/releases"
readonly EVIDENCE_ROOT="${STATE_ROOT}/ci-evidence"
readonly RECOVERY_PIN_ROOT="${STATE_ROOT}/recovery-pins"
readonly SHUTDOWN_EVIDENCE_ROOT="${STATE_ROOT}/shutdown-failures"
readonly ACTIVE_LINK="${STATE_ROOT}/active"
readonly MAINTENANCE_MARKER="${STATE_ROOT}/maintenance"
readonly RUNTIME_ROOT=/run/capstone-chat
readonly CADDY_RUNTIME_ROOT=/run/capstone-caddy
readonly REQUEST_PATH=/run/capstone-deploy/request.json
readonly DEPLOY_LOCK="${STATE_ROOT}/deploy.lock"
readonly MIGRATION_CLEANUP=/opt/capstone-chat/bin/cleanup-migrations.sh
readonly MINIMUM_AVAILABLE_MEMORY_KIB=262144
readonly MINIMUM_AVAILABLE_DISK_KIB=524288

candidate_release=""
candidate_slot=""
candidate_created=0
durable_commit=0
operation=""
request_revision=""
request_digest=""
active_child_pid=""
interrupted_status=0

log() {
  printf 'capstone-deploy: %s\n' "$1"
}

record_activation_evidence() {
  [[ $# -eq 1 ]] || return 1
  local release=$1 activated_at revision digest
  activated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return 1
  revision=$(release_field "${release}" revision) || return 1
  digest=$(release_field "${release}" digest) || return 1
  [[ ${activated_at} =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  [[ ${revision} =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ ${digest} =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  log "activation-evidence schema=1 activatedAt=${activated_at} revision=${revision} digest=${digest}"
}

fail() {
  printf 'capstone-deploy: %s\n' "$1" >&2
  return 1
}

interrupt_active_child() {
  local requested_status=$1
  interrupted_status=${requested_status}
  trap '' INT TERM
  if [[ -z ${active_child_pid} ]]; then
    exit "${requested_status}"
  fi

  kill -TERM -- "-${active_child_pid}" >/dev/null 2>&1 || true
  local attempt
  for attempt in $(seq 1 300); do
    kill -0 "${active_child_pid}" >/dev/null 2>&1 || break
    sleep 0.1
  done
  if kill -0 "${active_child_pid}" >/dev/null 2>&1; then
    kill -KILL -- "-${active_child_pid}" >/dev/null 2>&1 || true
  fi
}

run_interruptible() {
  [[ -z ${active_child_pid} ]] || fail "an interruptible deployment child is already active"
  interrupted_status=0
  python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" &
  active_child_pid=$!
  local child_status=0
  wait "${active_child_pid}" || child_status=$?
  active_child_pid=""
  if [[ ${interrupted_status} -ne 0 ]]; then
    return "${interrupted_status}"
  fi
  return "${child_status}"
}

capture_interruptible() {
  [[ $# -ge 2 ]] || return 1
  local output=$1
  shift
  rm -f "${output}"
  umask 0077
  run_interruptible "$@" >"${output}"
}

capture_value_interruptible() {
  [[ $# -ge 2 ]] || return 1
  local destination=$1 output value status=0
  shift
  output=$(mktemp "${RUNTIME_ROOT}/capture.XXXXXX") || return 1
  capture_interruptible "${output}" "$@" || status=$?
  if [[ ${status} -ne 0 ]]; then
    rm -f "${output}"
    return "${status}"
  fi
  value=$(<"${output}")
  rm -f "${output}"
  printf -v "${destination}" '%s' "${value}"
}

inspect_container_if_present() {
  [[ $# -eq 2 ]] || return 1
  local destination=$1 name=$2 ids inspection
  [[ ${name} =~ ^capstone-[a-z0-9-]+$ ]] || return 1
  capture_value_interruptible ids timeout --signal=TERM --kill-after=5s 15s \
    docker ps --all --quiet --filter "name=^/${name}$" || return 1
  [[ -n ${ids} ]] || return 2
  [[ ${ids} =~ ^[0-9a-f]{12,64}$ ]] || return 1
  capture_value_interruptible inspection timeout --signal=TERM --kill-after=5s 15s \
    docker inspect "${ids}" || return 1
  printf -v "${destination}" '%s' "${inspection}"
}

require_root_regular() {
  local path=$1
  [[ -f ${path} && ! -L ${path} ]] || {
    fail "required regular file is missing"
    return 1
  }
  [[ $(stat -c '%U:%G' "${path}") == root:root ]] || {
    fail "required file is not root-owned"
    return 1
  }
  local mode
  mode=$(stat -c '%a' "${path}")
  (( (8#${mode} & 8#022) == 0 )) || {
    fail "required file is writable by group or other"
    return 1
  }
}

fsync_directory() {
  python3 - "$1" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

acquire_deployment_lock() {
  flock --exclusive --nonblock 9 ||
    fail "another deploy, rollback, migration, or recovery operation holds the lock"
}

remove_stale_atomic_state() {
  local temporary_active="${STATE_ROOT}/active.new"
  if [[ -e ${temporary_active} || -L ${temporary_active} ]]; then
    [[ -L ${temporary_active} ]] || fail "stale active replacement is not a symlink"
    rm -f "${temporary_active}"
  fi

  local staging
  shopt -s nullglob
  for staging in "${RELEASE_ROOT}"/.[0-9a-f]*.*; do
    [[ ${staging} =~ ^${RELEASE_ROOT}/\.[0-9a-f]{40}\.[A-Za-z0-9]{6}$ ]] ||
      fail "unexpected hidden release state"
    [[ -d ${staging} && ! -L ${staging} && $(stat -c '%U:%G' "${staging}") == root:root ]] ||
      fail "stale release staging directory is unsafe"
    find "${staging}" -depth -delete
  done
  shopt -u nullglob
  fsync_directory "${STATE_ROOT}"
  fsync_directory "${RELEASE_ROOT}"
}

load_host_contract() {
  require_root_regular "${HOST_ENV}"
  [[ $(stat -c '%a' "${HOST_ENV}") == 640 ]] || fail "host contract must be mode 0640"
  if grep -Eq '__[A-Z0-9_]+__' "${HOST_ENV}"; then
    fail "host contract still contains a provisioning placeholder"
  fi

  # The installed file is a reviewed, immutable, root-owned non-secret contract.
  # shellcheck disable=SC1091
  source "${HOST_ENV}"

  case "${CAPSTONE_NODE_ENV:-}" in
    production)
      [[ ${CAPSTONE_PUBLIC_HOST:-} == chat.capstone.com.ec ]] || fail "production host must use the approved public hostname"
      [[ ${CAPSTONE_EMAIL_DELIVERY:-} == resend && ${CAPSTONE_MODEL_GATEWAY:-} == openrouter ]] ||
        fail "production providers changed"
      [[ ${CAPSTONE_EXPECTED_REGION:-} == ric1 ]] || fail "production DigitalOcean region changed"
      ;;
    test)
      [[ ${CAPSTONE_EMAIL_DELIVERY:-} == disabled && ${CAPSTONE_MODEL_GATEWAY:-} == fake ]] ||
        fail "managed rehearsal providers are unsafe"
      [[ ${CAPSTONE_EXPECTED_REGION:-} == nyc3 ]] || fail "managed rehearsal must use the approved NYC3 region"
      [[ -n ${CAPSTONE_PUBLIC_HOST:-} && ${CAPSTONE_PUBLIC_HOST} != chat.capstone.com.ec ]] ||
        fail "managed rehearsal requires a non-production hostname"
      ;;
    *) fail "host runtime must be production or the explicit managed test rehearsal" ;;
  esac
  [[ ${CAPSTONE_PUBLIC_ORIGIN:-} == "https://${CAPSTONE_PUBLIC_HOST:-}" ]] ||
    fail "public origin and Caddy hostname disagree"
  [[ ${CAPSTONE_CLIENT_ADDRESS_SOURCE:-} == caddy ]] || fail "Caddy address mode is required"
  [[ ${CAPSTONE_OTEL_EXPORTER_OTLP_ENDPOINT:-} == https://otlp.nr-data.net ]] ||
    fail "New Relic OTLP endpoint changed"
  [[ ${CAPSTONE_EXPECTED_OUTBOUND_IPV4:-} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
    fail "expected reserved IPv4 is invalid"
  [[ ${CAPSTONE_OPERATOR_IPV4_CIDR:-} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]] ||
    fail "operator SSH source must be one IPv4 /32"
  local address octet
  local -a octets
  for address in "${CAPSTONE_EXPECTED_OUTBOUND_IPV4}" "${CAPSTONE_OPERATOR_IPV4_CIDR%/32}"; do
    IFS=. read -r -a octets <<<"${address}"
    [[ ${#octets[@]} -eq 4 ]] || fail "host IPv4 contract is invalid"
    for octet in "${octets[@]}"; do
      [[ ${octet} =~ ^(0|[1-9][0-9]{0,2})$ && ${octet} -le 255 ]] ||
        fail "host IPv4 contract is invalid"
    done
  done
  [[ ${CAPSTONE_EXPECTED_VOLUME_BYTES:-} == 1073741824 ]] || fail "encrypted Volume size changed"
  [[ ${CAPSTONE_IMAGE_REPOSITORY:-} =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*/capstone-chat$ ]] ||
    fail "GHCR repository is invalid"
  [[ ${CAPSTONE_SECURE_ROOT:-} == /srv/capstone-secure ]] || fail "secure Volume path changed"
  [[ ${CAPSTONE_RUNTIME_SECRET_PATH:-} == /srv/capstone-secure/runtime/runtime.json ]] ||
    fail "runtime secret path changed"
  [[ ${CAPSTONE_MIGRATION_SECRET_PATH:-} == /srv/capstone-secure/migration/migration.json ]] ||
    fail "migration secret path changed"
  [[ ${CAPSTONE_REGISTRY_CONFIG_DIR:-} == /srv/capstone-secure/registry ]] ||
    fail "registry credential path changed"
  [[ ${CAPSTONE_CADDY_STATE_DIR:-} == /srv/capstone-secure/caddy ]] || fail "Caddy state path changed"
  [[ ${CAPSTONE_FLUENT_BIT_ENV_PATH:-} == /srv/capstone-secure/fluent-bit/new-relic.env ]] ||
    fail "Fluent Bit secret path changed"
  [[ ${CAPSTONE_RUNTIME_SECRET_GID:-} == 21001 ]] || fail "runtime secret group changed"
  [[ ${CAPSTONE_MIGRATION_SECRET_GID:-} == 21002 ]] || fail "migration secret group changed"
  [[ ${CAPSTONE_CADDY_SECRET_GID:-} == 21003 ]] || fail "Caddy state group changed"
  [[ ${CAPSTONE_FLUENT_BIT_SECRET_GID:-} == 21004 ]] || fail "Fluent Bit secret group changed"
}

mount_field() {
  findmnt --noheadings --output "$2" --target "$1"
}

block_device_size_bytes() {
  local identity=$1 sectors
  [[ ${identity} =~ ^[0-9]+:[0-9]+$ ]] || return 1
  [[ -r /sys/dev/block/${identity}/size ]] || return 1
  sectors=$(<"/sys/dev/block/${identity}/size")
  [[ ${sectors} =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$((sectors * 512))"
}

validate_secure_mount() {
  local target options root_identity secure_identity secure_size
  target=$(mount_field "${CAPSTONE_SECURE_ROOT}" TARGET)
  options=$(mount_field "${CAPSTONE_SECURE_ROOT}" OPTIONS)
  root_identity=$(mount_field / MAJ:MIN)
  secure_identity=$(mount_field "${CAPSTONE_SECURE_ROOT}" MAJ:MIN)
  [[ ${target} == "${CAPSTONE_SECURE_ROOT}" ]] || {
    fail "encrypted Volume is not a distinct mount"
    return 1
  }
  [[ ${root_identity} =~ ^[0-9]+:[0-9]+$ && ${secure_identity} =~ ^[0-9]+:[0-9]+$ &&
    ${secure_identity} != "${root_identity}" ]] || {
    fail "secure root resolves to the Droplet root block device"
    return 1
  }
  secure_size=$(block_device_size_bytes "${secure_identity}") || {
    fail "secure Volume size could not be read from sysfs"
    return 1
  }
  [[ ${secure_size} == "${CAPSTONE_EXPECTED_VOLUME_BYTES}" ]] || {
    fail "secure Volume size changed"
    return 1
  }
  for option in nodev nosuid noexec; do
    [[ ,${options}, == *,${option},* ]] || {
      fail "encrypted Volume lacks required mount restriction"
      return 1
    }
  done
}

validate_secret_file() {
  local path=$1
  local expected_gid=$2
  [[ -f ${path} && ! -L ${path} ]] || fail "required secret file is missing or unsafe"
  [[ $(stat -c '%u' "${path}") == 0 ]] || fail "secret file must be root-owned"
  [[ $(stat -c '%g' "${path}") == "${expected_gid}" ]] || fail "secret file group is incorrect"
  [[ $(stat -c '%a' "${path}") == 440 ]] || fail "secret file must be mode 0440"
}

validate_runtime_secret_file() {
  local path=$1 expected_gid=$2
  validate_secret_file "${path}" "${expected_gid}" || return 1
  case "${CAPSTONE_NODE_ENV}" in
    production)
      jq --exit-status \
        'keys == ["BETTER_AUTH_SECRET", "DATABASE_URL", "OPENROUTER_API_KEY", "OTEL_EXPORTER_OTLP_HEADERS", "RESEND_API_KEY"] and
         all(.[]; type == "string" and length > 0)' \
        "${path}" >/dev/null || {
        fail "production runtime secret schema is invalid"
        return 1
      }
      ;;
    test)
      jq --exit-status \
        'keys == ["BETTER_AUTH_SECRET", "DATABASE_URL", "OTEL_EXPORTER_OTLP_HEADERS"] and
         all(.[]; type == "string" and length > 0)' \
        "${path}" >/dev/null || {
        fail "managed rehearsal runtime secret schema is invalid"
        return 1
      }
      ;;
    *) fail "runtime secret validation requires an approved environment" ;;
  esac
}

validate_migration_secret_file() {
  local path=$1 expected_gid=$2
  validate_secret_file "${path}" "${expected_gid}" || return 1
  jq --exit-status \
    'keys == ["DATABASE_URL"] and (.DATABASE_URL | type == "string" and length > 0)' \
    "${path}" >/dev/null || {
    fail "migration secret must contain only DATABASE_URL"
    return 1
  }
}

validate_registry_config() {
  local config_path="${CAPSTONE_REGISTRY_CONFIG_DIR}/config.json"
  [[ -d ${CAPSTONE_REGISTRY_CONFIG_DIR} && ! -L ${CAPSTONE_REGISTRY_CONFIG_DIR} ]] ||
    fail "registry configuration directory is missing or unsafe"
  [[ $(stat -c '%u:%g:%a' "${CAPSTONE_REGISTRY_CONFIG_DIR}") == 0:0:700 ]] ||
    fail "registry configuration directory must be root-only"
  [[ -f ${config_path} && ! -L ${config_path} ]] || fail "registry pull configuration is missing"
  [[ $(stat -c '%u:%g:%a' "${config_path}") == 0:0:400 ]] ||
    fail "registry pull configuration must be root-only"
}

validate_outbound_route() {
  local route gateway="" anchor_gateway
  anchor_gateway=$(curl --fail --silent --show-error --max-time 3 \
    http://169.254.169.254/metadata/v1/interfaces/public/0/anchor_ipv4/gateway)
  [[ ${anchor_gateway} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
    fail "DigitalOcean anchor gateway metadata is invalid"
  route=$(ip -4 route show default)
  gateway=$(awk '{ for (index = 1; index <= NF; index += 1) if ($index == "via") { print $(index + 1); exit } }' <<<"${route}")
  [[ ${gateway} == "${anchor_gateway}" ]] ||
    fail "default route does not use the persistent reserved-IP anchor gateway"
}

validate_external_outbound_source() {
  local observed
  observed=$(curl --fail --silent --show-error --max-time 5 https://icanhazip.com/ | tr -d '[:space:]')
  [[ ${observed} == "${CAPSTONE_EXPECTED_OUTBOUND_IPV4}" ]] ||
    fail "external observation does not see the reserved outbound IPv4"
}

validate_runtime_prerequisites() {
  validate_runtime_secret_file "${CAPSTONE_RUNTIME_SECRET_PATH}" "${CAPSTONE_RUNTIME_SECRET_GID}" ||
    return 1
  validate_outbound_route || return 1
}

validate_headroom() {
  local available_memory available_disk
  available_memory=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
  available_disk=$(df --output=avail "${STATE_ROOT}" | tail -n 1 | tr -d ' ')
  [[ ${available_memory} =~ ^[0-9]+$ && ${available_memory} -ge ${MINIMUM_AVAILABLE_MEMORY_KIB} ]] ||
    fail "host does not have the required deployment memory headroom"
  [[ ${available_disk} =~ ^[0-9]+$ && ${available_disk} -ge ${MINIMUM_AVAILABLE_DISK_KIB} ]] ||
    fail "host does not have the required deployment disk headroom"
}

release_field() {
  jq --exit-status --raw-output ".$2" "$1/release.json"
}

write_upstream_fragment() {
  local port=$1
  local output=$2
  cat >"${output}" <<EOF
	reverse_proxy 127.0.0.1:${port} {
	header_up -Forwarded
	header_up -X-Forwarded-*
	header_up -CF-Connecting-IP
	header_up -X-Capstone-Client-IP
	header_up X-Capstone-Client-IP {http.request.remote.host}
	transport http {
		compression off
	}
}
EOF
}

validate_release() {
  local release=$1
  [[ ${release} =~ ^${RELEASE_ROOT}/[0-9a-f]{40}$ ]] || {
    fail "release path escaped the release root"
    return 1
  }
  [[ -d ${release} && ! -L ${release} ]] || {
    fail "release directory is missing or unsafe"
    return 1
  }
  require_root_regular "${release}/release.json" || return 1
  require_root_regular "${release}/upstream.caddy" || return 1
  [[ $(stat -c '%a' "${release}") == 550 ]] || {
    fail "release directory is mutable"
    return 1
  }
  [[ $(stat -c '%a' "${release}/release.json") == 440 ]] || {
    fail "release metadata is mutable"
    return 1
  }
  [[ $(stat -c '%a' "${release}/upstream.caddy") == 440 ]] || {
    fail "release upstream is mutable"
    return 1
  }

  jq --exit-status \
    'keys == ["createdAt", "digest", "image", "port", "previousCompatible", "previousRelease", "revision", "schema", "slot"] and
     .schema == 1 and (.revision | type == "string") and (.digest | type == "string") and
     (.image | type == "string") and (.slot | type == "string") and (.port | type == "number") and
     (.previousRelease | type == "string") and (.previousCompatible | type == "boolean") and
     (.createdAt | type == "string") and
     (.createdAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' \
    "${release}/release.json" >/dev/null || {
    fail "release metadata schema is invalid"
    return 1
  }

  local revision digest image slot port previous expected_fragment
  revision=$(release_field "${release}" revision) || return 1
  digest=$(release_field "${release}" digest) || return 1
  image=$(release_field "${release}" image) || return 1
  slot=$(release_field "${release}" slot) || return 1
  port=$(release_field "${release}" port) || return 1
  previous=$(release_field "${release}" previousRelease) || return 1

  [[ ${revision} =~ ^[0-9a-f]{40}$ ]] || {
    fail "release revision is invalid"
    return 1
  }
  [[ ${release} == "${RELEASE_ROOT}/${revision}" ]] || {
    fail "release path and revision disagree"
    return 1
  }
  [[ ${digest} =~ ^sha256:[0-9a-f]{64}$ ]] || {
    fail "release digest is invalid"
    return 1
  }
  [[ ${image} == "${CAPSTONE_IMAGE_REPOSITORY}@${digest}" ]] || {
    fail "release image is mutable or foreign"
    return 1
  }
  case "${slot}:${port}" in
    a:3001 | b:3002) ;;
    *)
      fail "release slot and loopback port disagree"
      return 1
      ;;
  esac
  if [[ ${previous} != "" ]]; then
    [[ ${previous} =~ ^${RELEASE_ROOT}/[0-9a-f]{40}$ && ${previous} != "${release}" ]] || {
      fail "previous release reference is invalid"
      return 1
    }
  fi

  expected_fragment=$(mktemp "${RUNTIME_ROOT}/upstream-check.XXXXXX")
  write_upstream_fragment "${port}" "${expected_fragment}"
  if ! cmp --silent "${expected_fragment}" "${release}/upstream.caddy"; then
    rm -f "${expected_fragment}"
    fail "release upstream fragment is not canonical"
    return 1
  fi
  rm -f "${expected_fragment}"
}

active_release() {
  if [[ ! -e ${ACTIVE_LINK} && ! -L ${ACTIVE_LINK} ]]; then
    return 1
  fi
  [[ -L ${ACTIVE_LINK} ]] || {
    fail "active release authority is not a symlink"
    return 2
  }
  local resolved
  resolved=$(readlink --canonicalize-existing "${ACTIVE_LINK}") || {
    fail "active release symlink is broken"
    return 2
  }
  validate_release "${resolved}" || return 2
  printf '%s\n' "${resolved}"
}

write_slot_environment() {
  local release=$1
  local slot port revision digest image temporary target
  slot=$(release_field "${release}" slot)
  port=$(release_field "${release}" port)
  revision=$(release_field "${release}" revision)
  digest=$(release_field "${release}" digest)
  image=$(release_field "${release}" image)
  target="${RUNTIME_ROOT}/slot-${slot}.env"
  temporary=$(mktemp "${RUNTIME_ROOT}/slot-${slot}.XXXXXX") || return 1
  cat >"${temporary}" <<EOF
CAPSTONE_NODE_ENV=${CAPSTONE_NODE_ENV}
CAPSTONE_PORT=${port}
CAPSTONE_PUBLIC_ORIGIN=${CAPSTONE_PUBLIC_ORIGIN}
CAPSTONE_CLIENT_ADDRESS_SOURCE=${CAPSTONE_CLIENT_ADDRESS_SOURCE}
CAPSTONE_EMAIL_DELIVERY=${CAPSTONE_EMAIL_DELIVERY}
CAPSTONE_EMAIL_FROM="${CAPSTONE_EMAIL_FROM}"
CAPSTONE_MODEL_GATEWAY=${CAPSTONE_MODEL_GATEWAY}
CAPSTONE_OTEL_EXPORTER_OTLP_ENDPOINT=${CAPSTONE_OTEL_EXPORTER_OTLP_ENDPOINT}
CAPSTONE_REVISION=${revision}
CAPSTONE_DIGEST=${digest}
CAPSTONE_IMAGE=${image}
EOF
  chown root:root "${temporary}" || return 1
  chmod 0600 "${temporary}" || return 1
  mv -fT "${temporary}" "${target}" || return 1
  fsync_directory "${RUNTIME_ROOT}" || return 1
}

slot_matches_release() {
  local release=$1
  local slot revision digest inspection
  slot=$(release_field "${release}" slot)
  revision=$(release_field "${release}" revision)
  digest=$(release_field "${release}" digest)
  systemctl is-active --quiet "capstone-chat@${slot}.service" || return 1
  inspect_container_if_present inspection "capstone-chat-${slot}" || return 1
  jq --exit-status --arg revision "${revision}" --arg digest "${digest}" \
    '.[0].State.Running == true and
     .[0].Config.Labels["io.capstone.revision"] == $revision and
     .[0].Config.Labels["io.capstone.digest"] == $digest' \
    <<<"${inspection}" >/dev/null
}

http_revision_is() {
  local expected=$1
  shift
  local headers count value
  headers=$(mktemp "${RUNTIME_ROOT}/response-headers.XXXXXX")
  if ! curl --dump-header "${headers}" --output /dev/null "$@"; then
    rm -f "${headers}"
    return 1
  fi
  count=$(awk 'tolower($1) == "x-capstone-revision:" { count += 1 } END { print count + 0 }' "${headers}")
  value=$(awk 'tolower($1) == "x-capstone-revision:" { sub(/^[^:]+:[[:space:]]*/, ""); gsub(/\r/, ""); print }' "${headers}")
  rm -f "${headers}"
  [[ ${count} -eq 1 && ${value} == "${expected}" ]]
}

static_application_is_served() {
  local url=$1
  local max_time=$2
  shift 2
  local headers body status content_type cache_control_count cache_control
  headers=$(mktemp "${RUNTIME_ROOT}/static-headers.XXXXXX")
  body=$(mktemp "${RUNTIME_ROOT}/static-body.XXXXXX")
  if ! status=$(curl --silent --show-error --dump-header "${headers}" --output "${body}" \
    --write-out '%{http_code}' --max-time "${max_time}" "$@" "${url}"); then
    rm -f "${headers}" "${body}"
    return 1
  fi
  content_type=$(awk 'tolower($1) == "content-type:" { sub(/^[^:]+:[[:space:]]*/, ""); gsub(/\r/, ""); print }' "${headers}")
  cache_control_count=$(awk 'tolower($1) == "cache-control:" { count += 1 } END { print count + 0 }' "${headers}")
  cache_control=$(awk 'tolower($1) == "cache-control:" { sub(/^[^:]+:[[:space:]]*/, ""); gsub(/\r/, ""); print }' "${headers}")
  local valid=0
  if [[ ${status} == 200 && ${content_type,,} == text/html* && ${cache_control_count} -eq 1 && ${cache_control,,} == no-cache ]] &&
    grep -Fq '<div id="root"></div>' "${body}"; then
    valid=1
  fi
  rm -f "${headers}" "${body}"
  [[ ${valid} -eq 1 ]]
}

anonymous_session_is_rejected() {
  local url=$1
  local max_time=$2
  shift 2
  local headers body status cache_control_count cache_control
  headers=$(mktemp "${RUNTIME_ROOT}/session-headers.XXXXXX")
  body=$(mktemp "${RUNTIME_ROOT}/session-body.XXXXXX")
  if ! status=$(curl --silent --show-error --dump-header "${headers}" --output "${body}" \
    --write-out '%{http_code}' --max-time "${max_time}" "$@" "${url}"); then
    rm -f "${headers}" "${body}"
    return 1
  fi
  cache_control_count=$(awk 'tolower($1) == "cache-control:" { count += 1 } END { print count + 0 }' "${headers}")
  cache_control=$(awk 'tolower($1) == "cache-control:" { sub(/^[^:]+:[[:space:]]*/, ""); gsub(/\r/, ""); print }' "${headers}")
  local valid=0
  if [[ ${status} == 401 && ${cache_control_count} -eq 1 && ${cache_control,,} == no-store ]] &&
    jq --exit-status \
      'keys == ["code", "message", "requestId"] and .code == "AUTHENTICATION_REQUIRED" and
       (.message | type == "string" and length > 0) and (.requestId | type == "string" and length > 0)' \
      "${body}" >/dev/null; then
    valid=1
  fi
  rm -f "${headers}" "${body}"
  [[ ${valid} -eq 1 ]]
}

verify_direct_smoke() {
  local release=$1
  local deadline=$2
  local port revision remaining bound
  port=$(release_field "${release}" port)
  revision=$(release_field "${release}" revision)
  remaining=$((deadline - SECONDS)); [[ ${remaining} -gt 0 ]] || return 1
  bound=$((remaining < 2 ? remaining : 2))
  http_revision_is "${revision}" --fail --silent --show-error --max-time "${bound}" \
    "http://127.0.0.1:${port}/api/health/live" || return 1
  remaining=$((deadline - SECONDS)); [[ ${remaining} -gt 0 ]] || return 1
  bound=$((remaining < 2 ? remaining : 2))
  http_revision_is "${revision}" --fail --silent --show-error --max-time "${bound}" \
    "http://127.0.0.1:${port}/api/health/ready" || return 1
  remaining=$((deadline - SECONDS)); [[ ${remaining} -gt 0 ]] || return 1
  bound=$((remaining < 5 ? remaining : 5))
  static_application_is_served "http://127.0.0.1:${port}/" "${bound}" || return 1
  remaining=$((deadline - SECONDS)); [[ ${remaining} -gt 0 ]] || return 1
  bound=$((remaining < 5 ? remaining : 5))
  anonymous_session_is_rejected "http://127.0.0.1:${port}/api/session" "${bound}" \
    --header 'X-Capstone-Client-IP: 192.0.2.1'
}

verify_public_smoke() {
  local release=$1
  local revision deadline remaining bound
  revision=$(release_field "${release}" revision)
  deadline=$((SECONDS + 20))
  local -a origin=(--resolve "${CAPSTONE_PUBLIC_HOST}:443:127.0.0.1")
  remaining=$((deadline - SECONDS)); [[ ${remaining} -gt 0 ]] || return 1
  bound=$((remaining < 5 ? remaining : 5))
  http_revision_is "${revision}" --fail --silent --show-error --max-time "${bound}" \
    "${origin[@]}" "https://${CAPSTONE_PUBLIC_HOST}/api/health/ready" || return 1
  remaining=$((deadline - SECONDS)); [[ ${remaining} -gt 0 ]] || return 1
  bound=$((remaining < 5 ? remaining : 5))
  static_application_is_served "https://${CAPSTONE_PUBLIC_HOST}/" "${bound}" "${origin[@]}" || return 1
  remaining=$((deadline - SECONDS)); [[ ${remaining} -gt 0 ]] || return 1
  bound=$((remaining < 5 ? remaining : 5))
  anonymous_session_is_rejected "https://${CAPSTONE_PUBLIC_HOST}/api/session" "${bound}" "${origin[@]}"
}

wait_for_readiness() {
  local release=$1
  local window_seconds=${2:-60}
  local port revision
  port=$(release_field "${release}" port)
  revision=$(release_field "${release}" revision)
  local deadline=$((SECONDS + window_seconds)) remaining bound
  while [[ ${SECONDS} -lt ${deadline} ]]; do
    remaining=$((deadline - SECONDS))
    bound=$((remaining < 2 ? remaining : 2))
    if http_revision_is "${revision}" --fail --silent --show-error --max-time "${bound}" \
      "http://127.0.0.1:${port}/api/health/live" &&
      [[ ${SECONDS} -lt ${deadline} ]] &&
      http_revision_is "${revision}" --fail --silent --show-error --max-time \
        "$((deadline - SECONDS < 2 ? deadline - SECONDS : 2))" \
        "http://127.0.0.1:${port}/api/health/ready"; then
      verify_direct_smoke "${release}" "${deadline}" || {
        fail "candidate direct static/API/session smoke failed"
        return 1
      }
      return 0
    fi
    [[ ${SECONDS} -lt ${deadline} ]] && sleep 1
  done
  fail "candidate did not become ready inside 60 seconds"
}

start_release() {
  local release=$1
  local start_mode=${2:-strict}
  local slot cleanup_status=0
  slot=$(release_field "${release}" slot) || return 1
  if ! slot_matches_release "${release}"; then
    if [[ ${start_mode} == reconcile ]]; then
      cleanup_stale_reconciliation_slot "${slot}" "${release}" || cleanup_status=$?
    else
      cleanup_status=2
    fi
    if [[ ${cleanup_status} -eq 2 ]]; then
      stop_slot "${slot}" || return 1
    elif [[ ${cleanup_status} -ne 0 ]]; then
      return "${cleanup_status}"
    fi
    write_slot_environment "${release}" || return 1
    run_interruptible timeout --signal=TERM --kill-after=15s 75s \
      systemctl start "capstone-chat@${slot}.service" || return 1
  fi
  wait_for_readiness "${release}" || return 1
}

container_release_from_inspection() {
  local slot=$1 inspection=$2
  local name="capstone-chat-${slot}" revision digest release
  [[ ${slot} == a || ${slot} == b ]] || return 1
  jq --exit-status --arg name "/${name}" --arg slot "${slot}" \
    '.[0] as $container | length == 1 and $container.Name == $name and
     $container.Config.Labels["io.capstone.slot"] == $slot and
     ($container.Config.Labels["io.capstone.revision"] | type == "string" and test("^[0-9a-f]{40}$")) and
     ($container.Config.Labels["io.capstone.digest"] | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
     ($container.Id | type == "string" and test("^[0-9a-f]{64}$"))' \
    <<<"${inspection}" >/dev/null || return 1
  revision=$(jq --exit-status --raw-output '.[0].Config.Labels["io.capstone.revision"]' \
    <<<"${inspection}") || return 1
  digest=$(jq --exit-status --raw-output '.[0].Config.Labels["io.capstone.digest"]' \
    <<<"${inspection}") || return 1
  release="${RELEASE_ROOT}/${revision}"
  validate_release "${release}" || return 1
  [[ $(release_field "${release}" slot) == "${slot}" &&
    $(release_field "${release}" digest) == "${digest}" ]] || return 1
  printf '%s\n' "${release}"
}

write_unclean_shutdown_evidence() {
  local release=$1 inspection=$2
  local slot revision digest temporary target
  slot=$(release_field "${release}" slot) || return 1
  revision=$(release_field "${release}" revision) || return 1
  digest=$(release_field "${release}" digest) || return 1
  target="${SHUTDOWN_EVIDENCE_ROOT}/${revision}-${slot}.json"
  temporary=$(mktemp "${SHUTDOWN_EVIDENCE_ROOT}/${revision}-${slot}.XXXXXX") || return 1
  if ! jq --exit-status \
    --arg slot "${slot}" --arg revision "${revision}" --arg digest "${digest}" \
    --arg detectedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schema: 1, slot: $slot, revision: $revision, digest: $digest, detectedAt: $detectedAt,
      containerId: .[0].Id, exitCode: .[0].State.ExitCode, oomKilled: .[0].State.OOMKilled}' \
    <<<"${inspection}" >"${temporary}"; then
    rm -f "${temporary}"
    return 1
  fi
  if ! chown root:root "${temporary}" || ! chmod 0440 "${temporary}"; then
    rm -f "${temporary}"
    return 1
  fi
  if ! python3 - "${temporary}" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  then
    rm -f "${temporary}"
    return 1
  fi
  mv -fT "${temporary}" "${target}" || return 1
  fsync_directory "${SHUTDOWN_EVIDENCE_ROOT}" || return 1
}

cleanup_stale_reconciliation_slot() {
  local slot=$1 expected_release=${2:-}
  local name inspection id matched_release status=0
  [[ ${slot} == a || ${slot} == b ]] || return 1
  name="capstone-chat-${slot}"
  inspect_container_if_present inspection "${name}" || status=$?
  if [[ ${status} -ne 0 ]]; then
    [[ ${status} -eq 2 ]] && return 2
    return 1
  fi
  matched_release=$(container_release_from_inspection "${slot}" "${inspection}") || return 1
  [[ -z ${expected_release} || ${matched_release} == "${expected_release}" ]] || return 1
  if ! jq --exit-status \
    '.[0].State.Running == false and .[0].State.OOMKilled == false and
     (.[0].State.ExitCode == 137 or .[0].State.ExitCode == 255) and
     .[0].State.Error == ""' \
    <<<"${inspection}" >/dev/null; then
    jq --exit-status \
      '.[0].State.Running == true or
       (.[0].State.Running == false and .[0].State.OOMKilled == false and
        .[0].State.ExitCode == 0 and .[0].State.Error == "")' \
      <<<"${inspection}" >/dev/null || return 1
    return 2
  fi
  id=$(jq --exit-status --raw-output '.[0].Id' <<<"${inspection}") || return 1
  write_unclean_shutdown_evidence "${matched_release}" "${inspection}" || return 1
  run_interruptible timeout --signal=TERM --kill-after=5s 30s docker rm "${id}" >/dev/null || return 1
  status=0
  inspect_container_if_present inspection "${name}" || status=$?
  [[ ${status} -eq 2 ]]
}

reconcile_stop_slot() {
  local slot=$1 stale_status=0
  cleanup_stale_reconciliation_slot "${slot}" || stale_status=$?
  [[ ${stale_status} -eq 0 || ${stale_status} -eq 2 ]] || return "${stale_status}"
  stop_slot "${slot}"
}

write_shutdown_acknowledgement() {
  local slot=$1 inspection=$2
  local acknowledgement="${RUNTIME_ROOT}/slot-${slot}.shutdown.json"
  local temporary
  temporary=$(mktemp "${RUNTIME_ROOT}/slot-${slot}.shutdown.XXXXXX") || return 1
  jq --exit-status \
    '{schema: 1, containerId: .[0].Id, digest: .[0].Config.Labels["io.capstone.digest"],
      exitCode: .[0].State.ExitCode, revision: .[0].Config.Labels["io.capstone.revision"]}' \
    <<<"${inspection}" >"${temporary}" || return 1
  chown root:root "${temporary}" || return 1
  chmod 0600 "${temporary}" || return 1
  mv -fT "${temporary}" "${acknowledgement}" || return 1
  fsync_directory "${RUNTIME_ROOT}" || return 1
}

stop_slot() {
  local slot=$1
  local name="capstone-chat-${slot}"
  local acknowledgement="${RUNTIME_ROOT}/slot-${slot}.shutdown.json"
  local initial_inspection=""
  local initial_id=""
  local inspection="" inspect_status=0
  [[ ${slot} == a || ${slot} == b ]] || {
    fail "slot shutdown target is invalid"
    return 1
  }
  rm -f "${acknowledgement}" || return 1

  inspect_container_if_present initial_inspection "${name}" || inspect_status=$?
  if [[ ${inspect_status} -eq 0 ]]; then
    container_release_from_inspection "${slot}" "${initial_inspection}" >/dev/null || {
      fail "slot ${slot} container does not match immutable release authority"
      return 1
    }
    initial_id=$(jq --exit-status --raw-output '.[0].Id' <<<"${initial_inspection}") || return 1
    [[ ${initial_id} =~ ^[0-9a-f]{64}$ ]] || {
      fail "slot ${slot} container identity is invalid"
      return 1
    }
  elif [[ ${inspect_status} -ne 2 ]]; then
    fail "slot ${slot} initial inspection exceeded its bound or failed"
    return 1
  fi

  run_interruptible timeout --signal=TERM --kill-after=15s 340s \
    systemctl stop "capstone-chat@${slot}.service" >/dev/null 2>&1 || {
    fail "slot ${slot} did not complete its bounded systemd stop"
    return 1
  }

  if [[ -z ${initial_id} ]]; then
    inspect_status=0
    inspect_container_if_present inspection "${name}" || inspect_status=$?
    [[ ${inspect_status} -eq 2 ]] || {
      fail "slot ${slot} appeared during its bounded systemd stop"
      return 1
    }
    return 0
  fi

  inspect_container_if_present inspection "${name}" || {
    fail "slot ${slot} lost its shutdown evidence before verification"
    return 1
  }
  jq --exit-status --arg id "${initial_id}" \
    '.[0] as $container |
     $container.Id == $id and
     $container.State.Running == false and
     $container.State.OOMKilled == false and
     $container.State.ExitCode == 0 and
     $container.State.Error == ""' \
    <<<"${inspection}" >/dev/null || {
    fail "slot ${slot} did not shut down cleanly"
    return 1
  }

  write_shutdown_acknowledgement "${slot}" "${inspection}" || return 1

  run_interruptible timeout --signal=TERM --kill-after=5s 30s docker rm "${initial_id}" >/dev/null || {
    fail "slot ${slot} clean container could not be removed"
    return 1
  }
  inspect_status=0
  inspect_container_if_present inspection "${name}" || inspect_status=$?
  [[ ${inspect_status} -eq 2 ]] || {
    fail "slot ${slot} survived removal after its clean-shutdown acknowledgement"
    return 1
  }
}

stage_caddy_fragment() {
  local source=$1
  local temporary
  temporary=$(mktemp "${CADDY_RUNTIME_ROOT}/upstream.XXXXXX") || return 1
  install -o root -g capstone-caddy-secrets -m 0640 "${source}" "${temporary}" || return 1
  mv -fT "${temporary}" "${CADDY_RUNTIME_ROOT}/upstream.caddy" || return 1
  fsync_directory "${CADDY_RUNTIME_ROOT}" || return 1
}

install_caddy_fragment() {
  local source=$1
  stage_caddy_fragment "${source}" || return 1
  run_interruptible timeout --signal=TERM --kill-after=5s 30s \
    caddy validate --config /etc/capstone-chat/Caddyfile --adapter caddyfile >/dev/null || return 1
  run_interruptible timeout --signal=TERM --kill-after=5s 30s \
    caddy reload --config /etc/capstone-chat/Caddyfile --adapter caddyfile \
    --address unix//run/capstone-caddy/admin.sock --force >/dev/null || return 1
}

prepare_caddy_unlocked() {
  if [[ -e ${MAINTENANCE_MARKER} ]]; then
    stage_caddy_fragment /etc/capstone-chat/maintenance.caddy
    log "Caddy staged in durable maintenance mode"
    return 0
  fi

  local release active_status=0
  release=$(active_release) || active_status=$?
  if [[ ${active_status} -eq 0 ]]; then
    stage_caddy_fragment "${release}/upstream.caddy"
    log "Caddy staged from the durable active release"
    return 0
  fi

  # A first boot or corrupt release must expose no application traffic. Boot
  # reconciliation reports the corrupt authority separately after Caddy starts.
  stage_caddy_fragment /etc/capstone-chat/maintenance.caddy
  log "Caddy staged in fail-closed maintenance mode"
}

load_maintenance() {
  install_caddy_fragment /etc/capstone-chat/maintenance.caddy || return 1
  curl --fail --silent --show-error --max-time 5 \
    --unix-socket /run/capstone-caddy/admin.sock http://localhost/config/ |
    jq --exit-status \
      '[.. | objects | .dial? // empty | select(type == "string" and test("^127\\.0\\.0\\.1:(3001|3002)$"))] |
      length == 0' >/dev/null || {
    fail "maintenance config retained an application upstream"
    return 1
  }
  local status headers revision_count
  headers=$(mktemp "${RUNTIME_ROOT}/maintenance-headers.XXXXXX")
  if ! status=$(curl --silent --dump-header "${headers}" --output /dev/null --write-out '%{http_code}' --max-time 5 \
    --resolve "${CAPSTONE_PUBLIC_HOST}:443:127.0.0.1" \
    "https://${CAPSTONE_PUBLIC_HOST}/api/health/ready"); then
    rm -f "${headers}"
    fail "maintenance response was unreachable"
    return 1
  fi
  revision_count=$(awk 'tolower($1) == "x-capstone-revision:" { count += 1 } END { print count + 0 }' "${headers}")
  rm -f "${headers}"
  [[ ${status} == 503 && ${revision_count} -eq 0 ]] ||
    {
      fail "maintenance response did not become generic and authoritative"
      return 1
    }
}

load_release() {
  local release=$1
  local port revision
  port=$(release_field "${release}" port)
  revision=$(release_field "${release}" revision)
  install_caddy_fragment "${release}/upstream.caddy" || return 1
  curl --fail --silent --show-error --max-time 5 \
    --unix-socket /run/capstone-caddy/admin.sock http://localhost/config/ |
    jq --exit-status --arg dial "127.0.0.1:${port}" \
      '[.. | objects | .dial? // empty | select(type == "string" and test("^127\\.0\\.0\\.1:(3001|3002)$"))] == [$dial]' \
      >/dev/null || {
    fail "Caddy admin state does not name only the expected release upstream"
    return 1
  }
  verify_public_smoke "${release}" || {
    fail "Caddy did not pass public static/API/session/revision smoke for the expected release"
    return 1
  }
}

commit_active_release() {
  local release=$1
  local temporary="${STATE_ROOT}/active.new"
  rm -f "${temporary}"
  ln -s "${release}" "${temporary}"
  mv -fT "${temporary}" "${ACTIVE_LINK}"
  fsync_directory "${STATE_ROOT}"
}

validate_ci_evidence() {
  local revision=$1
  local digest=$2
  local image="${CAPSTONE_IMAGE_REPOSITORY}@${digest}"
  local evidence="${EVIDENCE_ROOT}/${revision}.json"
  require_root_regular "${evidence}"
  [[ $(stat -c '%a' "${evidence}") == 440 ]] || fail "CI evidence must be immutable mode 0440"
  jq --exit-status \
    --arg revision "${revision}" \
    --arg digest "${digest}" \
    --arg image "${image}" \
    'keys == ["conclusion", "digest", "image", "previousCompatible", "revision", "schema", "verifiedAt", "workflowUrl"] and
     .schema == 1 and .conclusion == "success" and .revision == $revision and .digest == $digest and
     .image == $image and .previousCompatible == true and
     (.verifiedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
     (.workflowUrl | test("^https://github\\.com/[^/]+/[^/]+/actions/runs/[0-9]+$"))' \
    "${evidence}" >/dev/null || fail "exact-commit CI evidence is invalid"
}

pull_and_verify_image() {
  local revision=$1
  local digest=$2
  local image="${CAPSTONE_IMAGE_REPOSITORY}@${digest}"
  run_interruptible timeout --signal=TERM --kill-after=30s 180s \
    docker --config "${CAPSTONE_REGISTRY_CONFIG_DIR}" pull "${image}" >/dev/null || {
    fail "image pull exceeded its bound or failed"
    return 1
  }
  local inspected_revision inspected_digest inspected_source inspected_user expected_source
  expected_source="https://github.com/${CAPSTONE_IMAGE_REPOSITORY#ghcr.io/}"
  capture_value_interruptible inspected_revision timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image}" || return 1
  capture_value_interruptible inspected_digest timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ json .RepoDigests }}' "${image}" || return 1
  capture_value_interruptible inspected_source timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "${image}" || return 1
  capture_value_interruptible inspected_user timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ .Config.User }}' "${image}" || return 1
  [[ ${inspected_revision} == "${revision}" ]] || {
    fail "OCI revision label disagrees with CI"
    return 1
  }
  [[ ${inspected_source} == "${expected_source}" ]] || {
    fail "OCI source label disagrees with the approved repository"
    return 1
  }
  jq --exit-status --arg image "${image}" 'index($image) != null' <<<"${inspected_digest}" >/dev/null ||
    {
      fail "pulled OCI digest disagrees with request"
      return 1
    }
  [[ ${inspected_user} == node ]] || {
    fail "production image no longer declares the non-root node user"
    return 1
  }
}

cleanup_migration_containers() {
  run_interruptible timeout --signal=TERM --kill-after=10s 60s "${MIGRATION_CLEANUP}" owned
}

run_migrations() {
  local revision=$1
  local digest=$2
  local image="${CAPSTONE_IMAGE_REPOSITORY}@${digest}"
  validate_migration_secret_file \
    "${CAPSTONE_MIGRATION_SECRET_PATH}" "${CAPSTONE_MIGRATION_SECRET_GID}" || return 1
  log "running forward migrations"
  cleanup_migration_containers || return 1
  local name="capstone-migration-${revision}"
  local run_status=0 inspection="" inspection_status=0
  set +e
  run_interruptible timeout --signal=TERM --kill-after=30s 300s docker run \
    --name "capstone-migration-${revision}" \
    --network host \
    --user 1000:1000 \
    --group-add "${CAPSTONE_MIGRATION_SECRET_GID}" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
    --cap-drop ALL \
    --security-opt no-new-privileges=true \
    --pids-limit 128 \
    --memory 384m \
    --memory-swap 384m \
    --ulimit core=0:0 \
    --restart no \
    --log-driver none \
    --mount "type=bind,src=${CAPSTONE_MIGRATION_SECRET_PATH},dst=/run/capstone-secrets/migration.json,readonly" \
    --env CAPSTONE_SECRET_FILE=/run/capstone-secrets/migration.json \
    --env NODE_ENV=production \
    --label io.capstone.migration=true \
    --label "io.capstone.revision=${revision}" \
    --label "io.capstone.digest=${digest}" \
    --entrypoint node \
    "${image}" apps/api/dist/entrypoint.js migrate
  run_status=$?
  set -e
  inspect_container_if_present inspection "${name}" || inspection_status=$?
  cleanup_migration_containers || return 1
  [[ ${run_status} -eq 0 && ${inspection_status} -eq 0 ]] || {
    fail "migration container exceeded its bound or failed"
    return 1
  }
  jq --exit-status \
    '.[0].State.Running == false and .[0].State.OOMKilled == false and
     .[0].State.ExitCode == 0 and .[0].State.Error == ""' \
    <<<"${inspection}" >/dev/null || {
    fail "migration container did not exit cleanly"
    return 1
  }
}

create_release() {
  local revision=$1
  local digest=$2
  local slot=$3
  local port=$4
  local previous=$5
  local target="${RELEASE_ROOT}/${revision}"
  if [[ -d ${target} ]]; then
    validate_release "${target}" || return 1
    [[ $(release_field "${target}" digest) == "${digest}" ]] || {
      fail "revision already has another digest"
      return 1
    }
    [[ $(release_field "${target}" slot) == "${slot}" ]] || {
      fail "stale release uses another slot"
      return 1
    }
    [[ $(release_field "${target}" previousRelease) == "${previous}" ]] || {
      fail "stale release has another predecessor"
      return 1
    }
    printf '%s\n' "${target}"
    return 0
  fi

  local temporary
  temporary=$(mktemp --directory "${RELEASE_ROOT}/.${revision}.XXXXXX")
  jq -n \
    --arg revision "${revision}" \
    --arg digest "${digest}" \
    --arg image "${CAPSTONE_IMAGE_REPOSITORY}@${digest}" \
    --arg slot "${slot}" \
    --argjson port "${port}" \
    --arg previousRelease "${previous}" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schema: 1, revision: $revision, digest: $digest, image: $image, slot: $slot, port: $port,
      previousRelease: $previousRelease, previousCompatible: true, createdAt: $createdAt}' \
    >"${temporary}/release.json"
  write_upstream_fragment "${port}" "${temporary}/upstream.caddy"
  chown -R root:root "${temporary}"
  chmod 0440 "${temporary}/release.json" "${temporary}/upstream.caddy"
  chmod 0550 "${temporary}"
  python3 - "${temporary}/release.json" "${temporary}/upstream.caddy" "${temporary}" <<'PY'
import os
import sys

for path in sys.argv[1:3]:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
descriptor = os.open(sys.argv[3], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  mv "${temporary}" "${target}"
  fsync_directory "${RELEASE_ROOT}"
  validate_release "${target}" || return 1
  printf '%s\n' "${target}"
}

remove_uncommitted_candidate() {
  [[ -n ${candidate_release} && ${candidate_created} -eq 1 && ${durable_commit} -eq 0 ]] || return 0
  if [[ -L ${ACTIVE_LINK} && $(readlink --canonicalize-existing "${ACTIVE_LINK}" 2>/dev/null) == "${candidate_release}" ]]; then
    return 0
  fi
  if [[ -n ${candidate_slot} ]]; then
    if ! stop_slot "${candidate_slot}" >/dev/null 2>&1; then
      log "candidate shutdown was not proven clean; preserving its container and release metadata"
      return 1
    fi
  fi
  if [[ ${candidate_release} =~ ^${RELEASE_ROOT}/[0-9a-f]{40}$ && -d ${candidate_release} ]]; then
    find "${candidate_release}" -depth -delete
    fsync_directory "${RELEASE_ROOT}"
  fi
}

maintenance_is_enabled() {
  [[ -e ${MAINTENANCE_MARKER} ]]
}

reconcile_unlocked() {
  if maintenance_is_enabled; then
    require_root_regular "${MAINTENANCE_MARKER}" || return 1
    load_maintenance || return 1
    reconcile_stop_slot a || return 1
    reconcile_stop_slot b || return 1
    log "maintenance remains authoritative"
    return 0
  fi

  validate_runtime_prerequisites || return 1
  local release
  local active_status=0
  release=$(active_release) || active_status=$?
  if [[ ${active_status} -eq 1 ]]; then
    load_maintenance || return 1
    reconcile_stop_slot a || return 1
    reconcile_stop_slot b || return 1
    log "no active release; maintenance remains authoritative"
    return 0
  fi
  [[ ${active_status} -eq 0 ]] || return "${active_status}"

  start_release "${release}" reconcile || return 1
  load_release "${release}" || return 1
  local active_slot other_slot
  active_slot=$(release_field "${release}" slot) || return 1
  if [[ ${active_slot} == a ]]; then other_slot=b; else other_slot=a; fi
  reconcile_stop_slot "${other_slot}" || return 1
  log "runtime reconciled to durable release"
}

deploy_new_release() {
  local revision=$1
  local digest=$2
  [[ ! -e ${MAINTENANCE_MARKER} ]] || fail "ordinary deployment is blocked by maintenance mode"
  reconcile_unlocked
  validate_external_outbound_source
  validate_registry_config
  validate_migration_secret_file \
    "${CAPSTONE_MIGRATION_SECRET_PATH}" "${CAPSTONE_MIGRATION_SECRET_GID}"
  validate_headroom
  validate_ci_evidence "${revision}" "${digest}"
  pull_and_verify_image "${revision}" "${digest}"
  run_migrations "${revision}" "${digest}"

  local old_release=""
  local old_slot=""
  local active_status=0
  old_release=$(active_release) || active_status=$?
  if [[ ${active_status} -eq 0 ]]; then
    old_slot=$(release_field "${old_release}" slot)
  elif [[ ${active_status} -ne 1 ]]; then
    return "${active_status}"
  fi
  if [[ -n ${old_release} && $(release_field "${old_release}" revision) == "${revision}" ]]; then
    [[ $(release_field "${old_release}" digest) == "${digest}" ]] || fail "active revision digest changed"
    reconcile_unlocked
    log "requested release is already active"
    return 0
  fi

  if [[ ${old_slot} == a ]]; then
    candidate_slot=b
    candidate_port=3002
  else
    candidate_slot=a
    candidate_port=3001
  fi
  local candidate_target="${RELEASE_ROOT}/${revision}"
  if [[ ! -e ${candidate_target} && ! -L ${candidate_target} ]]; then
    candidate_created=1
  fi
  candidate_release=$(create_release "${revision}" "${digest}" "${candidate_slot}" "${candidate_port}" "${old_release}")
  start_release "${candidate_release}"
  load_release "${candidate_release}"
  commit_active_release "${candidate_release}"
  durable_commit=1
  if [[ -n ${old_slot} ]]; then
    stop_slot "${old_slot}"
  fi
  wait_for_readiness "${candidate_release}"
  load_release "${candidate_release}"
  log "activation complete and old slot drained; credentialed acceptance remains pending"
  record_activation_evidence "${candidate_release}"
}

rollback_release() {
  [[ ! -e ${MAINTENANCE_MARKER} ]] || fail "rollback is blocked by maintenance mode"
  reconcile_unlocked
  validate_external_outbound_source
  validate_headroom
  local current previous current_slot
  current=$(active_release) || {
    fail "there is no valid active release to roll back"
    return 1
  }
  [[ $(release_field "${current}" previousCompatible) == true ]] ||
    fail "current release did not attest previous-schema compatibility"
  previous=$(release_field "${current}" previousRelease)
  [[ -n ${previous} ]] || fail "there is no immediately previous compatible release"
  validate_release "${previous}"
  [[ $(release_field "${previous}" slot) != $(release_field "${current}" slot) ]] ||
    fail "previous release does not use the inactive slot"
  candidate_release="${previous}"
  candidate_slot=$(release_field "${previous}" slot)
  start_release "${previous}"
  load_release "${previous}"
  commit_active_release "${previous}"
  durable_commit=1
  current_slot=$(release_field "${current}" slot)
  stop_slot "${current_slot}"
  wait_for_readiness "${previous}"
  load_release "${previous}"
  log "rollback activation complete; credentialed acceptance remains pending"
  record_activation_evidence "${previous}"
}

enable_maintenance() {
  if [[ ! -e ${MAINTENANCE_MARKER} ]]; then
    local temporary
    temporary=$(mktemp "${STATE_ROOT}/maintenance.XXXXXX")
    printf '{"schema":1,"enabledAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${temporary}"
    chown root:root "${temporary}"
    chmod 0440 "${temporary}"
    mv -fT "${temporary}" "${MAINTENANCE_MARKER}"
    fsync_directory "${STATE_ROOT}"
  fi
  load_maintenance
  stop_slot a
  stop_slot b
  log "maintenance enabled and application connections fenced"
}

disable_maintenance() {
  [[ -e ${MAINTENANCE_MARKER} ]] || fail "maintenance is not enabled"
  require_root_regular "${MAINTENANCE_MARKER}"
  validate_runtime_prerequisites
  local release
  release=$(active_release) || {
    fail "no valid release is available after maintenance"
    return 1
  }
  start_release "${release}"
  wait_for_readiness "${release}"
  rm -f "${MAINTENANCE_MARKER}"
  fsync_directory "${STATE_ROOT}"
  load_release "${release}"
  local active_slot other_slot
  active_slot=$(release_field "${release}" slot)
  if [[ ${active_slot} == a ]]; then other_slot=b; else other_slot=a; fi
  stop_slot "${other_slot}"
  log "maintenance disabled after authoritative readiness"
}

image_id_from_inventory() {
  [[ $# -eq 3 ]] || return 1
  local destination=$1 inventory=$2 image=$3
  local expected_repository expected_digest id repository digest remainder match=""
  [[ ${image} =~ ^([^@]+)@(sha256:[0-9a-f]{64})$ ]] || return 1
  expected_repository=${BASH_REMATCH[1]}
  expected_digest=${BASH_REMATCH[2]}
  while IFS=$'\t' read -r id repository digest remainder; do
    [[ -n ${id}${repository}${digest}${remainder} ]] || continue
    [[ -z ${remainder} ]] || return 1
    if [[ ${repository} == "${expected_repository}" && ${digest} == "${expected_digest}" ]]; then
      [[ ${id} =~ ^sha256:[0-9a-f]{64}$ && -z ${match} ]] || return 1
      match=${id}
    fi
  done <<<"${inventory}"
  printf -v "${destination}" '%s' "${match}"
}

prune_release_if_safe() {
  local release=$1 revision=$2 inventory=$3
  local pin running_ids image docker_image_inventory image_id remaining_image_id file_exact_pin=0
  pin="${RECOVERY_PIN_ROOT}/${revision}"
  if [[ -e ${pin} ]]; then
    if [[ -f ${pin} && ! -L ${pin} && $(stat -c '%U:%G:%a' "${pin}") == root:root:440 ]]; then
      file_exact_pin=1
    fi
    [[ ${file_exact_pin} -eq 1 ]] || {
      rm -f "${inventory}"
      fail "recovery pin is unsafe"
      return 1
    }
    return 0
  fi
  capture_value_interruptible running_ids timeout --signal=TERM --kill-after=5s 15s \
    docker ps --all --quiet --filter "label=io.capstone.revision=${revision}" || {
    rm -f "${inventory}"
    fail "old release container inventory exceeded its bound or failed"
    return 1
  }
  if [[ -n ${running_ids} ]]; then
    rm -f "${inventory}"
    fail "an old release selected for cleanup still has a container"
    return 1
  fi
  image=$(release_field "${release}" image) || return 1
  capture_value_interruptible docker_image_inventory timeout --signal=TERM --kill-after=5s 15s \
    docker image ls --digests --no-trunc --format '{{.ID}}\t{{.Repository}}\t{{.Digest}}' || {
    rm -f "${inventory}"
    fail "old release image inventory exceeded its bound or failed"
    return 1
  }
  image_id_from_inventory image_id "${docker_image_inventory}" "${image}" || {
    rm -f "${inventory}"
    fail "old release image inventory is ambiguous"
    return 1
  }
  if [[ -n ${image_id} ]]; then
    [[ ${image_id} =~ ^sha256:[0-9a-f]{64}$ ]] || {
      rm -f "${inventory}"
      fail "old release image inventory is ambiguous"
      return 1
    }
    run_interruptible timeout --signal=TERM --kill-after=5s 60s \
      docker image rm "${image}" >/dev/null 2>&1 || {
      rm -f "${inventory}"
      fail "old release image removal exceeded its bound or failed"
      return 1
    }
    capture_value_interruptible docker_image_inventory timeout --signal=TERM --kill-after=5s 15s \
      docker image ls --digests --no-trunc --format '{{.ID}}\t{{.Repository}}\t{{.Digest}}' || {
      rm -f "${inventory}"
      fail "old release image removal could not be verified"
      return 1
    }
    image_id_from_inventory remaining_image_id "${docker_image_inventory}" "${image}" || {
      rm -f "${inventory}"
      fail "old release image removal inventory is ambiguous"
      return 1
    }
    [[ -z ${remaining_image_id} ]] || {
      rm -f "${inventory}"
      fail "old release image survived removal"
      return 1
    }
  fi
  find "${release}" -depth -delete || return 1
  fsync_directory "${RELEASE_ROOT}" || return 1
}

prune_releases() {
  local active="" previous="" active_status=0
  active=$(active_release) || active_status=$?
  [[ ${active_status} -eq 0 ]] || {
    fail "a valid active release is required before retention cleanup"
    return 1
  }
  previous=$(release_field "${active}" previousRelease)

  local inventory
  inventory=$(mktemp "${RUNTIME_ROOT}/release-inventory.XXXXXX")
  local release revision created_at
  shopt -s nullglob
  for release in "${RELEASE_ROOT}"/[0-9a-f]*; do
    validate_release "${release}"
    revision=$(release_field "${release}" revision)
    created_at=$(release_field "${release}" createdAt)
    printf '%s\t%s\t%s\n' "${created_at}" "${revision}" "${release}" >>"${inventory}"
  done
  shopt -u nullglob

  local position=0
  while IFS=$'\t' read -r _ revision release; do
    position=$((position + 1))
    [[ ${position} -gt 5 ]] || continue
    [[ ${release} != "${active}" && ${release} != "${previous}" ]] || continue
    prune_release_if_safe "${release}" "${revision}" "${inventory}" || return 1
  done < <(sort --reverse "${inventory}")
  rm -f "${inventory}"
  log "release retention keeps five newest plus active, previous, and recovery-pinned releases"
}

read_request() {
  require_root_regular "${REQUEST_PATH}"
  [[ $(stat -c '%a' "${REQUEST_PATH}") == 600 ]] || fail "deployment request must be mode 0600"
  jq --exit-status \
    'keys == ["digest", "operation", "revision", "schema"] and .schema == 1 and
     (.operation == "deploy" or .operation == "rollback" or .operation == "prune" or .operation == "maintenance-on" or .operation == "maintenance-off") and
     (.revision | type == "string") and (.digest | type == "string")' \
    "${REQUEST_PATH}" >/dev/null || fail "deployment request schema is invalid"
  operation=$(jq --raw-output .operation "${REQUEST_PATH}")
  request_revision=$(jq --raw-output .revision "${REQUEST_PATH}")
  request_digest=$(jq --raw-output .digest "${REQUEST_PATH}")
  rm -f "${REQUEST_PATH}"
  fsync_directory /run/capstone-deploy

  case "${operation}" in
    deploy)
      [[ ${request_revision} =~ ^[0-9a-f]{40}$ ]] || fail "request revision is invalid"
      [[ ${request_digest} =~ ^sha256:[0-9a-f]{64}$ ]] || fail "request digest is invalid"
      deploy_new_release "${request_revision}" "${request_digest}"
      ;;
    rollback)
      [[ -z ${request_revision} && -z ${request_digest} ]] || fail "rollback request carries unexpected data"
      rollback_release
      ;;
    prune)
      [[ -z ${request_revision} && -z ${request_digest} ]] || fail "prune request carries unexpected data"
      prune_releases
      ;;
    maintenance-on)
      [[ -z ${request_revision} && -z ${request_digest} ]] || fail "maintenance request carries unexpected data"
      enable_maintenance
      ;;
    maintenance-off)
      [[ -z ${request_revision} && -z ${request_digest} ]] || fail "maintenance request carries unexpected data"
      disable_maintenance
      ;;
  esac
}

on_exit() {
  local status=$?
  trap - EXIT ERR INT TERM
  if [[ ${status} -ne 0 ]]; then
    set +e
    log "operation failed; converging to durable authority"
    local reconcile_status=0
    reconcile_unlocked || reconcile_status=$?
    if [[ ${reconcile_status} -eq 0 ]]; then
      remove_uncommitted_candidate
    else
      log "durable authority could not be restored; preserving the candidate for boot reconciliation"
    fi
  fi
  exit "${status}"
}

main() {
  [[ ${EUID} -eq 0 ]] || fail "root is required"
  [[ ${CAPSTONE_DEPLOY_SUPERVISED:-} == 1 && -n ${INVOCATION_ID:-} ]] ||
    fail "deploy.sh may run only inside its supervised systemd unit"
  [[ $# -eq 1 ]] || fail "expected prepare-caddy, reconcile, or request"
  [[ $1 == prepare-caddy || $1 == reconcile || $1 == request ]] || fail "unsupported internal action"

  load_host_contract
  validate_secure_mount
  install -d -o root -g root -m 0750 "${STATE_ROOT}" "${RELEASE_ROOT}" "${EVIDENCE_ROOT}" "${RECOVERY_PIN_ROOT}" "${SHUTDOWN_EVIDENCE_ROOT}"
  install -d -o root -g root -m 0700 "${RUNTIME_ROOT}"
  install -d -o caddy -g capstone-caddy-secrets -m 0750 "${CADDY_RUNTIME_ROOT}"
  exec 9>"${DEPLOY_LOCK}"
  if [[ $1 == prepare-caddy ]]; then
    flock --exclusive --wait 90 9 || fail "Caddy could not read release authority inside its start bound"
    remove_stale_atomic_state
    operation=prepare-caddy
    prepare_caddy_unlocked
    return 0
  fi
  acquire_deployment_lock
  remove_stale_atomic_state

  trap on_exit EXIT
  trap 'interrupt_active_child 130' INT
  trap 'interrupt_active_child 143' TERM

  if [[ $1 == reconcile ]]; then
    operation=reconcile
    reconcile_unlocked
  else
    read_request
  fi
}

if [[ ${CAPSTONE_DEPLOY_TEST_SOURCE:-0} == 1 ]]; then
  [[ ${BASH_SOURCE[0]} != "$0" ]] || fail "the deploy test source fence requires a sourcing shell"
else
  main "$@"
fi
