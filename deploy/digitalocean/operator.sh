#!/usr/bin/env bash
set -Eeuo pipefail

readonly HOST_ENV=/etc/capstone-chat/host.env
readonly STATE_ROOT=/var/lib/capstone-chat
readonly RELEASE_ROOT="${STATE_ROOT}/releases"
readonly EVIDENCE_ROOT="${STATE_ROOT}/ci-evidence"
readonly ACTIVE_LINK="${STATE_ROOT}/active"
readonly DEPLOY_LOCK="${STATE_ROOT}/deploy.lock"
readonly REQUEST_ROOT=/run/capstone-operator
readonly REQUEST_PATH="${REQUEST_ROOT}/request.json"
readonly CONTAINER_REQUEST_PATH="${REQUEST_ROOT}/container-request.json"
readonly INPUT_PATH="${REQUEST_ROOT}/input.json"
readonly RECOVERY_APPLICATION_PATH="${REQUEST_ROOT}/recovery-application.json"
readonly RECOVERY_MIGRATION_PATH="${REQUEST_ROOT}/recovery-migration.json"
readonly OPERATOR_SECRET_PATH="${REQUEST_ROOT}/operator-secret.json"
readonly GITHUB_TOKEN_PATH="${REQUEST_ROOT}/github-token"
readonly RETENTION_PLAN_PATH="${STATE_ROOT}/ghcr-retention-plan.json"
readonly ENTRYPOINT_PATH=/opt/capstone-chat/lib/operator-entrypoint.mjs
readonly RETENTION_PROGRAM=/opt/capstone-chat/lib/ghcr-retention.py
readonly MIGRATION_CLEANUP=/opt/capstone-chat/bin/cleanup-migrations.sh

operation=""
operator_mode=""
initial_image_requested=0
active_child_pid=""
interrupted_status=0
selected_revision=""
selected_digest=""
selected_image=""

fail() {
  printf 'capstone-operator: %s\n' "$1" >&2
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
  [[ -z ${active_child_pid} ]] || fail "an interruptible operator child is already active"
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
  local destination=$1
  shift
  local output
  output=$(mktemp "${REQUEST_ROOT}/capture.XXXXXX") || return 1
  if ! run_interruptible "$@" >"${output}"; then
    rm -f "${output}"
    return 1
  fi
  printf -v "${destination}" '%s' "$(<"${output}")"
  rm -f "${output}"
}

require_root_regular() {
  local path=$1 mode=$2
  [[ -f ${path} && ! -L ${path} && $(stat -c '%u:%g:%a' "${path}") == "0:0:${mode}" ]] ||
    fail "a required root-owned file is missing or unsafe"
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

select_operator_mode() {
  case "${CAPSTONE_NODE_ENV:-}" in
    production)
      [[ ${CAPSTONE_PUBLIC_HOST:-} == chat.capstone.com.ec ]] || fail "production host changed"
      [[ ${CAPSTONE_PUBLIC_ORIGIN:-} == https://chat.capstone.com.ec ]] || fail "production origin changed"
      [[ ${CAPSTONE_EMAIL_DELIVERY:-} == resend && ${CAPSTONE_MODEL_GATEWAY:-} == openrouter ]] ||
        fail "production providers changed"
      [[ ${CAPSTONE_EXPECTED_REGION:-} == ric1 ]] || fail "production DigitalOcean region changed"
      operator_mode=production
      ;;
    test)
      [[ ${CAPSTONE_EMAIL_DELIVERY:-} == disabled && ${CAPSTONE_MODEL_GATEWAY:-} == fake ]] ||
        fail "managed rehearsal providers are unsafe"
      [[ ${CAPSTONE_EXPECTED_REGION:-} == nyc3 ]] ||
        fail "managed rehearsal must use the approved NYC3 region"
      [[ -n ${CAPSTONE_PUBLIC_HOST:-} &&
        ${CAPSTONE_PUBLIC_HOST} != chat.capstone.com.ec &&
        ${CAPSTONE_PUBLIC_ORIGIN:-} == "https://${CAPSTONE_PUBLIC_HOST}" ]] ||
        fail "managed rehearsal host and origin disagree"
      operator_mode=rehearsal
      ;;
    *) fail "operator host must be production or the explicit managed test rehearsal" ;;
  esac
}

