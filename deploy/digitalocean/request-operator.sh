#!/usr/bin/env bash
set -euo pipefail

readonly REQUEST_ROOT=/run/capstone-operator
readonly REQUEST_PATH="${REQUEST_ROOT}/request.json"
readonly REQUEST_LOCK="${REQUEST_ROOT}/request.lock"
readonly HOST_ENV=/etc/capstone-chat/host.env
readonly INPUT_ROOT=/run/capstone-input
readonly REQUEST_LIFECYCLE=/opt/capstone-chat/bin/request-lifecycle.sh
readonly RETENTION_PLAN=/var/lib/capstone-chat/ghcr-retention-plan.json
umask 0077

fail() {
  printf 'capstone operator request rejected: %s\n' "$1" >&2
  exit 1
}

load_request_mode() {
  [[ -f ${HOST_ENV} && ! -L ${HOST_ENV} && $(stat -c '%u:%g:%a' "${HOST_ENV}") == 0:0:640 ]] ||
    fail "the host contract is missing or unsafe"
  ! grep -Eq '__[A-Z0-9_]+__' "${HOST_ENV}" || fail "the host contract still has a placeholder"
  # shellcheck disable=SC1091
  source "${HOST_ENV}"
  case "${CAPSTONE_NODE_ENV:-}" in
    production)
      [[ ${CAPSTONE_PUBLIC_HOST:-} == chat.capstone.com.ec &&
        ${CAPSTONE_PUBLIC_ORIGIN:-} == https://chat.capstone.com.ec &&
        ${CAPSTONE_EMAIL_DELIVERY:-} == resend &&
        ${CAPSTONE_MODEL_GATEWAY:-} == openrouter &&
        ${CAPSTONE_EXPECTED_REGION:-} == ric1 ]] ||
        fail "the production operator request contract changed"
      request_mode=production
      ;;
    test)
      [[ ${CAPSTONE_EMAIL_DELIVERY:-} == disabled &&
        ${CAPSTONE_MODEL_GATEWAY:-} == fake &&
        ${CAPSTONE_EXPECTED_REGION:-} == nyc3 &&
        -n ${CAPSTONE_PUBLIC_HOST:-} &&
        ${CAPSTONE_PUBLIC_HOST} != chat.capstone.com.ec &&
        ${CAPSTONE_PUBLIC_ORIGIN:-} == "https://${CAPSTONE_PUBLIC_HOST}" ]] ||
        fail "the managed rehearsal operator request contract is unsafe"
      request_mode=rehearsal
      ;;
    *) fail "operator requests require production or the explicit managed test rehearsal" ;;
  esac
}

show_retention_plan() {
  [[ -f ${RETENTION_PLAN} && ! -L ${RETENTION_PLAN} &&
    $(stat -c '%U:%G:%a' "${RETENTION_PLAN}") == root:root:440 &&
    $(stat -c '%s' "${RETENTION_PLAN}") -le 262144 ]] ||
    fail "the retention plan is missing or unsafe"
  jq --exit-status \
    'keys == ["core", "generatedAt", "schema"] and .schema == 1 and
     (.generatedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
     (.core | keys == ["acceptedEvidenceCount", "activeRelease", "candidateVersions", "protectedDigests",
       "remoteAcceptedVersionCount", "repository", "unknownVersionsLeftUntouched"]) and
     (.core.repository | type == "string" and test("^[a-z0-9][a-z0-9._-]*/capstone-chat$")) and
     (.core.activeRelease | type == "string" and test("^/var/lib/capstone-chat/releases/[0-9a-f]{40}$")) and
     ([.core.acceptedEvidenceCount, .core.remoteAcceptedVersionCount, .core.unknownVersionsLeftUntouched] |
       all(type == "number" and floor == . and . >= 0)) and
     (.core.candidateVersions | type == "array" and length <= 1000 and
       all(keys == ["digest", "id", "tags"] and
         (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
         (.id | type == "number" and floor == . and . > 0) and
         (.tags | type == "array" and length <= 100 and all(type == "string" and length <= 256)))) and
     (.core.protectedDigests | type == "array" and length <= 1000 and
       all(keys == ["digest", "reasons"] and
         (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
         (.reasons | type == "array" and all(. == "active" or . == "previous" or
           . == "recent-five" or . == "recovery-pin"))))' \
    "${RETENTION_PLAN}" >/dev/null || fail "the retention plan schema is invalid"
  local plan_hash
  plan_hash=$(sha256sum "${RETENTION_PLAN}" | awk '{print $1}')
  [[ ${plan_hash} =~ ^[0-9a-f]{64}$ ]] || fail "the retention plan hash could not be computed"
  jq --compact-output --arg planSha256 "${plan_hash}" \
    '{schema: 1, repository: .core.repository, planSha256: $planSha256,
      candidateVersions: .core.candidateVersions,
      protectedDigestCount: (.core.protectedDigests | length),
      unknownVersionsLeftUntouched: .core.unknownVersionsLeftUntouched}' \
    "${RETENTION_PLAN}"
}

prompt_value() {
  local destination=$1 label=$2 hidden=${3:-false} value
  printf '%s: ' "${label}" >/dev/tty
  if [[ ${hidden} == true ]]; then
    IFS= read -r -s value </dev/tty || fail "interactive input ended"
    printf '\n' >/dev/tty
  else
    IFS= read -r value </dev/tty || fail "interactive input ended"
  fi
  [[ -n ${value} ]] || fail "${label} is required"
  printf -v "${destination}" '%s' "${value}"
}

write_field() {
  local name=$1 value=$2
  printf '%s' "${value}" >"${field_root}/${name}"
  chmod 0600 "${field_root}/${name}"
}

validate_staged_file() {
  local source=$1 kind=$2 canonical
  [[ -d ${INPUT_ROOT} && ! -L ${INPUT_ROOT} && $(stat -c '%u:%g:%a' "${INPUT_ROOT}") == 0:0:700 ]] ||
    fail "${INPUT_ROOT} must be a root-only memory-backed staging directory"
  canonical=$(realpath --canonicalize-existing "${source}") || fail "${kind} input does not exist"
  [[ ${source} == "${canonical}" && ${canonical} == "${INPUT_ROOT}/"* ]] ||
    fail "${kind} input must be a canonical file beneath ${INPUT_ROOT}"
  [[ -f ${canonical} && ! -L ${canonical} && $(stat -c '%u' "${canonical}") == 0 ]] ||
    fail "${kind} input must be a root-owned regular file"
  case "$(stat -c '%a' "${canonical}")" in
    400 | 440) ;;
    *) fail "${kind} input must be mode 0400 or 0440" ;;
  esac
  [[ $(stat -c '%s' "${canonical}") -le 32768 ]] || fail "${kind} input is oversized"
  printf '%s\n' "${canonical}"
}

