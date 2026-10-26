# 0011. Logical database backups to Object Storage

## Context

Production is a single VM. The Postgres data lives only in the Docker volume `pgdata` on that VM, so losing the VM, its boot volume or the volume loses every account, session, booking and audit row. The VM has an OCI instance principal, so it can call Object Storage without API keys or a CLI config file on disk.

## Decision

Every six hours a systemd timer on the host, `chambalink-backup.timer` ([`ops/systemd/`](../../ops/systemd/)), starts `chambalink-backup.service`, which runs [`ops/backup.sh`](../../ops/backup.sh) as root from the checkout at `/opt/chambalink`:

1. Take a non-blocking `flock`, so two runs never overlap.
2. Dump the database with `pg_dump -Fc` through `docker compose exec -T db`, into a mode `600` temporary file that is deleted on exit.
3. Check that the file is not empty and that `pg_restore --list` reads it.
4. Upload it with the OCI CLI and `--auth instance_principal` to a private Object Storage bucket with versioning on, as `postgres/YYYY/MM/chambalink-YYYYMMDDTHHMMSSZ.dump`, with `--no-overwrite`.
5. Read the object's `content-length` back from the bucket and compare it with the local file size.

The instance principal's policy limits it to that bucket. The timer fires at 00:15, 06:15, 12:15 and 18:15 UTC with up to 120 s of random delay, and `Persistent=true` runs a missed backup after the host comes back up. A run prints `backup ok: <name> <bytes> bytes in <seconds>s` to the journal, or a `backup: ...` error and a non-zero exit, which marks the service run as failed.

A manual drill on the production VM on 2026-10-25 produced a 17 KB dump in 0.33 s. Restoring it into a scratch database took 0.48 s. Row counts were identical in all tables, and the restored database had the booking exclusion constraint `bookings_no_provider_overlap` and the audit trigger `audit_log_append_only`.

## Consequences

- The recovery point objective is up to six hours: a failure can lose the writes since the last successful backup.
- Dumps are not encrypted on the client. The bucket is private, and the provider encrypts stored objects.
- The permission that lets the host create objects also lets it delete them. Versioning is what keeps a deleted or overwritten backup recoverable.
- Containers on the host can reach the instance metadata service by default, and with it the instance principal's credentials.
- No retention or lifecycle rule exists, so objects, and their versions, accumulate.
- All backups are in one region.
- Restoring is manual.
- An upload is verified by comparing sizes, not checksums.
- A failed run is visible only in the systemd journal and the unit's state.