load_host_contract() {
  require_root_regular "${HOST_ENV}" 640
  ! grep -Eq '__[A-Z0-9_]+__' "${HOST_ENV}" || fail "host contract still has a placeholder"
  # shellcheck disable=SC1091
  source "${HOST_ENV}"
  select_operator_mode
  [[ ${CAPSTONE_CLIENT_ADDRESS_SOURCE:-} == caddy ]] || fail "Caddy address mode is required"
  [[ ${CAPSTONE_OTEL_EXPORTER_OTLP_ENDPOINT:-} == https://otlp.nr-data.net ]] ||
    fail "New Relic OTLP endpoint changed"
  [[ ${CAPSTONE_SECURE_ROOT:-} == /srv/capstone-secure ]] || fail "secure Volume path changed"
  [[ ${CAPSTONE_EXPECTED_VOLUME_BYTES:-} == 1073741824 ]] || fail "secure Volume size changed"
  [[ ${CAPSTONE_GITHUB_PACKAGE_API_SCOPE:-} == users ]] || fail "GitHub package API scope changed"
  [[ ${CAPSTONE_IMAGE_REPOSITORY:-} =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*/capstone-chat$ ]] ||
    fail "GHCR repository is invalid"
  [[ ${CAPSTONE_RUNTIME_SECRET_PATH:-} == /srv/capstone-secure/runtime/runtime.json ]] ||
    fail "runtime secret path changed"
  [[ ${CAPSTONE_MIGRATION_SECRET_PATH:-} == /srv/capstone-secure/migration/migration.json ]] ||
    fail "migration secret path changed"
  [[ ${CAPSTONE_REGISTRY_CONFIG_DIR:-} == /srv/capstone-secure/registry ]] ||
    fail "registry credential path changed"
  [[ ${CAPSTONE_RUNTIME_SECRET_GID:-} == 21001 ]] || fail "runtime secret group changed"
  [[ ${CAPSTONE_MIGRATION_SECRET_GID:-} == 21002 ]] || fail "migration secret group changed"
}

validate_secret_file() {
  local path=$1 group=$2
  [[ -f ${path} && ! -L ${path} && $(stat -c '%u:%g:%a' "${path}") == "0:${group}:440" ]] ||
    fail "operator secret file is missing or unsafe"
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

validate_migration_secret_file() {
  local path=$1 group=$2
  validate_secret_file "${path}" "${group}" || return 1
  jq --exit-status \
    'keys == ["DATABASE_URL"] and (.DATABASE_URL | type == "string" and length > 0)' \
    "${path}" >/dev/null || {
    fail "migration operator secret schema is invalid"
    return 1
  }
}

active_release() {
  [[ -L ${ACTIVE_LINK} ]] || {
    fail "active release authority is missing"
    return 1
  }
  local release revision digest image
  release=$(readlink --canonicalize-existing "${ACTIVE_LINK}") || return 1
  [[ ${release} =~ ^${RELEASE_ROOT}/[0-9a-f]{40}$ && -d ${release} && ! -L ${release} ]] ||
    {
      fail "active release authority is invalid"
      return 1
    }
  require_root_regular "${release}/release.json" 440 || return 1
  jq --exit-status \
    --arg repository "${CAPSTONE_IMAGE_REPOSITORY}" \
    '(.revision | type == "string" and test("^[0-9a-f]{40}$")) and
     (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
     .image == ($repository + "@" + .digest)' "${release}/release.json" >/dev/null ||
    {
      fail "active release metadata is invalid"
      return 1
    }
  revision=$(jq --raw-output .revision "${release}/release.json") || return 1
  digest=$(jq --raw-output .digest "${release}/release.json") || return 1
  image=$(jq --raw-output .image "${release}/release.json") || return 1
  [[ ${release} == "${RELEASE_ROOT}/${revision}" ]] || {
    fail "active revision and path disagree"
    return 1
  }
  local inspected_revision inspected_source inspected_user expected_source
  expected_source="https://github.com/${CAPSTONE_IMAGE_REPOSITORY#ghcr.io/}"
  capture_interruptible inspected_revision timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image}" ||
    {
      fail "active image revision inspection failed"
      return 1
    }
  [[ ${inspected_revision} == "${revision}" ]] || {
    fail "active image revision label disagrees"
    return 1
  }
  capture_interruptible inspected_source timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "${image}" ||
    {
      fail "active image source inspection failed"
      return 1
    }
  [[ ${inspected_source} == "${expected_source}" ]] || {
    fail "active image source label disagrees with the approved repository"
    return 1
  }
  capture_interruptible inspected_user timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ .Config.User }}' "${image}" || {
    fail "active image user inspection failed"
    return 1
  }
  [[ ${inspected_user} == node ]] || {
    fail "active image is not non-root"
    return 1
  }
  selected_revision=${revision}
  selected_digest=${digest}
  selected_image=${image}
}