stage_json_input() {
  local source=$1 target=$2 kind=$3 canonical
  canonical=$(validate_staged_file "${source}" "${kind}")
  jq --exit-status 'type == "object"' "${canonical}" >/dev/null || fail "${kind} input is not JSON"
  install -o root -g root -m 0600 "${canonical}" "${target}"
}

stage_database_secret() {
  local source=$1 target=$2 kind=$3 canonical
  canonical=$(validate_staged_file "${source}" "${kind}")
  jq --exit-status \
    'keys == ["DATABASE_URL"] and (.DATABASE_URL | type == "string" and length > 0)' \
    "${canonical}" >/dev/null || fail "${kind} input must contain only DATABASE_URL"
  install -o root -g root -m 0600 "${canonical}" "${target}"
}

[[ ${EUID} -eq 0 ]] || fail "root is required; invoke this audited helper through sudo"
[[ $# -ge 1 ]] || fail "expected one allowlisted operator operation"
[[ -r /dev/tty && -w /dev/tty ]] || fail "a private interactive terminal is required"
request_mode=""
load_request_mode
[[ -f ${REQUEST_LIFECYCLE} && ! -L ${REQUEST_LIFECYCLE} &&
  $(stat -c '%U:%G:%a' "${REQUEST_LIFECYCLE}") == root:root:750 ]] ||
  fail "request lifecycle helper is missing or unsafe"
# shellcheck disable=SC1090
source "${REQUEST_LIFECYCLE}"
operation=$1
shift

if [[ ${request_mode} == rehearsal ]]; then
  case "${operation}" in
    identity-bootstrap | model-policy-initialize | recovery-marker-create | recovery-marker-list | recovery-marker-delete | recovery-prepare) ;;
    *) fail "the managed rehearsal permits only initialization and recovery operations" ;;
  esac
fi

install -d -o root -g root -m 0700 "${REQUEST_ROOT}"
exec 9>"${REQUEST_LOCK}"
flock --exclusive --nonblock 9 || fail "another operator request is being prepared"
if ! capstone_request_unit_accepts_new_work capstone-operator.service; then
  fail "a supervised operator command is already active"
fi

