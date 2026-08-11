#!/usr/bin/env bash
set -euo pipefail

readonly TEST_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly DEPLOY_PROGRAM="${TEST_ROOT}/deploy.sh"
readonly REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly OLD_REVISION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
readonly DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly OLD_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

test_fail() {
  printf 'Deploy state-machine fixture failed: %s\n' "$1" >&2
  exit 1
}

if [[ ${1:-} == __scenario ]]; then
  [[ $# -eq 4 ]] || test_fail "scenario invocation is invalid"
  scenario=$2
  event_log=$3
  lock_path=$4
  export CAPSTONE_DEPLOY_TEST_SOURCE=1
  # shellcheck disable=SC1090
  source "${DEPLOY_PROGRAM}"
  CAPSTONE_IMAGE_REPOSITORY=ghcr.io/capstone-owner/capstone-chat
  CAPSTONE_MIGRATION_SECRET_PATH=/fixture/migration.json
  CAPSTONE_MIGRATION_SECRET_GID=21002

  event() {
    printf '%s\n' "$1" >>"${event_log}"
  }
  if [[ ${scenario} != interrupt-child && ${scenario} != hung-docker-reconcile ]]; then
    run_interruptible() {
      if [[ $1 == timeout ]]; then
        shift
        while [[ $1 == --* ]]; do shift; done
        shift
      fi
      "$@"
    }
    capture_value_interruptible() {
      local destination=$1 value status=0
      shift
      if [[ $1 == timeout ]]; then
        shift
        while [[ $1 == --* ]]; do shift; done
        shift
      fi
      value=$("$@") || status=$?
      [[ ${status} -eq 0 ]] || return "${status}"
      printf -v "${destination}" '%s' "${value}"
    }
    inspect_container_if_present() {
      local destination=$1 name=$2 value status=0
      value=$(docker inspect "${name}") || status=$?
      [[ ${status} -eq 0 ]] || return 2
      printf -v "${destination}" '%s' "${value}"
    }
  fi
  default_deploy_mocks() {
    reconcile_unlocked() { event reconcile; }
    validate_external_outbound_source() { return 0; }
    validate_registry_config() { event registry; }
    validate_migration_secret_file() { event migration-secret; }
    validate_headroom() { event headroom; }
    validate_ci_evidence() { event ci-evidence; }
    pull_and_verify_image() { event image; }
    run_migrations() { event migration; }
  }

  case "${scenario}" in
    migration-failure)
      default_deploy_mocks
      run_migrations() { event migration-failed; return 1; }
      active_release() { event unexpected-active; return 1; }
      deploy_new_release "${REVISION}" "${DIGEST}"
      ;;
    readiness-failure)
      default_deploy_mocks
      active_release() { return 1; }
      create_release() { event create; printf '/candidate\n'; }
      start_release() { event readiness-failed; return 1; }
      load_release() { event unexpected-switch; }
      commit_active_release() { event unexpected-commit; }
      deploy_new_release "${REVISION}" "${DIGEST}"
      ;;
    switch-drain)
      default_deploy_mocks
      active_release() { printf '/old\n'; }
      release_field() {
        case "$1:$2" in
          /old:slot) printf 'a\n' ;;
          /old:revision) printf '%s\n' "${OLD_REVISION}" ;;
          /old:digest) printf '%s\n' "${OLD_DIGEST}" ;;
          /candidate:revision) printf '%s\n' "${REVISION}" ;;
          /candidate:digest) printf '%s\n' "${DIGEST}" ;;
          *) test_fail "unexpected release field" ;;
        esac
      }
      create_release() { event create; printf '/candidate\n'; }
      start_release() { event start-candidate; }
      load_release() { event switch; }
      commit_active_release() { event commit; }
      stop_slot() { event "drain-$1"; }
      wait_for_readiness() { event final-readiness; }
      deploy_new_release "${REVISION}" "${DIGEST}"
      ;;
    rollback)
      reconcile_unlocked() { event reconcile; }
      validate_external_outbound_source() { return 0; }
      validate_headroom() { event headroom; }
      active_release() { printf '/current\n'; }
      release_field() {
        case "$1:$2" in
          /current:previousCompatible) printf 'true\n' ;;
          /current:previousRelease) printf '/previous\n' ;;
          /current:slot) printf 'b\n' ;;
          /previous:slot) printf 'a\n' ;;
          /previous:revision) printf '%s\n' "${OLD_REVISION}" ;;
          /previous:digest) printf '%s\n' "${OLD_DIGEST}" ;;
          *) test_fail "unexpected rollback field" ;;
        esac
      }
      validate_release() { event validate-previous; }
      start_release() { event start-previous; }
      load_release() { event switch-previous; }
      commit_active_release() { event commit-previous; }
      stop_slot() { event "drain-$1"; }
      wait_for_readiness() { event final-readiness; }
      rollback_release
      ;;
    concurrent-lock)
      if [[ ${CAPSTONE_TEST_MOCK_FLOCK:-0} == 1 ]]; then
        flock() { event lock-denied; return 1; }
      fi
      exec 9>"${lock_path}"
      acquire_deployment_lock
      ;;
    stale-slot)
      release_field() { printf 'a\n'; }
      slot_matches_release() { return 1; }
      stop_slot() { event "clean-stop-$1"; }
      write_slot_environment() { event write-slot; }
      systemctl() { event "systemctl-$1-$2"; }
      wait_for_readiness() { event readiness; }
      start_release /candidate
      ;;
    digest-mismatch)
      default_deploy_mocks
      active_release() { printf '/active\n'; }
      release_field() {
        case "$2" in
          slot) printf 'a\n' ;;
          revision) printf '%s\n' "${REVISION}" ;;
          digest) printf '%s\n' "${OLD_DIGEST}" ;;
          *) test_fail "unexpected digest field" ;;
        esac
      }
      create_release() { event unexpected-create; }
      deploy_new_release "${REVISION}" "${DIGEST}"
      ;;
    image-source-mismatch)
      CAPSTONE_REGISTRY_CONFIG_DIR=/fixture/registry
      docker() {
        if [[ $1 == --config ]]; then
          event pull
          return 0
        fi
        [[ $1 == image && $2 == inspect && $3 == --format ]] ||
          test_fail "unexpected image inspection command"
        case "$4" in
          *revision*) printf '%s\n' "${REVISION}" ;;
          *RepoDigests*) printf '["%s@%s"]\n' "${CAPSTONE_IMAGE_REPOSITORY}" "${DIGEST}" ;;
          *source*) printf 'https://github.com/foreign/capstone-chat\n' ;;
          *User*) printf 'node\n' ;;
          *) test_fail "unexpected image inspection format" ;;
        esac
      }
      pull_and_verify_image "${REVISION}" "${DIGEST}"
      ;;
    clean-stop)
      removed=0
      container_release_from_inspection() { return 0; }
      systemctl() { event "systemctl-$1-$2"; }
      docker() {
        case "$1" in
          inspect)
            event inspect
            [[ ${removed} -eq 0 ]] || return 1
            printf '[{"Id":"%064d","Config":{"Labels":{"io.capstone.digest":"%s","io.capstone.revision":"%s"}},"State":{"Running":false,"OOMKilled":false,"ExitCode":0,"Error":""}}]\n' 0 "${DIGEST}" "${REVISION}"
            ;;
          rm)
            event remove
            removed=1
            ;;
          *) test_fail "unexpected clean-stop Docker command" ;;
        esac
      }
      write_shutdown_acknowledgement() { event acknowledge; }
      stop_slot a
      ;;
    forced-stop)
      container_release_from_inspection() { return 0; }
      systemctl() { event "systemctl-$1-$2"; }
      docker() {
        event inspect
        printf '[{"Id":"%064d","Config":{"Labels":{"io.capstone.digest":"%s","io.capstone.revision":"%s"}},"State":{"Running":false,"OOMKilled":false,"ExitCode":137,"Error":""}}]\n' 0 "${DIGEST}" "${REVISION}"
      }
      write_shutdown_acknowledgement() { event unexpected-acknowledge; }
      stop_slot a
      ;;
    systemd-stop-timeout)
      container_release_from_inspection() { return 0; }
      docker() {
        event inspect
        printf '[{"Id":"%064d","Config":{"Labels":{"io.capstone.digest":"%s","io.capstone.revision":"%s"}},"State":{"Running":true,"OOMKilled":false,"ExitCode":0,"Error":""}}]\n' 0 "${DIGEST}" "${REVISION}"
      }
      systemctl() { event "systemctl-$1-$2"; return 1; }
      write_shutdown_acknowledgement() { event unexpected-acknowledge; }
      stop_slot a
      ;;
    credential-free-smoke)
      CAPSTONE_PUBLIC_HOST=chat.capstone.com.ec
      release_field() {
        case "$2" in
          port) printf '3001\n' ;;
          revision) printf '%s\n' "${REVISION}" ;;
          *) test_fail "unexpected smoke release field" ;;
        esac
      }
      http_revision_is() { event "revision-${*: -1}"; }
      static_application_is_served() { event "static-$1"; }
      anonymous_session_is_rejected() {
        event "session-$1"
        if [[ $1 == http://127.0.0.1:3001/api/session ]]; then
          [[ $# -eq 4 && $3 == --header && $4 == 'X-Capstone-Client-IP: 192.0.2.1' ]] ||
            test_fail "direct Caddy-mode session smoke omitted its private client address"
        fi
      }
      verify_direct_smoke /candidate "$((SECONDS + 20))"
      verify_public_smoke /candidate
      ;;
    readiness-wall-clock)
      release_field() {
        case "$2" in
          port) printf '3001\n' ;;
          revision) printf '%s\n' "${REVISION}" ;;
          *) test_fail "unexpected readiness release field" ;;
        esac
      }
      http_revision_is() { sleep 2; return 1; }
      started_at=${SECONDS}
      if wait_for_readiness /candidate 2 >/dev/null 2>&1; then
        test_fail "unready candidate passed"
      fi
      elapsed=$((SECONDS - started_at))
      [[ ${elapsed} -le 3 ]] || test_fail "two-second readiness window took ${elapsed} seconds"
      event bounded-readiness
      ;;
    activation-evidence)
      release_field() {
        case "$2" in
          revision) printf '%s\n' "${REVISION}" ;;
          digest) printf '%s\n' "${DIGEST}" ;;
          *) test_fail "unexpected activation evidence field" ;;
        esac
      }
      date() {
        [[ $* == '-u +%Y-%m-%dT%H:%M:%SZ' ]] || test_fail "unexpected evidence clock"
        printf '2026-08-10T19:20:21Z\n'
      }
      log() { event "$1"; }
      record_activation_evidence /candidate
      ;;
    two-slot-reconcile)
      maintenance_is_enabled() { return 0; }
      require_root_regular() { event maintenance-marker; }
      load_maintenance() { event maintenance-route; }
      cleanup_stale_reconciliation_slot() { return 2; }
      stop_slot() { event "stop-$1"; }
      reconcile_unlocked
      ;;
    reconcile-start-failure | reconcile-caddy-failure | reconcile-stop-failure)
      maintenance_is_enabled() { return 1; }
      validate_runtime_prerequisites() { event runtime; }
      active_release() { printf '/active\n'; }
      cleanup_stale_reconciliation_slot() { return 2; }
      start_release() {
        event start
        [[ ${scenario} != reconcile-start-failure ]]
      }
      load_release() {
        event caddy
        [[ ${scenario} != reconcile-caddy-failure ]]
      }
      release_field() { printf 'a\n'; }
      stop_slot() {
        event "stop-$1"
        [[ ${scenario} != reconcile-stop-failure ]]
      }
      reconcile_unlocked
      ;;
    distinct-secure-device | root-device-bind)
      CAPSTONE_SECURE_ROOT=/srv/capstone-secure
      CAPSTONE_EXPECTED_VOLUME_BYTES=1073741824
      mount_field() {
        case "$1:$2" in
          /srv/capstone-secure:TARGET) printf '/srv/capstone-secure\n' ;;
          /srv/capstone-secure:OPTIONS) printf 'rw,nodev,nosuid,noexec\n' ;;
          /:MAJ:MIN) printf '8:1\n' ;;
          /srv/capstone-secure:MAJ:MIN)
            if [[ ${scenario} == root-device-bind ]]; then printf '8:1\n'; else printf '8:16\n'; fi
            ;;
          *) test_fail "unexpected mount field" ;;
        esac
      }
      block_device_size_bytes() { event "device-$1"; printf '1073741824\n'; }
      validate_secure_mount
      ;;
    migration-success-cleanup | migration-timeout-cleanup)
      validate_migration_secret_file() { event secret; }
      cleanup_migration_containers() { event cleanup; }
      run_interruptible() {
        event bounded-run
        [[ ${scenario} == migration-success-cleanup ]]
      }
      docker() {
        [[ $1 == inspect ]] || test_fail "unexpected migration Docker command"
        event inspect
        if [[ ${scenario} == migration-success-cleanup ]]; then
          printf '[{"State":{"Running":false,"OOMKilled":false,"ExitCode":0,"Error":""}}]\n'
        else
          printf '[{"State":{"Running":true,"OOMKilled":false,"ExitCode":0,"Error":""}}]\n'
        fi
      }
      run_migrations "${REVISION}" "${DIGEST}"
      ;;
    prune-docker-failure)
      capture_value_interruptible() { event docker-ps-failed; return 124; }
      find() { event unexpected-release-delete; return 0; }
      release_field() { event unexpected-image-read; printf 'foreign\n'; }
      prune_release_if_safe /fixture/release "${REVISION}" "${event_log}.inventory"
      ;;
    prune-stopped-container)
      capture_value_interruptible() {
        local destination=$1
        shift
        [[ $* == *'docker ps --all'* ]] || test_fail "prune did not inventory stopped containers"
        event docker-ps-stopped
        printf -v "${destination}" '%064d' 0
      }
      find() { event unexpected-release-delete; return 0; }
      release_field() { event unexpected-image-read; printf 'foreign\n'; }
      prune_release_if_safe /fixture/release "${REVISION}" "${event_log}.inventory"
      ;;
    prune-image-rm-failure | prune-image-absent | prune-image-present)
      image_inventory_calls=0
      capture_value_interruptible() {
        local destination=$1
        shift
        if [[ $* == *'docker ps --all'* ]]; then
          event docker-ps
          printf -v "${destination}" '%s' ""
        else
          [[ $* == *'docker image ls --digests --no-trunc --format'* ]] ||
            test_fail "prune did not use the all-RepoDigests inventory"
          event image-list
          image_inventory_calls=$((image_inventory_calls + 1))
          if [[ ${scenario} == prune-image-rm-failure ||
            ( ${scenario} == prune-image-present && ${image_inventory_calls} -eq 1 ) ]]; then
            printf -v "${destination}" 'sha256:%064d\t%s\t%s' \
              0 "${CAPSTONE_IMAGE_REPOSITORY}" "${DIGEST}"
          else
            printf -v "${destination}" '%s' ""
          fi
        fi
      }
      release_field() { printf '%s@%s\n' "${CAPSTONE_IMAGE_REPOSITORY}" "${DIGEST}"; }
      run_interruptible() {
        if [[ ${scenario} == prune-image-rm-failure ]]; then
          event image-rm-failed
          return 1
        fi
        event image-rm
      }
      find() { event release-delete; }
      fsync_directory() { event metadata-fsync; }
      prune_release_if_safe /fixture/release "${REVISION}" "${event_log}.inventory"
      ;;
    interrupt-child)
      candidate_release=/candidate
      candidate_slot=a
      candidate_created=1
      durable_commit=0
      reconcile_unlocked() { event reconcile; }
      remove_uncommitted_candidate() { event remove-candidate; }
      trap on_exit EXIT
      trap 'interrupt_active_child 130' INT
      trap 'interrupt_active_child 143' TERM
      run_interruptible bash -c 'trap "exit 143" TERM; touch "$1"; while :; do sleep 1; done' \
        bash "${lock_path}"
      ;;
    hung-docker-reconcile)
      candidate_release=/candidate
      candidate_slot=a
      candidate_created=1
      durable_commit=0
      reconcile_unlocked() { event reconcile; }
      remove_uncommitted_candidate() { event remove-candidate; }
      mktemp() { printf '%s.capture\n' "${event_log}"; }
      trap on_exit EXIT
      trap 'interrupt_active_child 130' INT
      trap 'interrupt_active_child 143' TERM
      stop_slot a
      ;;
    interrupted-before-commit)
      candidate_release=/candidate
      candidate_slot=a
      candidate_created=1
      durable_commit=0
      remove_uncommitted_candidate() { event remove-candidate; }
      reconcile_unlocked() { event reconcile; }
      set +e
      false
      on_exit
      ;;
    failure-after-live-switch)
      default_deploy_mocks
      reconcile_calls=0
      active_release() { printf '/old\n'; }
      release_field() {
        case "$2" in
          slot) printf 'a\n' ;;
          revision) printf '%s\n' "${OLD_REVISION}" ;;
          digest) printf '%s\n' "${OLD_DIGEST}" ;;
          *) test_fail "unexpected release field" ;;
        esac
      }
      create_release() { event create; printf '/candidate\n'; }
      start_release() { event start-candidate; }
      load_release() { event switch-candidate; }
      commit_active_release() { event commit-failed; return 1; }
      reconcile_unlocked() {
        reconcile_calls=$((reconcile_calls + 1))
        if [[ ${reconcile_calls} -eq 1 ]]; then event reconcile; else event restore-durable-old; fi
      }
      remove_uncommitted_candidate() { event remove-candidate; }
      trap on_exit EXIT
      deploy_new_release "${REVISION}" "${DIGEST}"
      ;;
    failed-reconciliation-preserves-candidate)
      candidate_release=/candidate
      candidate_slot=a
      candidate_created=1
      durable_commit=0
      reconcile_unlocked() { event restore-failed; return 1; }
      remove_uncommitted_candidate() { event unexpected-remove; }
      set +e
      false
      on_exit
      ;;
    candidate-stop-failure-preserves-metadata)
      candidate_release=/candidate
      candidate_slot=a
      candidate_created=1
      durable_commit=0
      stop_slot() { event stop-failed; return 1; }
      remove_uncommitted_candidate
      ;;
    interrupted-after-commit)
      candidate_release=/candidate
      candidate_slot=a
      candidate_created=1
      durable_commit=1
      stop_slot() { event unexpected-stop; }
      reconcile_unlocked() { event reconcile; }
      set +e
      false
      on_exit
      ;;
    boot-reconcile)
      validate_runtime_prerequisites() { event runtime; }
      active_release() { printf '/active\n'; }
      start_release() {
        event start-active
        cleanup_stale_reconciliation_slot a /active
      }
      cleanup_stale_reconciliation_slot() { event "cleanup-$1"; }
      load_release() { event switch-active; }
      release_field() { printf 'a\n'; }
      stop_slot() { event "stop-$1"; }
      reconcile_unlocked
      ;;
    stale-power-loss-exact | stale-power-loss-255 | stale-power-loss-foreign)
      removed=0
      stale_exit=137
      [[ ${scenario} != stale-power-loss-255 ]] || stale_exit=255
      inspect_container_if_present() {
        local destination=$1
        if [[ ${removed} -eq 1 ]]; then
          event verify-absent
          return 2
        fi
        event inspect-capture
        printf -v "${destination}" \
          '[{"Id":"%064d","Name":"/capstone-chat-b","Config":{"Labels":{"io.capstone.slot":"b","io.capstone.digest":"%s","io.capstone.revision":"%s"}},"State":{"Running":false,"OOMKilled":false,"ExitCode":%d,"Error":""}}]' \
          0 "${OLD_DIGEST}" "${OLD_REVISION}" "${stale_exit}"
      }
      if [[ ${scenario} != stale-power-loss-foreign ]]; then
        container_release_from_inspection() { event authority-b; printf '/previous\n'; }
      else
        container_release_from_inspection() { event foreign-authority; return 1; }
      fi
      write_unclean_shutdown_evidence() { event evidence-b; }
      run_interruptible() {
        while [[ $1 != docker ]]; do shift; done
        shift
        docker "$@"
      }
      docker() {
        case "$1" in
          rm) event rm; removed=1 ;;
          *) test_fail "unexpected stale-container Docker command" ;;
        esac
      }
      cleanup_stale_reconciliation_slot b /previous
      ;;
    failure-after-candidate-start)
      inspect_container_if_present() {
        local destination=$1
        event inspect-running
        printf -v "${destination}" \
          '[{"Id":"%064d","Name":"/capstone-chat-b","Config":{"Labels":{"io.capstone.slot":"b","io.capstone.digest":"%s","io.capstone.revision":"%s"}},"State":{"Running":true,"OOMKilled":false,"ExitCode":0,"Error":""}}]' \
          0 "${OLD_DIGEST}" "${OLD_REVISION}"
      }
      container_release_from_inspection() { event authority-b; printf '/candidate\n'; }
      stop_slot() { event "strict-stop-$1"; }
      reconcile_stop_slot b
      ;;
    migration-secret-valid)
      printf '{"DATABASE_URL":"postgresql://fixture"}\n' >"${event_log}.secret"
      validate_secret_file() { event metadata; }
      validate_migration_secret_file "${event_log}.secret" 21002
      event schema-valid
      ;;
    migration-secret-extra-key)
      printf '{"DATABASE_URL":"postgresql://fixture","OPENROUTER_API_KEY":"forbidden"}\n' \
        >"${event_log}.secret"
      validate_secret_file() { event metadata; }
      validate_migration_secret_file "${event_log}.secret" 21002
      ;;
    *) test_fail "unknown scenario" ;;
  esac
  exit 0
