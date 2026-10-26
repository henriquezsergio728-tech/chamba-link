#!/usr/bin/env bash
# Dumps the Compose `db` service with pg_dump -Fc, checks the archive, and uploads it to Object Storage
# with the host's instance principal. Runs as root from chambalink-backup.service.
set -euo pipefail
umask 077

BACKUP_BUCKET="${BACKUP_BUCKET:-}"
OCI_CLI="${OCI_CLI:-oci}"
BACKUP_LOCK="${BACKUP_LOCK:-/run/lock/chambalink-backup.lock}"

fail() {
  echo "backup: $*" >&2
  exit 1
}

[[ -n "$BACKUP_BUCKET" ]] || fail "BACKUP_BUCKET is required"

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." || fail "cannot change to the repository root"

exec 9>"$BACKUP_LOCK" || fail "cannot open lock file $BACKUP_LOCK"
flock -n 9 || fail "another backup is running (lock $BACKUP_LOCK is held)"

tmp="$(mktemp "${TMPDIR:-/tmp}/chambalink-backup-XXXXXX.dump")" || fail "cannot create a temporary file"
trap 'rm -f "$tmp"' EXIT
# A signal, such as SIGTERM from systemd at TimeoutStartSec, exits through the EXIT trap.
trap 'exit 1' HUP INT TERM

# Single quotes: $POSTGRES_USER and $POSTGRES_DB expand inside the container, from its own environment.
# shellcheck disable=SC2016
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' </dev/null >"$tmp" \
  || fail "pg_dump failed"
[[ -s "$tmp" ]] || fail "pg_dump produced an empty file"
docker compose exec -T db pg_restore --list <"$tmp" >/dev/null || fail "pg_restore --list rejected the archive"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
name="postgres/${ts:0:4}/${ts:4:2}/chambalink-${ts}.dump"
size="$(stat -c %s "$tmp")"

"$OCI_CLI" os object put --auth instance_principal --bucket-name "$BACKUP_BUCKET" --name "$name" --file "$tmp" \
  --no-overwrite >/dev/null || fail "upload of $name failed"

remote="$("$OCI_CLI" os object head --auth instance_principal --bucket-name "$BACKUP_BUCKET" --name "$name" \
  --query '"content-length"' --raw-output)" || fail "cannot read $name back from the bucket"
[[ "$remote" == "$size" ]] || fail "size mismatch for $name: local $size bytes, remote ${remote:-none}"

echo "backup ok: $name $size bytes in ${SECONDS}s"
