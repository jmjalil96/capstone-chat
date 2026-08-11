#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly VALIDATOR="${TEST_ROOT}/start-fluent-bit.sh"

fail_test() {
  printf 'Fluent Bit secret fixture failed: %s\n' "$1" >&2
  exit 1
}

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/capstone-fluent-secret-test.XXXXXX")
cleanup() {
  [[ -d ${temporary_root} && ! -L ${temporary_root} && ${temporary_root} == */capstone-fluent-secret-test.* ]] ||
    fail_test "temporary fixture root is unsafe"
  find "${temporary_root}" -depth -delete
}
trap cleanup EXIT

export CAPSTONE_FLUENT_SECRET_TEST_SOURCE=1
# shellcheck disable=SC1090
source "${VALIDATOR}"

fixture="${temporary_root}/new-relic.env"
printf 'NEW_RELIC_LICENSE_KEY=abc_DEF-123.456\n' >"${fixture}"
validate_new_relic_environment "${fixture}" || fail_test "valid exact secret was rejected"

printf 'NEW_RELIC_LICENSE_KEY=abc123\nEXTRA_KEY=forbidden\n' >"${fixture}"
unset NEW_RELIC_LICENSE_KEY EXTRA_KEY BASH_ENV || true
if load_new_relic_environment "${fixture}"; then
  fail_test "extra environment assignment was accepted"
fi
[[ -z ${NEW_RELIC_LICENSE_KEY:-} && -z ${EXTRA_KEY:-} && -z ${BASH_ENV:-} ]] ||
  fail_test "rejected data entered the launcher environment"
printf 'NEW_RELIC_LICENSE_KEY=$(touch /tmp/forbidden)\n' >"${fixture}"
if validate_new_relic_environment "${fixture}"; then
  fail_test "control syntax was accepted"
fi

printf 'NEW_RELIC_LICENSE_KEY=abc_DEF-123.456\n' >"${fixture}"
load_new_relic_environment "${fixture}" || fail_test "valid secret could not be loaded as data"
[[ ${NEW_RELIC_LICENSE_KEY} == abc_DEF-123.456 ]] || fail_test "launcher exported the wrong value"
printf 'NEW_RELIC_LICENSE_KEY=\n' >"${fixture}"
if validate_new_relic_environment "${fixture}"; then
  fail_test "empty license key was accepted"
fi

printf 'Fluent Bit exact-secret fixtures passed.\n'
