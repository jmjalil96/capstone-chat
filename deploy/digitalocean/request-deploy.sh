#!/usr/bin/env bash
set -euo pipefail

readonly REQUEST_ROOT=/run/capstone-deploy
readonly REQUEST_PATH="${REQUEST_ROOT}/request.json"
readonly REQUEST_LOCK="${REQUEST_ROOT}/request.lock"
readonly STATE_ROOT=/var/lib/capstone-chat
readonly HOST_ENV=/etc/capstone-chat/host.env
readonly REQUEST_LIFECYCLE=/opt/capstone-chat/bin/request-lifecycle.sh

fail() {
  printf 'capstone deploy request rejected: %s\n' "$1" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail "root is required; invoke this audited helper through sudo"
[[ $# -ge 1 ]] || fail "expected deploy, rollback, prune, maintenance-on, or maintenance-off"
[[ -f ${HOST_ENV} && ! -L ${HOST_ENV} ]] || fail "host contract is missing or unsafe"
[[ -f ${REQUEST_LIFECYCLE} && ! -L ${REQUEST_LIFECYCLE} &&
  $(stat -c '%U:%G:%a' "${REQUEST_LIFECYCLE}") == root:root:750 ]] ||
  fail "request lifecycle helper is missing or unsafe"
# shellcheck disable=SC1090
source "${REQUEST_LIFECYCLE}"

# The installed file is root-owned and not writable by group/other. It contains no secret.
[[ $(stat -c '%U:%G:%a' "${HOST_ENV}") == root:root:640 ]] ||
  fail "host contract must be root:root mode 0640"
# shellcheck disable=SC1091
source "${HOST_ENV}"

[[ ${CAPSTONE_IMAGE_REPOSITORY:-} =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*/capstone-chat$ ]] ||
  fail "the immutable GHCR repository is invalid"

operation=$1
shift
revision=""
digest=""

case "${operation}" in
  deploy)
    [[ $# -eq 2 ]] || fail "deploy requires one full revision and one sha256 digest"
    revision=$1
    digest=$2
    [[ ${revision} =~ ^[0-9a-f]{40}$ ]] || fail "revision must be 40 lowercase hexadecimal characters"
    [[ ${digest} =~ ^sha256:[0-9a-f]{64}$ ]] || fail "digest must be an immutable sha256 digest"
    evidence_path="${STATE_ROOT}/ci-evidence/${revision}.json"
    [[ -f ${evidence_path} && ! -L ${evidence_path} ]] ||
      fail "exact-commit CI evidence is missing"
    ;;
  rollback | prune | maintenance-on | maintenance-off)
    [[ $# -eq 0 ]] || fail "${operation} accepts no additional arguments"
    ;;
  *)
    fail "unknown operation"
    ;;
esac

install -d -o root -g root -m 0700 "${REQUEST_ROOT}"
exec 9>"${REQUEST_LOCK}"
flock --exclusive --nonblock 9 || fail "another request is being prepared"

if ! capstone_request_unit_accepts_new_work capstone-deploy.service; then
  fail "a supervised deployment operation is already active"
fi

temporary=$(mktemp "${REQUEST_ROOT}/request.XXXXXX")
cleanup() {
  rm -f "${temporary}"
}
trap cleanup EXIT

jq -n \
  --arg operation "${operation}" \
  --arg revision "${revision}" \
  --arg digest "${digest}" \
  '{schema: 1, operation: $operation, revision: $revision, digest: $digest}' >"${temporary}"
chown root:root "${temporary}"
chmod 0600 "${temporary}"
mv -fT "${temporary}" "${REQUEST_PATH}"
trap - EXIT
python3 - "${REQUEST_ROOT}" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY

systemctl reset-failed capstone-deploy.service >/dev/null 2>&1 || true
systemctl start capstone-deploy.service
[[ $(systemctl show --property=Result --value capstone-deploy.service) == success ]] ||
  fail "the supervised deployment unit did not finish successfully"
case "${operation}" in
  deploy | rollback)
    printf 'capstone activation completed; credentialed acceptance is still pending and must be recorded separately\n'
    ;;
  *)
    printf 'capstone deployment operation completed successfully\n'
    ;;
esac