fi

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/capstone-deploy-test.XXXXXX")
locker_pid=""
stop_locker() {
  [[ -n ${locker_pid} ]] || return 0
  local pid=${locker_pid} attempt
  kill -TERM -- "-${pid}" >/dev/null 2>&1 || true
  wait "${pid}" >/dev/null 2>&1 || true
  locker_pid=""
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ! kill -0 -- "-${pid}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.05
  done
  kill -KILL -- "-${pid}" >/dev/null 2>&1 || true
  return 1
}
cleanup() {
  stop_locker >/dev/null 2>&1 || true
  [[ -d ${temporary_root} && ! -L ${temporary_root} && ${temporary_root} == */capstone-deploy-test.* ]] ||
    test_fail "temporary fixture root is unsafe"
  find "${temporary_root}" -depth -delete
}
trap cleanup EXIT

run_scenario() {
  local name=$1 expected_status=$2 expected_events=$3
  local events="${temporary_root}/${name}.events"
  local output="${temporary_root}/${name}.output"
  : >"${events}"
  set +e
  bash "$0" __scenario "${name}" "${events}" "${temporary_root}/deploy.lock" >"${output}" 2>&1
  local status=$?
  set -e
  if [[ ${expected_status} == success && ${status} -ne 0 ]]; then
    test_fail "${name} unexpectedly failed: $(tr '\n' ' ' <"${output}")"
  fi
  if [[ ${expected_status} == failure && ${status} -eq 0 ]]; then
    test_fail "${name} unexpectedly succeeded"
  fi
  local actual_events
  actual_events=$(paste -sd, "${events}")
  [[ ${actual_events} == "${expected_events}" ]] ||
    test_fail "${name} emitted '${actual_events}', expected '${expected_events}'"
}