validate_registry_config() {
  local config_path="${CAPSTONE_REGISTRY_CONFIG_DIR}/config.json"
  [[ -d ${CAPSTONE_REGISTRY_CONFIG_DIR} && ! -L ${CAPSTONE_REGISTRY_CONFIG_DIR} &&
    $(stat -c '%u:%g:%a' "${CAPSTONE_REGISTRY_CONFIG_DIR}") == 0:0:700 ]] ||
    fail "registry configuration directory is missing or unsafe"
  [[ -f ${config_path} && ! -L ${config_path} && $(stat -c '%u:%g:%a' "${config_path}") == 0:0:400 ]] ||
    fail "registry pull configuration is missing or unsafe"
}

validate_ci_evidence() {
  local revision=$1 digest=$2
  local image="${CAPSTONE_IMAGE_REPOSITORY}@${digest}"
  local evidence="${EVIDENCE_ROOT}/${revision}.json"
  require_root_regular "${evidence}" 440
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

pull_and_verify_initial_image() {
  local revision=$1 digest=$2
  local image="${CAPSTONE_IMAGE_REPOSITORY}@${digest}"
  validate_registry_config || return 1
  run_interruptible timeout --signal=TERM --kill-after=30s 180s \
    docker --config "${CAPSTONE_REGISTRY_CONFIG_DIR}" pull "${image}" >/dev/null || {
    fail "initial operator image pull exceeded its bound or failed"
    return 1
  }
  local inspected_revision inspected_source inspected_user expected_source
  expected_source="https://github.com/${CAPSTONE_IMAGE_REPOSITORY#ghcr.io/}"
  capture_interruptible inspected_revision timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image}" ||
    {
      fail "initial operator image revision inspection failed"
      return 1
    }
  [[ ${inspected_revision} == "${revision}" ]] || {
    fail "initial operator image revision label disagrees with CI"
    return 1
  }
  capture_interruptible inspected_source timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "${image}" ||
    {
      fail "initial operator image source inspection failed"
      return 1
    }
  [[ ${inspected_source} == "${expected_source}" ]] || {
    fail "initial operator image source label disagrees with the approved repository"
    return 1
  }
  local inspected_digests
  capture_interruptible inspected_digests timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ json .RepoDigests }}' "${image}" ||
    {
      fail "initial operator digest inspection failed"
      return 1
    }
  jq --exit-status --arg image "${image}" 'index($image) != null' <<<"${inspected_digests}" >/dev/null ||
    {
      fail "initial operator image digest disagrees with the request"
      return 1
    }
  capture_interruptible inspected_user timeout --signal=TERM --kill-after=5s 15s \
    docker image inspect --format '{{ .Config.User }}' "${image}" ||
    {
      fail "initial operator user inspection failed"
      return 1
    }
  [[ ${inspected_user} == node ]] || {
    fail "initial operator image is not non-root"
    return 1
  }
}

cleanup_migration_containers() {
  run_interruptible timeout --signal=TERM --kill-after=10s 60s "${MIGRATION_CLEANUP}" owned
}

