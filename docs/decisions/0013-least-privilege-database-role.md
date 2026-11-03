# 0013. Least-privilege database role

## Context

The API connected with `DATABASE_URL` as `POSTGRES_USER`, the role that the `postgres` image creates as a superuser when it initializes an empty volume, and which owns every table because the migrator runs as it too. Any query the API could be made to run, and anyone holding its credentials, could therefore drop or disable the `audit_log` trigger, `TRUNCATE` any table, read the migration history and create extensions ([ADR 0009](0009-accounts-and-sessions.md), [ADR 0012](0012-dedicated-database-host.md)).

## Decision

The API connects as `chambalink_app`, a role that can only read and write rows. The owner role is used only by the migrator.

**Role.** The custom migration [`20261101043547_app-role`](../../api/drizzle/20261101043547_app-role/migration.sql) creates `chambalink_app` as `NOLOGIN` if no role of that name exists. Roles are cluster-wide, so the check keeps the migration safe on a cluster where the role already exists. The repository holds no password for it: its login and password are set on the database host outside the repository ([Deployment](../deployment.md#database-roles)).

**Grants.** The migration grants `USAGE` on schema `public` and, per table, exactly what the statements in `api/src` run. `INSERT ... RETURNING` and `DELETE ... WHERE` read columns, so they also need `SELECT`.

| Table | Privileges | Used by |
| --- | --- | --- |
| `accounts` | `SELECT`, `INSERT` | Registration (`INSERT ... RETURNING id`), login and session lookup joins |
| `account_credentials` | `SELECT`, `INSERT` | Registration, login, session lookup |
| `sessions` | `SELECT`, `INSERT`, `DELETE` | Session start, lookup, logout (`DELETE ... RETURNING`), expired-session cleanup |
| `audit_log` | `INSERT` | `api/src/audit.ts`; the API never reads the table |
| `rate_limits` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, `peek`, `reset`, `prune` |
| `bookings` | none in this migration | `SELECT` is granted by `20261102225353_provider-catalog` for the slots query, and `INSERT` and `UPDATE` on `status` and `updated_at` by `20261102231916_bookings-lifecycle` ([ADR 0014](0014-scheduling-model.md#decision)) |

No table grants `TRUNCATE`, and `audit_log` grants no `SELECT`, `UPDATE` or `DELETE`. The only sequence in `public` belongs to the `audit_log` identity column, which needs no sequence privilege. The role has nothing on schema `drizzle`, which holds the migration history and its serial sequence.

**Migrator.** [`deploy/app/migrate.yaml`](../../deploy/app/migrate.yaml), an overlay for [`compose.prod.yaml`](../../compose.prod.yaml), defines a `migrate` service in the profile `migrate`, with the API image and `command: ["node", "dist/migrate.js"]`. Its only environment variable is `DATABASE_URL`, set from `MIGRATE_DATABASE_URL`, the owner's URL. `docker compose up` does not start it, and the `api` service receives only `DATABASE_URL`, so the owner URL never reaches the API container. Migrations run with `docker compose run --rm migrate`.

**Tests.** [`api/test/app-role.test.ts`](../../api/test/app-role.test.ts) runs `SET LOCAL ROLE chambalink_app` inside rolled-back transactions and checks what the role can and cannot do. [`api/test/auth.test.ts`](../../api/test/auth.test.ts) runs the API with the startup option `-c role=chambalink_app` and keeps an owner connection for setup, cleanup and checks of `audit_log`. Both need a test connection whose user is a superuser or a member of `chambalink_app`; CI's `POSTGRES_USER` is the image's superuser.

## Alternatives

- **Keep one role.** No setup step, but the API keeps superuser rights.
- **A second, hand-created migrator role.** A role created by hand to own the tables and run the migrations would keep the superuser out of migrations as well, but it exists outside the migrations, needs the existing tables transferred to it, and is one more credential set by hand on every database.
- **Row-level security.** Policies restrict which rows a statement sees, not which statements a role may run. Superusers always bypass them, and the table owner does unless the table forces them. The API has no per-row rules to express.

## Consequences

- The application host's `.env` still holds the owner's credentials, in `MIGRATE_DATABASE_URL`, for the migrate step.
- Docker Compose interpolates the `migrate` service even when its profile is not active, so every `docker compose` command in a clone whose `COMPOSE_FILE` lists `deploy/app/migrate.yaml` fails while `MIGRATE_DATABASE_URL` is unset. A node that runs only the API leaves that file out of `COMPOSE_FILE` and does not need the variable.
- The role's login and password are set by hand on the database host; nothing in the repository sets or rotates them.
- A table added later has no privileges for `chambalink_app`. The migration that creates it must grant what the API needs; otherwise the API's queries on it fail with `permission denied`.
- A query outside the grants fails with `permission denied` and is answered as a generic `500` ([ADR 0008](0008-api-conventions.md)).
- The owner can still drop or disable the `audit_log` trigger and `TRUNCATE` the table; the API cannot.
