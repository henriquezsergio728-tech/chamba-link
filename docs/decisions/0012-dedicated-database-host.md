# 0012. Dedicated database host

## Context

[ADR 0005](0005-compose-overlay-host-nginx.md) ran `db` and `api` as one Compose project on one arm64 VM, so Postgres shared that VM's CPU and memory with the API and nginx, and the database existed only on the host that served requests. An application node with its own Postgres serves only its own data: the booking exclusion constraint ([ADR 0003](0003-exclusion-constraint-double-booking.md)) and the rate-limit counters ([ADR 0010](0010-rate-limiting.md)) hold only within one database.

## Decision

Run Postgres alone on a dedicated database host, and run only the API on the application host.

| Host | Shape | Runs |
| --- | --- | --- |
| Application host | VM.Standard.A1.Flex, arm64 | nginx on the host; the `api` container from [`compose.prod.yaml`](../../compose.prod.yaml) with [`deploy/app/compose.yaml`](../../deploy/app/compose.yaml), with `DATABASE_URL` pointing at the database host |
| Database host | VM.Standard.E2.1.Micro, x86_64 | The `db` container from [`deploy/db/compose.yaml`](../../deploy/db/compose.yaml), with port 5432 published only on the host's private address (`DB_BIND_ADDR`) |

Both hosts use the same `postgres:16` image digest, an image index that covers `linux/amd64` and `linux/arm64/v8`. `deploy/db/compose.yaml` starts Postgres with `max_connections=50`, `shared_buffers=128MB` and `effective_cache_size=384MB`.

Two network security groups control access to 5432. `app-nodes` has no rules of its own and holds the application host's VNIC. `db-host` holds the database host's VNIC and has one ingress rule: TCP 5432 from `app-nodes`. The subnet's security list has no rule for 5432. Docker-published ports bypass the host's iptables `INPUT` rules, so the gate is the bind address, the network security groups and the Postgres password.

The backups of [ADR 0011](0011-database-backups.md) run on the database host.

### Measured evidence

pgbench at scale 5 with 8 clients, on each shape, with the same pinned image and the same three settings:

| Test | VM.Standard.E2.1.Micro (x86_64) | VM.Standard.A1.Flex (arm64) |
| --- | --- | --- |
| Write, 60 s | 380 TPS | 1088 TPS |
| Write, 300 s | 401.9 TPS on average, range 374-415, no decay over the run | not measured |
| Read-only | 2311-3492 TPS | 11675 TPS |

The database host sustains about a third of the A1's write rate.

A dump taken by the backup job on the arm64 host restored on the x86_64 host in about 15 seconds including the download, for a 17 KB dump. See [Restoring from a backup](../deployment.md#restoring-from-a-backup).

## Alternatives

- **Postgres on each application node.** Each node would hold its own data, so bookings, sessions and rate-limit counters would not be shared between nodes.
- **A streaming replica.** A replica adds a second copy and read capacity, but writes still go to one primary, and it needs a second database host and a replication setup.
- **A managed database.** OCI's managed PostgreSQL is not part of the Always Free tier.

## Consequences

- The database host is a single point of failure. A lost host or volume is covered by the backups, with a recovery point of at most six hours ([ADR 0011](0011-database-backups.md)).
- Traffic between the hosts on the private network is not encrypted with TLS; `deploy/db/compose.yaml` configures none.
- The API connects as `POSTGRES_USER`, which the `postgres` image creates as a superuser and which owns the tables, so the API can drop or disable the `audit_log` trigger ([Data model](../data-model.md#audit_log)) and holds more privilege than its queries need.
- `max_connections=50` bounds all connections. `api/src/db.ts` sets no pool size, so each API process opens up to node-postgres's default of 10 connections: 4 processes can use 40 of the 50 connections and 5 reach the limit, with the migrator, the backup job and `psql` sessions also counting against it.
- The database host writes at about a third of the A1's rate (see [Measured evidence](#measured-evidence)).
- Every query crosses the private network instead of a Docker bridge on the same host.