run_initial_migrations() {
  local revision=$1 digest=$2
  local image="${CAPSTONE_IMAGE_REPOSITORY}@${digest}"
  validate_migration_secret_file \
    "${CAPSTONE_MIGRATION_SECRET_PATH}" "${CAPSTONE_MIGRATION_SECRET_GID}" || return 1
  cleanup_migration_containers || return 1
  local name="capstone-initial-migration-${revision}"
  local run_status=0 inspection="" inspection_status=0
  set +e
  run_interruptible timeout --signal=TERM --kill-after=30s 300s \
    docker run \
    --name "capstone-initial-migration-${revision}" \
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
  capture_interruptible inspection timeout --signal=TERM --kill-after=5s 15s \
    docker inspect "${name}" 2>/dev/null || inspection_status=$?
  cleanup_migration_containers || return 1
  if [[ ${run_status} -ne 0 || ${inspection_status} -ne 0 ]] ||
    ! jq --exit-status \
      '.[0].State.Running == false and .[0].State.OOMKilled == false and
       .[0].State.ExitCode == 0 and .[0].State.Error == ""' \
      <<<"${inspection}" >/dev/null; then
    fail "initial migration exceeded its bound or failed"
    return 1
  fi
}

initial_release_is_absent() {
  [[ ! -e ${ACTIVE_LINK} && ! -L ${ACTIVE_LINK} ]]
}

prepare_initial_operator_image() {
  initial_release_is_absent || {
    fail "initial operator commands are allowed only before the first active release"
    return 1
  }
  local revision=$1 digest=$2
  [[ ${revision} =~ ^[0-9a-f]{40}$ ]] || {
    fail "initial operator revision is invalid"
    return 1
  }
  [[ ${digest} =~ ^sha256:[0-9a-f]{64}$ ]] || {
    fail "initial operator digest is invalid"
    return 1
  }
  validate_ci_evidence "${revision}" "${digest}" || return 1
  pull_and_verify_initial_image "${revision}" "${digest}" || return 1
  run_initial_migrations "${revision}" "${digest}"
}

operation_uses_initial_image() {
  [[ ${operation} == model-policy-initialize ||
    (${operation} == identity-bootstrap && ${initial_image_requested} -eq 1) ]]
}

read_request() {
  require_root_regular "${REQUEST_PATH}" 600
  jq --exit-status \
    'keys == ["input", "operation", "schema"] and .schema == 1 and
     (.operation | type == "string") and (.input | type == "object")' \
    "${REQUEST_PATH}" >/dev/null || fail "operator request schema is invalid"
  operation=$(jq --raw-output .operation "${REQUEST_PATH}")
  initial_image_requested=0
  if [[ ${operation} == identity-bootstrap ]]; then
    local has_revision has_digest
    has_revision=$(jq --raw-output '.input | has("revision")' "${REQUEST_PATH}")
    has_digest=$(jq --raw-output '.input | has("digest")' "${REQUEST_PATH}")
    [[ ${has_revision} == "${has_digest}" ]] || fail "initial identity image reference is incomplete"
    [[ ${has_revision} == false || ${has_revision} == true ]] ||
      fail "initial identity image reference is invalid"
    [[ ${has_revision} == false ]] || initial_image_requested=1
    if [[ ${operator_mode} == rehearsal && ${initial_image_requested} -ne 1 ]]; then
      fail "managed rehearsal identity bootstrap requires a verified initial image"
    fi
  fi
}

operation_is_allowed() {
  case "${operator_mode}" in
    production)
      case "${operation}" in
        ghcr-retention-plan | ghcr-retention-delete | identity-bootstrap | identity-approve | identity-deactivate | model-catalog-refresh | model-policy-attest | model-policy-bootstrap | model-policy-initialize | recovery-marker-create | recovery-marker-list | recovery-marker-delete | recovery-prepare)
          return 0
          ;;
        *) return 1 ;;
      esac
      ;;
    rehearsal)
      case "${operation}" in
        identity-bootstrap | model-policy-initialize | recovery-marker-create | recovery-marker-list | recovery-marker-delete | recovery-prepare)
          return 0
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