run_scenario migration-failure failure \
  'reconcile,registry,migration-secret,headroom,ci-evidence,image,migration-failed'
run_scenario readiness-failure failure \
  'reconcile,registry,migration-secret,headroom,ci-evidence,image,migration,create,readiness-failed'
run_scenario switch-drain success \
  'reconcile,registry,migration-secret,headroom,ci-evidence,image,migration,create,start-candidate,switch,commit,drain-a,final-readiness,switch'
run_scenario rollback success \
  'reconcile,headroom,validate-previous,start-previous,switch-previous,commit-previous,drain-b,final-readiness,switch-previous'

if command -v flock >/dev/null 2>&1; then
  lock_ready="${temporary_root}/lock-ready"
  python3 -c '
import fcntl
import os
import pathlib
import signal
import sys

os.setsid()
with open(sys.argv[1], "w", encoding="utf-8") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    pathlib.Path(sys.argv[2]).touch()
    signal.pause()
' "${temporary_root}/deploy.lock" "${lock_ready}" &
  locker_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -e ${lock_ready} ]] && break
    sleep 0.1
  done
  [[ -e ${lock_ready} ]] || test_fail "lock holder did not start"
  run_scenario concurrent-lock failure ''
  stop_locker || test_fail "lock-holder process group survived cleanup"