if [[ ${operation} == ghcr-retention-show ]]; then
  [[ $# -eq 0 ]] || fail "ghcr-retention-show accepts no command arguments"
  show_retention_plan
  exit 0
fi

rm -f \
  "${REQUEST_PATH}" \
  "${REQUEST_ROOT}/container-request.json" \
  "${REQUEST_ROOT}/input.json" \
  "${REQUEST_ROOT}/recovery-application.json" \
  "${REQUEST_ROOT}/recovery-migration.json" \
  "${REQUEST_ROOT}/operator-secret.json" \
  "${REQUEST_ROOT}/operator-secret.json.new" \
  "${REQUEST_ROOT}/github-token"

field_root=$(mktemp --directory "${REQUEST_ROOT}/fields.XXXXXX")
temporary=$(mktemp "${REQUEST_ROOT}/request.XXXXXX")
cleanup() {
  rm -f \
    "${temporary}" \
    "${REQUEST_PATH}" \
    "${REQUEST_ROOT}/container-request.json" \
    "${REQUEST_ROOT}/input.json" \
    "${REQUEST_ROOT}/recovery-application.json" \
    "${REQUEST_ROOT}/recovery-migration.json" \
    "${REQUEST_ROOT}/operator-secret.json" \
    "${REQUEST_ROOT}/operator-secret.json.new" \
    "${REQUEST_ROOT}/github-token"
  if [[ -d ${field_root} && ! -L ${field_root} ]]; then
    find "${field_root}" -mindepth 1 -maxdepth 1 -type f -delete
    rmdir "${field_root}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

case "${operation}" in
  identity-bootstrap)
    identity_initialization=0
    if [[ ${request_mode} == rehearsal ]]; then
      [[ $# -eq 2 ]] ||
        fail "rehearsal identity-bootstrap requires one full revision and one sha256 digest"
      identity_initialization=1
    elif [[ $# -eq 2 ]]; then
      identity_initialization=1
    else
      [[ $# -eq 0 ]] ||
        fail "identity-bootstrap accepts either no arguments or one full revision and sha256 digest"
    fi
    if [[ ${identity_initialization} -eq 1 ]]; then
      revision=$1
      digest=$2
      [[ ${revision} =~ ^[0-9a-f]{40}$ ]] || fail "revision must be 40 lowercase hexadecimal characters"
      [[ ${digest} =~ ^sha256:[0-9a-f]{64}$ ]] || fail "digest must be an immutable sha256 digest"
    fi
    prompt_value workspace "Workspace identity"
    prompt_value name "Administrator display name" true
    prompt_value email "Administrator email" true
    write_field workspace "${workspace}"
    write_field name "${name}"
    write_field email "${email}"
    if [[ ${identity_initialization} -eq 1 ]]; then
      jq -n --arg revision "${revision}" --arg digest "${digest}" \
        --rawfile workspace "${field_root}/workspace" --rawfile name "${field_root}/name" \
        --rawfile email "${field_root}/email" \
        '{schema: 1, operation: "identity-bootstrap",
          input: {digest: $digest, email: $email, name: $name, revision: $revision, workspace: $workspace}}' \
        >"${temporary}"
    else
      jq -n --rawfile workspace "${field_root}/workspace" --rawfile name "${field_root}/name" \
        --rawfile email "${field_root}/email" \
        '{schema: 1, operation: "identity-bootstrap", input: {workspace: $workspace, name: $name, email: $email}}' \
        >"${temporary}"
    fi
    ;;
  identity-approve)
    [[ $# -eq 0 ]] || fail "identity-approve accepts no command arguments"
    prompt_value workspace "Workspace identity"
    prompt_value email "Employee email" true
    prompt_value role "Role (member or admin)"
    write_field workspace "${workspace}"
    write_field email "${email}"
    write_field role "${role}"
    jq -n --rawfile workspace "${field_root}/workspace" --rawfile email "${field_root}/email" \
      --rawfile role "${field_root}/role" \
      '{schema: 1, operation: "identity-approve", input: {workspace: $workspace, email: $email, role: $role}}' \
      >"${temporary}"
    ;;
  identity-deactivate)
    [[ $# -eq 0 ]] || fail "identity-deactivate accepts no command arguments"
    prompt_value workspace "Workspace identity"
    prompt_value email "Employee email" true
    write_field workspace "${workspace}"
    write_field email "${email}"
    jq -n --rawfile workspace "${field_root}/workspace" --rawfile email "${field_root}/email" \
      '{schema: 1, operation: "identity-deactivate", input: {workspace: $workspace, email: $email}}' \
      >"${temporary}"
    ;;
  model-catalog-refresh)
    [[ $# -eq 0 ]] || fail "model-catalog-refresh accepts no command arguments"
    jq -n '{schema: 1, operation: "model-catalog-refresh", input: {}}' >"${temporary}"
    ;;
  model-policy-attest | model-policy-bootstrap)
    [[ $# -eq 0 ]] || fail "${operation} accepts no command arguments"
    prompt_value workspace "Workspace identity"
    prompt_value input_source "Privacy attestation path under /run/capstone-input"
    stage_json_input "${input_source}" "${REQUEST_ROOT}/input.json" "privacy attestation"
    write_field workspace "${workspace}"
    jq -n --arg operation "${operation}" --rawfile workspace "${field_root}/workspace" \
      '{schema: 1, operation: $operation, input: {workspace: $workspace}}' >"${temporary}"
    ;;
  model-policy-initialize)
    [[ $# -eq 2 ]] || fail "model-policy-initialize requires one full revision and one sha256 digest"
    revision=$1
    digest=$2
    [[ ${revision} =~ ^[0-9a-f]{40}$ ]] || fail "revision must be 40 lowercase hexadecimal characters"
    [[ ${digest} =~ ^sha256:[0-9a-f]{64}$ ]] || fail "digest must be an immutable sha256 digest"
    prompt_value workspace "Workspace identity"
    if [[ ${request_mode} == production ]]; then
      prompt_value input_source "Privacy attestation path under /run/capstone-input"
      stage_json_input "${input_source}" "${REQUEST_ROOT}/input.json" "privacy attestation"
    fi
    write_field workspace "${workspace}"
    jq -n --arg revision "${revision}" --arg digest "${digest}" \
      --rawfile workspace "${field_root}/workspace" \
      '{schema: 1, operation: "model-policy-initialize",
        input: {digest: $digest, revision: $revision, workspace: $workspace}}' >"${temporary}"
    ;;
  recovery-marker-create)
    [[ $# -eq 0 ]] || fail "recovery-marker-create accepts no command arguments"
    prompt_value kind "Marker kind (pre or post)"
    write_field kind "${kind}"
    jq -n --rawfile kind "${field_root}/kind" \
      '{schema: 1, operation: "recovery-marker-create", input: {kind: $kind}}' >"${temporary}"
    ;;
  recovery-marker-list)
    [[ $# -eq 0 ]] || fail "recovery-marker-list accepts no command arguments"
    jq -n '{schema: 1, operation: "recovery-marker-list", input: {}}' >"${temporary}"
    ;;
  recovery-marker-delete)
    [[ $# -eq 0 ]] || fail "recovery-marker-delete accepts no command arguments"
    prompt_value marker_id "Marker UUID"
    write_field marker_id "${marker_id}"
    jq -n --rawfile marker_id "${field_root}/marker_id" \
      '{schema: 1, operation: "recovery-marker-delete", input: {id: $marker_id}}' >"${temporary}"
    ;;
  recovery-prepare)
    [[ $# -eq 0 ]] || fail "recovery-prepare accepts no command arguments"
    prompt_value application_source "Restored application DATABASE_URL file under /run/capstone-input"
    prompt_value migration_source "Restored migration DATABASE_URL file under /run/capstone-input"
    stage_database_secret "${application_source}" "${REQUEST_ROOT}/recovery-application.json" \
      "recovery application credential"
    stage_database_secret "${migration_source}" "${REQUEST_ROOT}/recovery-migration.json" \
      "recovery migration credential"
    jq -n '{schema: 1, operation: "recovery-prepare", input: {}}' >"${temporary}"
    ;;
  ghcr-retention-plan | ghcr-retention-delete)
    [[ $# -eq 0 ]] || fail "${operation} accepts no command arguments"
    prompt_value github_token "Short-lived classic PAT with read:packages and delete:packages" true
    [[ ${github_token} =~ ^ghp_[A-Za-z0-9]{30,250}$ ]] || fail "a classic package PAT is required"
    printf '%s' "${github_token}" >"${REQUEST_ROOT}/github-token"
    chmod 0600 "${REQUEST_ROOT}/github-token"
    if [[ ${operation} == ghcr-retention-delete ]]; then
      prompt_value plan_hash "Confirmed dry-run plan SHA-256"
      write_field plan_hash "${plan_hash}"
      jq -n --rawfile plan_hash "${field_root}/plan_hash" \
        '{schema: 1, operation: "ghcr-retention-delete", input: {planHash: $plan_hash}}' >"${temporary}"
    else
      jq -n '{schema: 1, operation: "ghcr-retention-plan", input: {}}' >"${temporary}"
    fi
    ;;
  *)
    fail "unknown operator operation"
    ;;
esac

find "${field_root}" -mindepth 1 -maxdepth 1 -type f -delete
rmdir "${field_root}"
jq --exit-status 'type == "object" and .schema == 1' "${temporary}" >/dev/null
chown root:root "${temporary}"
chmod 0600 "${temporary}"
mv -fT "${temporary}" "${REQUEST_PATH}"
python3 - "${REQUEST_ROOT}" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY

systemctl reset-failed capstone-operator.service >/dev/null 2>&1 || true
systemctl start capstone-operator.service
[[ $(systemctl show --property=Result --value capstone-operator.service) == success ]] ||
  fail "the supervised operator unit did not finish successfully"
trap - EXIT
cleanup
if [[ ${operation} == ghcr-retention-plan ]]; then
  show_retention_plan
fi
printf 'capstone operator command completed successfully\n'