cleanup_runtime_files() {
  [[ ! -e ${REQUEST_ROOT} || (-d ${REQUEST_ROOT} && ! -L ${REQUEST_ROOT}) ]] || return 1
  [[ -d ${REQUEST_ROOT} ]] || return 0
  rm -f \
    "${REQUEST_PATH}" \
    "${CONTAINER_REQUEST_PATH}" \
    "${INPUT_PATH}" \
    "${RECOVERY_APPLICATION_PATH}" \
    "${RECOVERY_MIGRATION_PATH}" \
    "${OPERATOR_SECRET_PATH}" \
    "${OPERATOR_SECRET_PATH}.new" \
    "${GITHUB_TOKEN_PATH}" \
    "${RETENTION_PLAN_PATH}.new"
  local path
  shopt -s nullglob
  for path in "${REQUEST_ROOT}"/capture.*; do
    [[ ${path} =~ ^${REQUEST_ROOT}/capture\.[A-Za-z0-9]{6}$ && -f ${path} && ! -L ${path} ]] || return 1
    rm -f "${path}"
  done
  for path in "${REQUEST_ROOT}"/fields.*; do
    [[ ${path} =~ ^${REQUEST_ROOT}/fields\.[A-Za-z0-9]{6}$ && -d ${path} && ! -L ${path} ]] || return 1
    find "${path}" -mindepth 1 -maxdepth 1 -type f -delete
    rmdir "${path}"
  done
  shopt -u nullglob
  fsync_directory "${REQUEST_ROOT}"
}

cleanup() {
  set +e
  cleanup_runtime_files >/dev/null 2>&1 || true
  run_interruptible timeout --signal=TERM --kill-after=10s 30s \
    docker rm --force capstone-operator >/dev/null 2>&1 || true
}

build_operator_secret() {
  validate_migration_secret_file \
    "${CAPSTONE_MIGRATION_SECRET_PATH}" "${CAPSTONE_MIGRATION_SECRET_GID}"

  local filter program
  case "${operation}" in
    identity-bootstrap | identity-approve | identity-deactivate)
      validate_secret_file "${CAPSTONE_RUNTIME_SECRET_PATH}" "${CAPSTONE_RUNTIME_SECRET_GID}"
      if [[ ${operator_mode} == rehearsal ]]; then
        [[ ${operation} == identity-bootstrap ]] ||
          fail "managed rehearsal identity operations are limited to bootstrap"
        filter='if
          ($migration | keys) == ["DATABASE_URL"] and
          ($runtime | keys) == ["BETTER_AUTH_SECRET", "DATABASE_URL", "OTEL_EXPORTER_OTLP_HEADERS"]
        then {
          BETTER_AUTH_SECRET: $runtime.BETTER_AUTH_SECRET,
          DATABASE_URL: $migration.DATABASE_URL
        } else error("rehearsal operator source secret schema changed") end'
      else
        filter='if
          ($migration | keys) == ["DATABASE_URL"] and
          ($runtime | keys) == ["BETTER_AUTH_SECRET", "DATABASE_URL", "OPENROUTER_API_KEY", "OTEL_EXPORTER_OTLP_HEADERS", "RESEND_API_KEY"]
        then {
          BETTER_AUTH_SECRET: $runtime.BETTER_AUTH_SECRET,
          DATABASE_URL: $migration.DATABASE_URL,
          RESEND_API_KEY: $runtime.RESEND_API_KEY
        } else error("operator source secret schema changed") end'
      fi
      ;;
    model-catalog-refresh | model-policy-bootstrap | model-policy-initialize)
      validate_secret_file "${CAPSTONE_RUNTIME_SECRET_PATH}" "${CAPSTONE_RUNTIME_SECRET_GID}"
      filter='if
        ($migration | keys) == ["DATABASE_URL"] and
        ($runtime | keys) == ["BETTER_AUTH_SECRET", "DATABASE_URL", "OPENROUTER_API_KEY", "OTEL_EXPORTER_OTLP_HEADERS", "RESEND_API_KEY"]
      then {
        DATABASE_URL: $migration.DATABASE_URL,
        OPENROUTER_API_KEY: $runtime.OPENROUTER_API_KEY
      } else error("operator source secret schema changed") end'
      ;;
    model-policy-attest)
      filter='if keys == ["DATABASE_URL"]
        then {DATABASE_URL: .DATABASE_URL}
        else error("operator source secret schema changed")
      end'
      ;;
    *) fail "an operator composite secret was requested for an unsupported operation" ;;
  esac

  rm -f "${OPERATOR_SECRET_PATH}.new"
  umask 0077
  if [[ ${operation} == model-policy-attest ]]; then
    jq --exit-status "${filter}" "${CAPSTONE_MIGRATION_SECRET_PATH}" \
      >"${OPERATOR_SECRET_PATH}.new" || fail "operator composite secret could not be constructed"
  else
    program='$migration[0] as $migration | $runtime[0] as $runtime | '
    program+="${filter}"
    jq --exit-status --null-input \
      --slurpfile migration "${CAPSTONE_MIGRATION_SECRET_PATH}" \
      --slurpfile runtime "${CAPSTONE_RUNTIME_SECRET_PATH}" \
      "${program}" >"${OPERATOR_SECRET_PATH}.new" ||
      fail "operator composite secret could not be constructed"
  fi
  chown "root:${CAPSTONE_MIGRATION_SECRET_GID}" "${OPERATOR_SECRET_PATH}.new"
  chmod 0440 "${OPERATOR_SECRET_PATH}.new"
  python3 - "${OPERATOR_SECRET_PATH}.new" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  mv -fT "${OPERATOR_SECRET_PATH}.new" "${OPERATOR_SECRET_PATH}"
  fsync_directory "${REQUEST_ROOT}"
  validate_secret_file "${OPERATOR_SECRET_PATH}" "${CAPSTONE_MIGRATION_SECRET_GID}"
}

