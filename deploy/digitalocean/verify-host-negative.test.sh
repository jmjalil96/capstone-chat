#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export CAPSTONE_VERIFY_HOST_TEST_SOURCE=1
# shellcheck disable=SC1091
source "${TEST_ROOT}/verify-host.sh"

fail_test() {
  printf 'Host negative-evidence fixture failed: %s\n' "$1" >&2
  exit 1
}

expect_failure() {
  local description=$1
  shift
  if "$@"; then
    fail_test "${description} passed"
  fi
}

timeout() {
  while [[ $1 == --* ]]; do shift; done
  shift
  "$@"
}

(
  swapon() { return 1; }
  expect_failure "failed swap inventory" no_active_swap
)

(
  curl() { return 1; }
  ip() { return 1; }
  expect_failure "two failed route commands with empty output" default_route_uses_anchor_gateway
)

(
  getent() { return 2; }
  expect_failure "absent or failed docker group lookup" no_ordinary_docker_group_member
)

baseline_listeners() {
  printf '%s\n' \
    'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*' \
    'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*' \
    'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*' \
    'LISTEN 0 4096 127.0.0.1:3001 0.0.0.0:*' \
    'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*' \
    'LISTEN 0 4096 127.0.0.54:53 0.0.0.0:*'
}

(
  ss() { return 1; }
  expect_failure "failed listener inventory" tcp_listener_allowlist_is_exact
)

(
  ss() {
    baseline_listeners
    printf '%s\n' 'LISTEN 0 4096 0.0.0.0:2375 0.0.0.0:*'
  }
  expect_failure "unexpected public Docker listener" tcp_listener_allowlist_is_exact
)

(
  ss() { baseline_listeners; }
  tcp_listener_allowlist_is_exact || fail_test "exact listener baseline was rejected"
)

CAPSTONE_OPERATOR_IPV4_CIDR=198.51.100.7/32
baseline_ufw() {
  printf '%s\n' \
    'Status: active' \
    '' \
    '     To                         Action      From' \
    '[ 1] 22/tcp                    ALLOW IN    198.51.100.7/32 # Capstone-operator-SSH' \
    '[ 2] 80/tcp                    ALLOW IN    Anywhere # Capstone-HTTP-ACME' \
    '[ 3] 443/tcp                   ALLOW IN    Anywhere # Capstone-HTTPS'
}

baseline_ufw_verbose() {
  printf '%s\n' \
    'Status: active' \
    'Logging: on (low)' \
    'Default: deny (incoming), allow (outgoing), disabled (routed)'
}

(
  ufw() {
    if [[ $* == 'status numbered' ]]; then baseline_ufw; else baseline_ufw_verbose; fi
  }
  ufw_contract || fail_test "exact UFW baseline was rejected"
)

(
  ufw() {
    if [[ $* == 'status numbered' ]]; then
      baseline_ufw
      printf '%s\n' '[ 4] 2375/tcp                  ALLOW IN    Anywhere # forbidden'
    else
      baseline_ufw_verbose
    fi
  }
  expect_failure "extra UFW allow rule" ufw_contract
)

(
  ufw() {
    if [[ $* == 'status numbered' ]]; then
      baseline_ufw
    else
      printf '%s\n' \
        'Status: active' \
        'Default: allow (incoming), allow (outgoing), disabled (routed)'
    fi
  }
  expect_failure "default-allow incoming firewall" ufw_contract
)

(
  systemctl() { return 1; }
  expect_failure "failed operator systemd query" operator_boundary_is_idle
  expect_failure "failed slot systemd query" one_active_slot
  expect_failure "failed masked-unit systemd query" distribution_units_are_masked
)

(
  systemctl() {
    printf 'LoadState=loaded\nActiveState=inactive\nJob=\n'
  }
  docker() { return 1; }
  expect_failure "failed all-state operator container query" operator_boundary_is_idle
)

(
  systemctl() {
    local unit=${*: -1}
    if [[ ${unit} == capstone-chat@a.service ]]; then
      printf 'LoadState=loaded\nActiveState=active\nJob=\n'
    else
      printf 'LoadState=loaded\nActiveState=inactive\nJob=\n'
    fi
  }
  one_active_slot || fail_test "one exact active slot was rejected"
)

(
  docker() {
    [[ $* == *'ps --all'* ]] || return 1
    if [[ $* == *'label=io.capstone.slot'* ]]; then
      printf '%064d\n%064d\n' 1 2
    fi
  }
  expect_failure "stopped extra application container" managed_container_inventory_is_exact
)

(
  docker() {
    [[ $* == *'ps --all'* ]] || return 1
    case "$*" in
      *'label=io.capstone.slot'*) printf '%064d\n' 1 ;;
      *'name=^/capstone-chat-a$'*) printf '%064d\n' 1 ;;
      *'name=^/capstone-chat-b$'*) printf '%064d\n' 2 ;;
    esac
  }
  expect_failure "unlabeled exact-name stale slot container" managed_container_inventory_is_exact
)

(
  docker() {
    [[ $* == *'ps --all'* ]] || return 1
    case "$*" in
      *'label=io.capstone.slot'*) printf '%064d\n' 1 ;;
      *'name=^/capstone-chat-a$'*) printf '%064d\n' 1 ;;
      *'name=^/capstone-initial-migration-'*) printf '%064d\n' 2 ;;
    esac
  }
  expect_failure "unlabeled initial migration container" managed_container_inventory_is_exact
)

(
  docker() {
    [[ $* == *'ps --all'* ]] || return 1
    case "$*" in
      'ps --all --quiet') printf '%064d\n%064d\n' 1 9 ;;
      *'label=io.capstone.slot'*) printf '%064d\n' 1 ;;
      *'name=^/capstone-chat-a$'*) printf '%064d\n' 1 ;;
    esac
  }
  expect_failure "arbitrary foreign stopped container" managed_container_inventory_is_exact
)

(
  grep() { return 2; }
  expect_failure "failed negative pattern probe" file_does_not_match forbidden /fixture
)

printf 'Host negative-evidence fixtures passed.\n'
