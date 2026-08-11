#!/bin/bash
set -euo pipefail

readonly SECRET_PATH=/srv/capstone-secure/fluent-bit/new-relic.env

fail() {
  printf 'Fluent Bit secret validation failed\n' >&2
  return 1
}

validate_new_relic_environment() {
  local path=$1 line value
  [[ -f ${path} && ! -L ${path} && $(wc -c <"${path}") -le 1024 ]] || return 1
  [[ $(awk 'END { print NR }' "${path}") == 1 ]] || return 1
  IFS= read -r line <"${path}" || return 1
  [[ ${line} =~ ^NEW_RELIC_LICENSE_KEY=[A-Za-z0-9._-]+$ ]] || return 1
  value=${line#NEW_RELIC_LICENSE_KEY=}
  [[ ${#value} -ge 1 && ${#value} -le 512 ]]
}

load_new_relic_environment() {
  local path=$1 line
  validate_new_relic_environment "${path}" || return 1
  IFS= read -r line <"${path}" || return 1
  export NEW_RELIC_LICENSE_KEY=${line#NEW_RELIC_LICENSE_KEY=}
}

main() {
  [[ ${EUID} -eq 21011 ]] || fail
  [[ $# -eq 0 ]] || fail
  [[ -f ${SECRET_PATH} && ! -L ${SECRET_PATH} &&
    $(stat -c '%u:%g:%a' "${SECRET_PATH}") == 0:21004:440 ]] || fail
  load_new_relic_environment "${SECRET_PATH}" || fail
  exec /opt/fluent-bit/bin/fluent-bit --config /etc/capstone-chat/fluent-bit.conf
}

if [[ ${CAPSTONE_FLUENT_SECRET_TEST_SOURCE:-0} == 1 ]]; then
  [[ ${BASH_SOURCE[0]} != "$0" ]] || fail
else
  main "$@"
fi