run_retention() {
  require_root_regular "${GITHUB_TOKEN_PATH}" 600
  require_root_regular "${RETENTION_PROGRAM}" 750
  local owner
  owner=${CAPSTONE_IMAGE_REPOSITORY#ghcr.io/}
  owner=${owner%/capstone-chat}
  local command=plan
  local -a hash_arguments=()
  if [[ ${operation} == ghcr-retention-delete ]]; then
    command=delete
    local plan_hash
    plan_hash=$(jq --exit-status --raw-output '.input.planHash' "${REQUEST_PATH}")
    [[ ${plan_hash} =~ ^[0-9a-f]{64}$ ]] || fail "confirmed retention plan hash is invalid"
    hash_arguments=(--plan-hash "${plan_hash}")
  else
    jq --exit-status '.input | keys == []' "${REQUEST_PATH}" >/dev/null ||
      fail "retention dry run carries unexpected input"
  fi
  rm -f "${RETENTION_PLAN_PATH}.new"
  run_interruptible timeout --signal=TERM --kill-after=30s 540s \
    python3 "${RETENTION_PROGRAM}" "${command}" \
    --evidence-root "${EVIDENCE_ROOT}" \
    --image-repository "${CAPSTONE_IMAGE_REPOSITORY}" \
    --owner "${owner}" \
    --package capstone-chat \
    --plan-file "${RETENTION_PLAN_PATH}" \
    "${hash_arguments[@]}" \
    --scope "${CAPSTONE_GITHUB_PACKAGE_API_SCOPE}" \
    --state-root "${STATE_ROOT}" \
    --token-file "${GITHUB_TOKEN_PATH}"
}

run_container_command() {
  local revision=$1 image=$2 secret_source secret_gid secret_target
  local -a extra_mounts=()
  case "${operation}" in
    model-policy-initialize)
      if [[ ${operator_mode} == rehearsal ]]; then
        secret_source=${CAPSTONE_MIGRATION_SECRET_PATH}
        secret_gid=${CAPSTONE_MIGRATION_SECRET_GID}
        secret_target=/run/capstone-secrets/migration.json
      else
        build_operator_secret
        secret_source=${OPERATOR_SECRET_PATH}
        secret_gid=${CAPSTONE_MIGRATION_SECRET_GID}
        secret_target=/run/capstone-secrets/operator.json
      fi
      ;;
    identity-bootstrap | identity-approve | identity-deactivate | model-catalog-refresh | model-policy-attest | model-policy-bootstrap)
      build_operator_secret
      secret_source=${OPERATOR_SECRET_PATH}
      secret_gid=${CAPSTONE_MIGRATION_SECRET_GID}
      secret_target=/run/capstone-secrets/operator.json
      ;;
    recovery-marker-create | recovery-marker-list | recovery-marker-delete)
      secret_source=${CAPSTONE_MIGRATION_SECRET_PATH}
      secret_gid=${CAPSTONE_MIGRATION_SECRET_GID}
      secret_target=/run/capstone-secrets/migration.json
      ;;
    recovery-prepare)
      secret_source=${RECOVERY_MIGRATION_PATH}
      secret_gid=${CAPSTONE_MIGRATION_SECRET_GID}
      secret_target=/run/capstone-secrets/migration.json
      [[ -f ${RECOVERY_APPLICATION_PATH} && ! -L ${RECOVERY_APPLICATION_PATH} &&
        $(stat -c '%u:%a' "${RECOVERY_APPLICATION_PATH}") == 0:600 ]] ||
        fail "recovery application credential is missing or unsafe"
      [[ -f ${RECOVERY_MIGRATION_PATH} && ! -L ${RECOVERY_MIGRATION_PATH} &&
        $(stat -c '%u:%a' "${RECOVERY_MIGRATION_PATH}") == 0:600 ]] ||
        fail "recovery migration credential is missing or unsafe"
      chown "root:${secret_gid}" "${RECOVERY_APPLICATION_PATH}" "${RECOVERY_MIGRATION_PATH}"
      chmod 0440 "${RECOVERY_APPLICATION_PATH}" "${RECOVERY_MIGRATION_PATH}"
      validate_secret_file "${RECOVERY_APPLICATION_PATH}" "${secret_gid}"
      extra_mounts+=(--mount "type=bind,src=${RECOVERY_APPLICATION_PATH},dst=/run/capstone-secrets/recovery-application.json,readonly")
      ;;
    *) fail "operator operation is not allowlisted" ;;
  esac
  if [[ ${secret_target} == /run/capstone-secrets/migration.json ]]; then
    validate_migration_secret_file "${secret_source}" "${secret_gid}"
  else
    validate_secret_file "${secret_source}" "${secret_gid}"
  fi

  mv -fT "${REQUEST_PATH}" "${CONTAINER_REQUEST_PATH}"
  chown "root:${secret_gid}" "${CONTAINER_REQUEST_PATH}"
  chmod 0440 "${CONTAINER_REQUEST_PATH}"
  if [[ ${operator_mode} == production &&
    (${operation} == model-policy-attest || ${operation} == model-policy-bootstrap || ${operation} == model-policy-initialize) ]]; then
    [[ -f ${INPUT_PATH} && ! -L ${INPUT_PATH} && $(stat -c '%u:%a' "${INPUT_PATH}") == 0:600 ]] ||
      fail "privacy attestation input is missing or unsafe"
    chown "root:${secret_gid}" "${INPUT_PATH}"
    chmod 0440 "${INPUT_PATH}"
    extra_mounts+=(--mount "type=bind,src=${INPUT_PATH},dst=/run/capstone-operator/input.json,readonly")
  fi
  validate_secret_file "${CONTAINER_REQUEST_PATH}" "${secret_gid}"

  run_interruptible timeout --signal=TERM --kill-after=10s 30s \
    docker rm --force capstone-operator >/dev/null 2>&1 || return 1
  run_interruptible timeout --signal=TERM --kill-after=30s 540s \
    docker run --rm \
      --name capstone-operator \
      --network host \
      --user 1000:1000 \
      --group-add "${secret_gid}" \
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
      --mount "type=bind,src=${secret_source},dst=${secret_target},readonly" \
      --mount "type=bind,src=${CONTAINER_REQUEST_PATH},dst=/run/capstone-operator/request.json,readonly" \
      --mount "type=bind,src=${ENTRYPOINT_PATH},dst=/run/capstone-operator/entrypoint.mjs,readonly" \
      "${extra_mounts[@]}" \
      --env "CAPSTONE_SECRET_FILE=${secret_target}" \
      --env "NODE_ENV=${CAPSTONE_NODE_ENV}" \
      --env HOST=127.0.0.1 \
      --env PORT=3000 \
      --env "PUBLIC_ORIGIN=${CAPSTONE_PUBLIC_ORIGIN}" \
      --env "CLIENT_ADDRESS_SOURCE=${CAPSTONE_CLIENT_ADDRESS_SOURCE}" \
      --env "EMAIL_DELIVERY=${CAPSTONE_EMAIL_DELIVERY}" \
      --env "EMAIL_FROM=${CAPSTONE_EMAIL_FROM}" \
      --env "MODEL_GATEWAY=${CAPSTONE_MODEL_GATEWAY}" \
      --env "CAPSTONE_EXPECTED_REGION=${CAPSTONE_EXPECTED_REGION}" \
      --env "OTEL_EXPORTER_OTLP_ENDPOINT=${CAPSTONE_OTEL_EXPORTER_OTLP_ENDPOINT}" \
      --env LOG_LEVEL=info \
      --env "DEPLOYMENT_REVISION=${revision}" \
      --label io.capstone.operator=true \
      --label "io.capstone.revision=${revision}" \
      "${image}" node /run/capstone-operator/entrypoint.mjs
}

