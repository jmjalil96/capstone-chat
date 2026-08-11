#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly OPERATOR_PROGRAM="${TEST_ROOT}/operator.sh"
readonly OPERATOR_UNIT="${TEST_ROOT}/capstone-operator.service"
readonly OPERATOR_ENTRYPOINT="${TEST_ROOT}/operator-entrypoint.mjs"
readonly REQUEST_PROGRAM="${TEST_ROOT}/request-operator.sh"

fail_test() {
  printf 'Operator secret fixture failed: %s\n' "$1" >&2
  exit 1
}

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/capstone-operator-secret-test.XXXXXX")
cleanup() {
  [[ -d ${temporary_root} && ! -L ${temporary_root} && ${temporary_root} == */capstone-operator-secret-test.* ]] ||
    fail_test "temporary fixture root is unsafe"
  find "${temporary_root}" -depth -delete
}
trap cleanup EXIT

export CAPSTONE_OPERATOR_TEST_SOURCE=1
# shellcheck disable=SC1090
source "${OPERATOR_PROGRAM}"
original_pull_and_verify_initial_image=$(declare -f pull_and_verify_initial_image)
original_run_interruptible=$(declare -f run_interruptible)
original_capture_interruptible=$(declare -f capture_interruptible)
validate_secret_file() { return 0; }

operator_mode=rehearsal
for operation in \
  identity-bootstrap \
  model-policy-initialize \
  recovery-marker-create \
  recovery-marker-list \
  recovery-marker-delete \
  recovery-prepare; do
  operation_is_allowed || fail_test "the rehearsal rejected its ${operation} operation"
done
for operation in \
  identity-approve \
  identity-deactivate \
  model-catalog-refresh \
  model-policy-attest \
  model-policy-bootstrap \
  ghcr-retention-plan \
  ghcr-retention-delete; do
  if operation_is_allowed; then
    fail_test "the rehearsal accepted its prohibited ${operation} operation"
  fi
done
operator_mode=production
operation=model-catalog-refresh
operation_is_allowed || fail_test "the production operator surface was narrowed"

operator_mode=rehearsal
operation=identity-bootstrap
initial_image_requested=1
operation_uses_initial_image || fail_test "rehearsal identity bootstrap requires an active release"
operator_mode=production
initial_image_requested=0
if operation_uses_initial_image; then
  fail_test "production identity bootstrap bypassed active release authority"
fi
initial_image_requested=1
operation_uses_initial_image || fail_test "initial production identity bootstrap cannot create its workspace"
operation=model-policy-initialize
operation_uses_initial_image || fail_test "initial policy bootstrap lost its pre-activation image path"
operation=recovery-marker-list
if operation_uses_initial_image; then
  fail_test "a recovery marker operation gained pre-activation image authority"
fi

valid_secret="${temporary_root}/valid.json"
extra_secret="${temporary_root}/extra.json"
printf '{"DATABASE_URL":"postgresql://fixture"}\n' >"${valid_secret}"
printf '{"DATABASE_URL":"postgresql://fixture","OPENROUTER_API_KEY":"forbidden"}\n' >"${extra_secret}"

validate_migration_secret_file "${valid_secret}" 21002 ||
  fail_test "the exact migration schema was rejected"
if validate_migration_secret_file "${extra_secret}" 21002 >/dev/null 2>&1; then
  fail_test "an extra migration secret key was accepted"
fi

events="${temporary_root}/initial.events"
: >"${events}"
initial_release_is_absent() { return 0; }
validate_ci_evidence() { printf 'evidence\n' >>"${events}"; }
pull_and_verify_initial_image() { printf 'pull\n' >>"${events}"; }
run_initial_migrations() { printf 'migrate\n' >>"${events}"; }
prepare_initial_operator_image \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
[[ $(paste -sd, "${events}") == evidence,pull,migrate ]] ||
  fail_test "initial image did not validate CI evidence before pull and migration"

validate_ci_evidence() { return 1; }
if prepare_initial_operator_image \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/dev/null 2>&1; then
  fail_test "an image without accepted CI evidence reached initial migration"
fi
if prepare_initial_operator_image latest sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  >/dev/null 2>&1; then
  fail_test "a mutable initial image target was accepted"
fi