else
  export CAPSTONE_TEST_MOCK_FLOCK=1
  run_scenario concurrent-lock failure 'lock-denied'
  unset CAPSTONE_TEST_MOCK_FLOCK
  printf 'Kernel flock contention is unavailable locally; Linux CI remains required.\n'
fi

run_scenario stale-slot success \
  'clean-stop-a,write-slot,systemctl-start-capstone-chat@a.service,readiness'
run_scenario digest-mismatch failure \
  'reconcile,registry,migration-secret,headroom,ci-evidence,image,migration'
run_scenario image-source-mismatch failure 'pull'
run_scenario clean-stop success \
  'inspect,systemctl-stop-capstone-chat@a.service,inspect,acknowledge,remove,inspect'
run_scenario forced-stop failure \
  'inspect,systemctl-stop-capstone-chat@a.service,inspect'
run_scenario systemd-stop-timeout failure \
  'inspect,systemctl-stop-capstone-chat@a.service'
run_scenario credential-free-smoke success \
  'revision-http://127.0.0.1:3001/api/health/live,revision-http://127.0.0.1:3001/api/health/ready,static-http://127.0.0.1:3001/,session-http://127.0.0.1:3001/api/session,revision-https://chat.capstone.com.ec/api/health/ready,static-https://chat.capstone.com.ec/,session-https://chat.capstone.com.ec/api/session'
