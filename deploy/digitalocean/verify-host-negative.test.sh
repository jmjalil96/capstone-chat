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
  CAPSTONE_NODE_ENV="production"
  CAPSTONE_EMAIL_DELIVERY="resend"
  CAPSTONE_MODEL_GATEWAY="openrouter"
  CAPSTONE_EXPECTED_REGION="ric1"
  runtime_contract_is_exact || fail_test "exact production runtime contract was rejected"
)

(
  CAPSTONE_NODE_ENV="test"
  CAPSTONE_EMAIL_DELIVERY="disabled"
  CAPSTONE_MODEL_GATEWAY="fake"
  CAPSTONE_EXPECTED_REGION="nyc3"
  CAPSTONE_PUBLIC_HOST="rehearsal.chat.capstone.test"
  CAPSTONE_PUBLIC_ORIGIN="https://${CAPSTONE_PUBLIC_HOST}"
  runtime_contract_is_exact || fail_test "exact managed rehearsal runtime contract was rejected"
)

(
  CAPSTONE_NODE_ENV="test"
  CAPSTONE_EMAIL_DELIVERY="disabled"
  CAPSTONE_MODEL_GATEWAY="fake"
  CAPSTONE_EXPECTED_REGION="nyc3"
  CAPSTONE_PUBLIC_HOST="chat.capstone.com.ec"
  CAPSTONE_PUBLIC_ORIGIN="https://${CAPSTONE_PUBLIC_HOST}"
  expect_failure "managed rehearsal using the production hostname" runtime_contract_is_exact
)

(
  CAPSTONE_NODE_ENV="production"
  CAPSTONE_EMAIL_DELIVERY="resend"
  CAPSTONE_MODEL_GATEWAY="openrouter"
  CAPSTONE_EXPECTED_REGION="nyc3"
  expect_failure "production runtime in the rehearsal region" runtime_contract_is_exact
)

(
  CAPSTONE_NODE_ENV="test"
  CAPSTONE_EMAIL_DELIVERY="disabled"
  CAPSTONE_MODEL_GATEWAY="fake"
  CAPSTONE_EXPECTED_REGION="ric1"
  expect_failure "managed rehearsal runtime in the production region" runtime_contract_is_exact
)

(
  CAPSTONE_NODE_ENV="production"
  CAPSTONE_EMAIL_DELIVERY="disabled"
  CAPSTONE_MODEL_GATEWAY="fake"
  CAPSTONE_EXPECTED_REGION="ric1"
  expect_failure "production runtime with rehearsal providers" runtime_contract_is_exact
)

(
  CAPSTONE_NODE_ENV="test"
  CAPSTONE_EMAIL_DELIVERY="resend"
  CAPSTONE_MODEL_GATEWAY="openrouter"
  CAPSTONE_EXPECTED_REGION="nyc3"
  expect_failure "managed rehearsal runtime with production providers" runtime_contract_is_exact
)

(
  CAPSTONE_NODE_ENV="staging"
  CAPSTONE_EMAIL_DELIVERY="disabled"
  CAPSTONE_MODEL_GATEWAY="fake"
  CAPSTONE_EXPECTED_REGION="nyc3"
  expect_failure "unknown runtime environment" runtime_contract_is_exact
)

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/capstone-host-negative.XXXXXX")
cleanup() {
  [[ -d ${temporary_root} && ! -L ${temporary_root} && ${temporary_root} == */capstone-host-negative.* ]] ||
    fail_test "temporary fixture root is unsafe"
  find "${temporary_root}" -depth -delete
}
trap cleanup EXIT

production_runtime="${temporary_root}/production-runtime.json"
rehearsal_runtime="${temporary_root}/rehearsal-runtime.json"
printf '%s\n' \
  '{"BETTER_AUTH_SECRET":"fixture-auth","DATABASE_URL":"postgresql://fixture","OPENROUTER_API_KEY":"fixture-model","OTEL_EXPORTER_OTLP_HEADERS":"api-key=fixture","RESEND_API_KEY":"fixture-email"}' \
  >"${production_runtime}"
printf '%s\n' \
  '{"BETTER_AUTH_SECRET":"fixture-auth","DATABASE_URL":"postgresql://fixture","OTEL_EXPORTER_OTLP_HEADERS":"api-key=fixture"}' \
  >"${rehearsal_runtime}"

(
  CAPSTONE_NODE_ENV=production
  CAPSTONE_RUNTIME_SECRET_PATH=${production_runtime}
  runtime_secret_schema_is_exact || fail_test "exact production runtime secret was rejected"
)
(
  CAPSTONE_NODE_ENV=test
  CAPSTONE_RUNTIME_SECRET_PATH=${rehearsal_runtime}
  runtime_secret_schema_is_exact || fail_test "exact rehearsal runtime secret was rejected"
)
(
  CAPSTONE_NODE_ENV=test
  CAPSTONE_RUNTIME_SECRET_PATH=${production_runtime}
  expect_failure "rehearsal runtime secret with real provider keys" runtime_secret_schema_is_exact
)
(
  CAPSTONE_NODE_ENV=production
  CAPSTONE_RUNTIME_SECRET_PATH=${rehearsal_runtime}
  expect_failure "production runtime secret without provider keys" runtime_secret_schema_is_exact
)

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