CAPSTONE_SECURE_ROOT=/srv/capstone-secure
CAPSTONE_EXPECTED_VOLUME_BYTES=1073741824
mount_field() {
  case "$1:$2" in
    /srv/capstone-secure:TARGET) printf '/srv/capstone-secure\n' ;;
    /srv/capstone-secure:OPTIONS) printf 'rw,nodev,nosuid,noexec\n' ;;
    /:MAJ:MIN) printf '8:1\n' ;;
    /srv/capstone-secure:MAJ:MIN) printf '%s\n' "${fixture_secure_identity}" ;;
    *) fail_test "unexpected operator mount field" ;;
  esac
}
block_device_size_bytes() { printf '1073741824\n'; }
fixture_secure_identity=8:16
validate_secure_mount || fail_test "a distinct exact-size secure device was rejected"
fixture_secure_identity=8:1
if validate_secure_mount >/dev/null 2>&1; then
  fail_test "a root-device bind mount was accepted for operator secrets"
fi

grep -Fq 'timeout --signal=TERM --kill-after=30s 180s' "${OPERATOR_PROGRAM}" ||
  fail_test "initial image pull is not bounded"
grep -Fq 'timeout --signal=TERM --kill-after=30s 300s' "${OPERATOR_PROGRAM}" ||
  fail_test "initial migration is not bounded"
grep -Fq -- '--env NODE_ENV=production' "${OPERATOR_PROGRAM}" ||
  fail_test "initial migration no longer enforces the production database URL contract"
grep -Fq 'timeout --signal=TERM --kill-after=30s 540s' "${OPERATOR_PROGRAM}" ||
  fail_test "operator command is not bounded"
grep -Fq -- '--env "NODE_ENV=${CAPSTONE_NODE_ENV}"' "${OPERATOR_PROGRAM}" ||
  fail_test "operator containers ignore the validated runtime mode"
grep -Fq -- '--env "CAPSTONE_EXPECTED_REGION=${CAPSTONE_EXPECTED_REGION}"' "${OPERATOR_PROGRAM}" ||
  fail_test "the container entrypoint cannot verify the rehearsal region fence"
grep -Fq '"--mode",' "${OPERATOR_ENTRYPOINT}" &&
  grep -Fq '"simulated",' "${OPERATOR_ENTRYPOINT}" ||
  fail_test "the rehearsal model policy is not pinned to simulated mode"
grep -Fq 'argumentsList.push("--invitation-delivery", "disabled")' "${OPERATOR_ENTRYPOINT}" ||
  fail_test "the rehearsal identity bootstrap can attempt email delivery"
grep -Fq 'if [[ ${request_mode} == production ]]; then' "${REQUEST_PROGRAM}" ||
  fail_test "the rehearsal initialization still requires privacy input"
grep -Fq 'TimeoutStartSec=1800s' "${OPERATOR_UNIT}" ||
  fail_test "operator unit does not enclose pull, migration, command, and cleanup bounds"
grep -Fq 'TimeoutStopSec=210s' "${OPERATOR_UNIT}" ||
  fail_test "operator cleanup has no enclosing stop bound"
grep -Fq 'KillMode=mixed' "${OPERATOR_UNIT}" ||
  fail_test "operator timeout kills cleanup children before the supervisor"

eval "${original_pull_and_verify_initial_image}"
CAPSTONE_IMAGE_REPOSITORY=ghcr.io/capstone-owner/capstone-chat
CAPSTONE_REGISTRY_CONFIG_DIR=/fixture/registry
validate_registry_config() { return 0; }
run_interruptible() { return 0; }
capture_interruptible() {
  local destination=$1 value
  shift
  case "$*" in
    *org.opencontainers.image.revision*) value=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    *org.opencontainers.image.source*) value=https://github.com/foreign/capstone-chat ;;
    *) fail_test "foreign-source fixture reached an unexpected inspection" ;;
  esac
  printf -v "${destination}" '%s' "${value}"
}
if pull_and_verify_initial_image \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/dev/null 2>&1; then
  fail_test "initial operator accepted a foreign OCI source label"
fi
eval "${original_run_interruptible}"
eval "${original_capture_interruptible}"

for stage in initial-migration admin-command; do
  ready="${temporary_root}/${stage}.ready"
  (
    trap 'interrupt_active_child 143' TERM
    run_interruptible bash -c 'trap "exit 143" TERM; touch "$1"; while :; do sleep 1; done' \
      bash "${ready}"
  ) &
  supervisor_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [[ -e ${ready} ]] && break
    sleep 0.1
  done
  [[ -e ${ready} ]] || fail_test "${stage} interrupt fixture did not start"
  kill -TERM "${supervisor_pid}"
  interrupted_at=${SECONDS}
  set +e
  wait "${supervisor_pid}"
  interrupt_status=$?
  set -e
  [[ ${interrupt_status} -ne 0 ]] || fail_test "${stage} survived supervisor termination"
  [[ $((SECONDS - interrupted_at)) -le 5 ]] || fail_test "${stage} termination exceeded its bound"
done

printf 'Operator migration-secret and initial-image fixtures passed.\n'
