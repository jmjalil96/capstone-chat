#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'capstone migration cleanup: %s\n' "$1" >&2
  return 1
}

acquire_cleanup_lock() {
  flock --exclusive --nonblock 9
}

open_cleanup_lock() {
  exec 9>/var/lib/capstone-chat/deploy.lock
}

cleanup_migrations() {
  local ids id inspection
  ids=$(docker ps --all --quiet --filter label=io.capstone.migration=true) || return 1
  for id in ${ids}; do
    [[ ${id} =~ ^[0-9a-f]{12,64}$ ]] || {
      fail "Docker returned an invalid migration container ID"
      return 1
    }
    inspection=$(docker inspect "${id}") || {
      fail "migration container inspection failed"
      return 1
    }
    jq --exit-status \
      '.[0] as $container |
       ($container.Name | test("^/capstone-(initial-)?migration-[0-9a-f]{40}$")) and
       $container.Config.Labels["io.capstone.migration"] == "true" and
       ($container.Config.Labels["io.capstone.revision"] | type == "string" and test("^[0-9a-f]{40}$")) and
       ($container.Config.Labels["io.capstone.digest"] | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
       ($container.Name | endswith($container.Config.Labels["io.capstone.revision"]))' \
      <<<"${inspection}" >/dev/null || {
      fail "a labeled migration container has an unsafe identity"
      return 1
    }
  done
  for id in ${ids}; do
    docker rm --force "${id}" >/dev/null || {
      fail "migration container removal failed"
      return 1
    }
  done
  [[ -z $(docker ps --all --quiet --filter label=io.capstone.migration=true) ]] || {
    fail "a migration container survived cleanup"
    return 1
  }
}

main_cleanup() {
  [[ $# -eq 1 && ($1 == owned || $1 == post-stop) ]] || fail "expected owned or post-stop mode"
  if [[ $1 == post-stop ]]; then
    open_cleanup_lock
    if ! acquire_cleanup_lock; then
      # A newer supervised operation owns cleanup responsibility and begins by
      # reaping any exact old migration survivor under that same lock.
      return 0
    fi
  fi
  cleanup_migrations
}

if [[ ${CAPSTONE_MIGRATION_CLEANUP_TEST_SOURCE:-0} == 1 ]]; then
  [[ ${BASH_SOURCE[0]} != "$0" ]] || fail "the migration cleanup test fence requires a sourcing shell"
else
  [[ ${EUID} -eq 0 ]] || fail "root is required"
  main_cleanup "$@"
fi
