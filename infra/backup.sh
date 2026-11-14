#!/bin/sh
# Backup loop for the `backup` compose service (restic image, BusyBox sh). No `set -x`: the
# environment holds the repository password and keys.
umask 077
DATA=${BACKUP_DATA_DIR:-/data}
STATUS=${BACKUP_LASTOK_DIR:-/status}
INTERVAL=${BACKUP_INTERVAL_SECONDS:-600}
CHECK_EVERY=${BACKUP_CHECK_EVERY_SECONDS:-604800}
MAX_SLEEP=${BACKUP_MAX_SLEEP_SECONDS:-21600}

log() { printf '{"time":"%s","service":"backup","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

if [ -z "$RESTIC_REPOSITORY" ]; then
  log "backups not configured: RESTIC_REPOSITORY is not set (see docs/OWNER_SETUP.md)"
  exec sleep infinity
fi

# Returns 0 once the repository exists and is readable. restic exits 10 only when the repository
# does not exist, so a network or password error never leads to init.
ensure_repo() {
  restic snapshots --quiet >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 10 ] || return 1
  restic init --quiet >/dev/null 2>&1
}

# The marker is written by the pipeline container, which this container must not trust: take only a
# regular file (not a symlink), at most 40 bytes, with timestamp characters. The value is never
# logged unless it passed.
read_ready() {
  f="$DATA/backup/ready"
  [ -e "$f" ] || [ -L "$f" ] || return 1
  if [ -L "$f" ] || [ ! -f "$f" ]; then log "ready marker invalid"; return 1; fi
  ready=$(head -c 41 "$f" 2>/dev/null | tr -d '\n')
  [ -n "$ready" ] || return 1
  case "$ready" in *[!0-9TZ:.-]*) log "ready marker invalid"; return 1;; esac
  [ "${#ready}" -le 40 ] || { log "ready marker invalid"; return 1; }
}

backup_once() {
  read_ready || return 0
  [ "$ready" = "$(cat "$STATUS/last-ok" 2>/dev/null)" ] && return 0
  ensure_repo || { log "backup failed: repository not reachable or not initialised"; return 1; }
  # data/clips exists only after the first clip is made, and restic exits 3 for a missing path.
  set -- "$DATA/backup/pipeline.db"
  [ -d "$DATA/clips" ] && set -- "$@" "$DATA/clips"
  restic backup --quiet --host pipeline -o s3.connections=2 "$@" >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 0 ] || { log "backup failed: restic backup rc=$rc"; return 1; }
  printf '%s\n' "$ready" > "$STATUS/last-ok.tmp" && mv "$STATUS/last-ok.tmp" "$STATUS/last-ok" \
    || { log "backup failed: cannot write last-ok"; return 1; }
  log "backup ok: snapshot $ready"
  # Retention is housekeeping: a failure is logged and the next cycle retries it.
  restic forget --quiet --host pipeline --keep-daily 7 --keep-weekly 4 --prune --retry-lock 1h >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 0 ] || log "forget failed: restic forget rc=$rc"
  return 0
}

check_weekly() {
  now=$(date +%s)
  last=$(cat "$STATUS/last-check" 2>/dev/null || echo 0)
  [ -f "$STATUS/last-ok" ] || return 0
  [ $((now - last)) -ge "$CHECK_EVERY" ] || return 0
  restic check --quiet --read-data-subset=5% >/dev/null 2>&1
  rc=$?
  printf '%s\n' "$now" > "$STATUS/last-check.tmp" && mv "$STATUS/last-check.tmp" "$STATUS/last-check"
  if [ "$rc" -eq 0 ]; then
    rm -f "$STATUS/check-failed"
    log "check ok"
  else
    date -u +%Y-%m-%dT%H:%M:%SZ > "$STATUS/check-failed"
    log "check failed: restic check rc=$rc"
  fi
}

wait_s=$INTERVAL
while :; do
  if backup_once; then
    check_weekly
    wait_s=$INTERVAL
  else
    wait_s=$((wait_s * 2))
    [ "$wait_s" -le "$MAX_SLEEP" ] || wait_s=$MAX_SLEEP
    log "retry in ${wait_s}s"
  fi
  sleep "$wait_s"
done
