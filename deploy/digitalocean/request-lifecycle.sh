#!/usr/bin/env bash

# A request file may be replaced only while systemd has neither a running unit
# nor a queued job. Type=oneshot remains "activating" for the whole operation,
# including after the SSH client that started it has disconnected.
capstone_request_unit_accepts_new_work() {
  [[ $# -eq 1 ]] || return 1
  local unit=$1 snapshot key value
  local load_state="" active_state="" job=""
  local load_seen=0 active_seen=0 job_seen=0

  snapshot=$(systemctl show \
    --property=LoadState \
    --property=ActiveState \
    --property=Job \
    -- "${unit}") || return 1

  while IFS='=' read -r key value; do
    case "${key}" in
      LoadState)
        ((load_seen += 1))
        load_state=${value}
        ;;
      ActiveState)
        ((active_seen += 1))
        active_state=${value}
        ;;
      Job)
        ((job_seen += 1))
        job=${value}
        ;;
      *) return 1 ;;
    esac
  done <<<"${snapshot}"

  [[ ${load_seen} -eq 1 && ${active_seen} -eq 1 && ${job_seen} -eq 1 ]] || return 1
  [[ ${load_state} == loaded ]] || return 1
  [[ ${active_state} == inactive || ${active_state} == failed ]] || return 1
  [[ -z ${job} ]]
}