run_scenario readiness-wall-clock success 'bounded-readiness'
run_scenario activation-evidence success \
  "activation-evidence schema=1 activatedAt=2026-08-10T19:20:21Z revision=${REVISION} digest=${DIGEST}"
run_scenario two-slot-reconcile success \
  'maintenance-marker,maintenance-route,stop-a,stop-b'
run_scenario reconcile-start-failure failure 'runtime,start'
run_scenario reconcile-caddy-failure failure 'runtime,start,caddy'
run_scenario reconcile-stop-failure failure 'runtime,start,caddy,stop-b'
run_scenario distinct-secure-device success 'device-8:16'
run_scenario root-device-bind failure ''
run_scenario migration-success-cleanup success 'secret,cleanup,bounded-run,inspect,cleanup'
run_scenario migration-timeout-cleanup failure 'secret,cleanup,bounded-run,inspect,cleanup'
run_scenario prune-docker-failure failure 'docker-ps-failed'
run_scenario prune-stopped-container failure 'docker-ps-stopped'
run_scenario prune-image-rm-failure failure 'docker-ps,image-list,image-rm-failed'
run_scenario prune-image-absent success 'docker-ps,image-list,release-delete,metadata-fsync'
run_scenario prune-image-present success \
  'docker-ps,image-list,image-rm,image-list,release-delete,metadata-fsync'

