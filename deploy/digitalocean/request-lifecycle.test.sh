#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "${TEST_ROOT}/request-lifecycle.sh"

fail_test() {
  printf 'Request lifecycle fixture failed: %s\n' "$1" >&2
  exit 1
}

fixture_state=inactive
fixture_job=""
systemctl() {
  [[ $1 == show ]] || fail_test "unexpected systemctl operation"
  printf 'LoadState=loaded\nActiveState=%s\nJob=%s\n' "${fixture_state}" "${fixture_job}"
}

for unit in capstone-deploy.service capstone-operator.service; do
  fixture_state=inactive
  fixture_job=""
  capstone_request_unit_accepts_new_work "${unit}" ||
    fail_test "${unit} rejected a quiescent unit"

  # The first SSH helper is gone and its request-file lock is therefore free,
  # but the oneshot job it launched is still activating. A second helper must
  # not treat that released client-side lock as operation completion.
  fixture_lock=$(mktemp "${TMPDIR:-/tmp}/capstone-request-lock.XXXXXX")
  if command -v flock >/dev/null 2>&1; then
    (
      exec 9>"${fixture_lock}"
      flock --exclusive 9
    )
    exec 9>"${fixture_lock}"
    flock --exclusive --nonblock 9 || fail_test "simulated dead client retained its lock"
  fi
  fixture_state=activating
  fixture_job='417 start'
  if capstone_request_unit_accepts_new_work "${unit}"; then
    fail_test "${unit} accepted work while the prior oneshot was activating"
  fi
  if command -v flock >/dev/null 2>&1; then exec 9>&-; fi
  rm -f "${fixture_lock}"

  fixture_state=inactive
  fixture_job='418 start'
  if capstone_request_unit_accepts_new_work "${unit}"; then
    fail_test "${unit} accepted work while a start job was queued"
  fi

  fixture_state=failed
  fixture_job=""
  capstone_request_unit_accepts_new_work "${unit}" ||
    fail_test "${unit} rejected a settled failed unit"
done

printf 'Request lifecycle fixtures passed.\n'