main() {
  [[ ${EUID} -eq 0 ]] || fail "root is required"
  [[ ${CAPSTONE_OPERATOR_SUPERVISED:-} == 1 && -n ${INVOCATION_ID:-} ]] ||
    fail "operator.sh may run only inside its supervised systemd unit"
  [[ $# -eq 0 ]] || fail "operator.sh accepts no interactive arguments"
  load_host_contract
  validate_secure_mount
  require_root_regular "${ENTRYPOINT_PATH}" 644
  install -d -o root -g root -m 0750 "${STATE_ROOT}" "${EVIDENCE_ROOT}"
  install -d -o root -g root -m 0700 "${REQUEST_ROOT}"
  exec 9>"${DEPLOY_LOCK}"
  flock --exclusive --nonblock 9 || fail "deploy, recovery, or another operator command holds the lock"
  read_request
  operation_is_allowed || fail "operator operation is not allowed by the host contract"
  trap cleanup EXIT
  trap 'interrupt_active_child 130' INT
  trap 'interrupt_active_child 143' TERM

  if [[ ${operation} == ghcr-retention-plan || ${operation} == ghcr-retention-delete ]]; then
    run_retention
  elif operation_uses_initial_image; then
    local initial_revision initial_digest initial_image
    initial_revision=$(jq --exit-status --raw-output '.input.revision' "${REQUEST_PATH}")
    initial_digest=$(jq --exit-status --raw-output '.input.digest' "${REQUEST_PATH}")
    prepare_initial_operator_image "${initial_revision}" "${initial_digest}"
    initial_image="${CAPSTONE_IMAGE_REPOSITORY}@${initial_digest}"
    run_container_command "${initial_revision}" "${initial_image}"
  else
    active_release
    run_container_command "${selected_revision}" "${selected_image}"
  fi
}

if [[ ${CAPSTONE_OPERATOR_TEST_SOURCE:-0} == 1 ]]; then
  [[ ${BASH_SOURCE[0]} != "$0" ]] || fail "the operator test source fence requires a sourcing shell"
elif [[ ${1:-} == cleanup-runtime ]]; then
  [[ ${EUID} -eq 0 && $# -eq 1 ]] || fail "operator runtime cleanup requires root and no extra arguments"
  cleanup_runtime_files
else
  main "$@"
fi