interrupt_events="${temporary_root}/interrupt-child.events"
interrupt_output="${temporary_root}/interrupt-child.output"
interrupt_ready="${temporary_root}/interrupt-child.ready"
: >"${interrupt_events}"
bash "$0" __scenario interrupt-child "${interrupt_events}" "${interrupt_ready}" \
  >"${interrupt_output}" 2>&1 &
interrupt_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [[ -e ${interrupt_ready} ]] && break
  sleep 0.1
done
[[ -e ${interrupt_ready} ]] || test_fail "interruptible child did not start"
kill -TERM "${interrupt_pid}"
interrupt_started=${SECONDS}
set +e
wait "${interrupt_pid}"
interrupt_status=$?
set -e
[[ ${interrupt_status} -ne 0 ]] || test_fail "terminated deploy scenario succeeded"
[[ $((SECONDS - interrupt_started)) -le 5 ]] || test_fail "deploy TERM did not promptly reach reconciliation"
[[ $(paste -sd, "${interrupt_events}") == reconcile,remove-candidate ]] ||
  test_fail "deploy TERM did not reconcile before candidate removal"

hung_bin="${temporary_root}/hung-bin"
mkdir "${hung_bin}"
printf '%s\n' '#!/usr/bin/env bash' 'trap "exit 143" TERM' \
  'touch "${CAPSTONE_HUNG_DOCKER_READY}"' 'while :; do sleep 1; done' >"${hung_bin}/docker"
