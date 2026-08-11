#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly CLEANUP_PROGRAM="${TEST_ROOT}/cleanup-migrations.sh"
readonly REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

fail_test() {
  printf 'Migration cleanup fixture failed: %s\n' "$1" >&2
  exit 1
}

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/capstone-migration-cleanup-test.XXXXXX")
cleanup() {
  [[ -d ${temporary_root} && ! -L ${temporary_root} && ${temporary_root} == */capstone-migration-cleanup-test.* ]] ||
    fail_test "temporary fixture root is unsafe"
  find "${temporary_root}" -depth -delete
}
trap cleanup EXIT

export CAPSTONE_MIGRATION_CLEANUP_TEST_SOURCE=1
# shellcheck disable=SC1090
source "${CLEANUP_PROGRAM}"

events="${temporary_root}/events"
open_cleanup_lock() { return 0; }
acquire_cleanup_lock() { printf 'deferred\n' >>"${events}"; return 1; }
docker() { fail_test "post-stop cleanup crossed a newer operation's lock"; }
main_cleanup post-stop
[[ $(cat "${events}") == deferred ]] || fail_test "locked post-stop cleanup was not deferred"

: >"${events}"
removed=0
docker() {
  case "$1" in
    ps)
      [[ ${removed} -eq 0 ]] && printf 'aaaaaaaaaaaa\n'
      ;;
    inspect)
      printf '[{"Name":"/capstone-migration-%s","Config":{"Labels":{"io.capstone.migration":"true","io.capstone.revision":"%s","io.capstone.digest":"%s"}}}]\n' \
        "${REVISION}" "${REVISION}" "${DIGEST}"
      ;;
    rm)
      printf 'remove-%s\n' "$3" >>"${events}"
      removed=1
      ;;
    *) fail_test "unexpected Docker cleanup command" ;;
  esac
}
main_cleanup owned
[[ $(cat "${events}") == remove-aaaaaaaaaaaa ]] || fail_test "validated survivor was not removed"

removed=0
: >"${events}"
docker() {
  case "$1" in
    ps) printf 'bbbbbbbbbbbb\n' ;;
    inspect)
      printf '[{"Name":"/capstone-chat-a","Config":{"Labels":{"io.capstone.migration":"true","io.capstone.revision":"%s","io.capstone.digest":"%s"}}}]\n' \
        "${REVISION}" "${DIGEST}"
      ;;
    rm) printf 'unexpected-remove\n' >>"${events}" ;;
    *) fail_test "unexpected Docker cleanup command" ;;
  esac
}
if cleanup_migrations >/dev/null 2>&1; then
  fail_test "an unsafe labeled container was removed"
fi
[[ ! -s ${events} ]] || fail_test "cleanup mutated an unsafe labeled container"

printf 'Migration survivor cleanup fixtures passed.\n'
