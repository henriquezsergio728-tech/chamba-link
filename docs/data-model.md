# Data model

The schema is defined in [`api/src/db/schema.ts`](../api/src/db/schema.ts) and created by the SQL migrations in [`api/drizzle/`](../api/drizzle/). The database is Postgres 16.

## Enums

| Enum | Values |
| --- | --- |
| `account_role` | `provider`, `client` |
| `booking_status` | `pending`, `confirmed`, `cancelled` |

## Tables

### `accounts`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, default `gen_random_uuid()` |
| `role` | `account_role` | Not null |
| `display_name` | `text` | Not null |
| `created_at` | `timestamp with time zone` | Not null, default `now()` |

### `bookings`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, default `gen_random_uuid()` |
| `provider_id` | `uuid` | Not null, foreign key to `accounts.id` |
| `client_id` | `uuid` | Not null, foreign key to `accounts.id` |
| `during` | `tstzrange` | Not null, `bookings_during_bounded` |
| `status` | `booking_status` | Not null, default `pending` |
| `created_at` | `timestamp with time zone` | Not null, default `now()` |

The foreign keys do not check the `role` of the referenced account.

## The `during` column

`during` is a `tstzrange`, a range of timestamps with time zone. Drizzle has no built-in type for it, so `schema.ts` declares a custom type that passes the value through in Postgres text form, for example:

```text
[2026-11-02 09:00+00,2026-11-02 10:00+00)
```

## No-overlap guarantee

Migration `20261019013605_no-double-booking` adds two constraints to `bookings`:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_during_bounded"
  CHECK (NOT isempty("during") AND NOT lower_inf("during") AND NOT upper_inf("during"));

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_provider_overlap"
  EXCLUDE USING gist ("provider_id" WITH =, "during" WITH &&)
  WHERE ("status" <> 'cancelled');
```

- `bookings_no_provider_overlap` rejects a row whose `during` overlaps (`&&`) the `during` of another non-cancelled row with the same `provider_id`. A violation raises SQLSTATE `23P01` (`exclusion_violation`).
- `btree_gist` provides the GiST operator class that lets the constraint compare `uuid` with `=` alongside the range.
- `bookings_during_bounded` rejects empty ranges and ranges with an unbounded lower or upper end. A violation raises SQLSTATE `23514` (`check_violation`).
- Ranges written as `[start,end)` are half-open: the end instant is excluded, so a booking ending at 10:00 and another starting at 10:00 for the same provider do not overlap.
- Rows with status `cancelled` are excluded from the constraint and do not block their slot.
- The constraint applies per provider. Different providers can hold the same slot. Client bookings are not constrained.

The constraint is enforced by Postgres for every writer, independent of application code.

These constraints exist only in the migration SQL. They are not declared in `schema.ts` and do not appear in the drizzle-kit snapshots.

## Tests

[`api/test/booking-overlap.test.ts`](../api/test/booking-overlap.test.ts) runs against a real database inside one transaction that is rolled back at the end. Each insert runs inside a savepoint so that a rejected row does not abort the transaction. It covers:

| Case | Expected result |
| --- | --- |
| Overlapping booking for the same provider | `23P01` |
| Back-to-back bookings for the same provider | Both accepted |
| Same slot for a different provider | Both accepted |
| New booking over a `cancelled` booking's slot | Accepted |
| `empty` range | `23514` |
| Range with no upper bound | `23514` |
| Range with no lower bound | `23514` |
| Overlapping `pending` booking over a `confirmed` one | `23P01` |

[`api/test/booking-concurrency.test.ts`](../api/test/booking-concurrency.test.ts) exercises concurrent writers on separate pooled connections that commit. Each test creates its own accounts, and every row it creates is deleted in `afterAll`. It covers:

| Case | Expected result |
| --- | --- |
| Connection A holds an open transaction with a booking; B inserts an overlapping booking | B waits while A is open, then fails with `23P01` when A commits |
| Same, but A rolls back | B waits while A is open, then succeeds |
| 20 overlapping inserts for one provider sent at once on 20 distinct connections | Exactly one succeeds, 19 fail with `23P01` or `40P01`, and one row remains |

When concurrent inserters each see the other's uncommitted row, they wait on each other. Postgres breaks that cycle after `deadlock_timeout` and fails the waiter with `40P01` (`deadlock_detected`) instead of `23P01`.

In a one-off check against a scratch database with `bookings_no_provider_overlap` dropped manually, the three concurrency tests failed. The repository does not automate this check.

## Migrations

### Authoring

Migrations are generated from `schema.ts` with drizzle-kit, run from `api/`:

```bash
pnpm --filter @chamba/api exec drizzle-kit generate --name <name>
```

SQL that Drizzle cannot express in the schema, such as the exclusion constraint, goes into a custom migration:

```bash
pnpm --filter @chamba/api exec drizzle-kit generate --custom --name <name>
```

Each migration is a directory `api/drizzle/<timestamp>_<name>/` holding `migration.sql` and `snapshot.json`. Both are committed. `drizzle-kit push` is not used.

### Applying

| Context | Command | Configuration |
| --- | --- | --- |
| Local development and CI job `test` | `pnpm --filter @chamba/api exec drizzle-kit migrate` | `api/drizzle.config.ts`, which reads `DATABASE_URL` and loads `../.env` if present |
| CI job `image` | `node dist/migrate.js` inside the built image, run twice against a fresh Postgres | `DATABASE_URL` set on `docker run` |
| Production | `node dist/migrate.js` inside the API image | `DATABASE_URL` from `compose.prod.yaml` |

`api/src/migrate.ts` uses the `drizzle-orm` node-postgres migrator with `migrationsFolder: './drizzle'`. The image includes `api/drizzle/` because it is listed in the `files` field of `api/package.json`. On success it prints `migrations applied`.

Both paths record applied migrations in the table `drizzle.__drizzle_migrations`.