printf '%s\n' '#!/usr/bin/env bash' 'while [[ $1 == --* ]]; do shift; done' \
  'shift' 'exec "$@"' >"${hung_bin}/timeout"
chmod 0755 "${hung_bin}/docker" "${hung_bin}/timeout"
hung_events="${temporary_root}/hung-docker.events"
hung_output="${temporary_root}/hung-docker.output"
hung_ready="${temporary_root}/hung-docker.ready"
: >"${hung_events}"
CAPSTONE_HUNG_DOCKER_READY="${hung_ready}" PATH="${hung_bin}:${PATH}" \
  bash "$0" __scenario hung-docker-reconcile "${hung_events}" "${temporary_root}/unused.lock" \
  >"${hung_output}" 2>&1 &
hung_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [[ -e ${hung_ready} ]] && break
  sleep 0.1
done
[[ -e ${hung_ready} ]] || test_fail "hung Docker fixture did not enter the supervised command"
kill -TERM "${hung_pid}"
hung_started=${SECONDS}
set +e
wait "${hung_pid}"
hung_status=$?
set -e
[[ ${hung_status} -ne 0 ]] || test_fail "terminated hung Docker fixture succeeded"
[[ $((SECONDS - hung_started)) -le 5 ]] || test_fail "hung Docker child delayed reconciliation"
[[ $(paste -sd, "${hung_events}") == reconcile,remove-candidate ]] ||
  test_fail "hung Docker interruption did not converge through the fail-safe path"
run_scenario interrupted-before-commit failure 'reconcile,remove-candidate'
run_scenario failure-after-live-switch failure \
  'reconcile,registry,migration-secret,headroom,ci-evidence,image,migration,create,start-candidate,switch-candidate,commit-failed,restore-durable-old,remove-candidate'
run_scenario failed-reconciliation-preserves-candidate failure 'restore-failed'
run_scenario candidate-stop-failure-preserves-metadata failure 'stop-failed'
run_scenario interrupted-after-commit failure 'reconcile'
run_scenario boot-reconcile success 'runtime,start-active,cleanup-a,switch-active,cleanup-b,stop-b'
run_scenario stale-power-loss-exact success 'inspect-capture,authority-b,evidence-b,rm,verify-absent'
run_scenario stale-power-loss-255 success 'inspect-capture,authority-b,evidence-b,rm,verify-absent'
run_scenario stale-power-loss-foreign failure 'inspect-capture,foreign-authority'
run_scenario failure-after-candidate-start success 'inspect-running,authority-b,strict-stop-b'
run_scenario migration-secret-valid success 'metadata,schema-valid'
run_scenario migration-secret-extra-key failure 'metadata'

printf 'Deploy state-machine fixtures passed.\n'
