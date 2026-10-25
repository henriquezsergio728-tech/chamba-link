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

### `account_credentials`

| Column | Type | Constraints |
| --- | --- | --- |
| `account_id` | `uuid` | Primary key, foreign key to `accounts.id` `ON DELETE CASCADE` |
| `email` | `text` | Not null, unique (`account_credentials_email_key`) |
| `password_hash` | `text` | Not null |
| `created_at` | `timestamp with time zone` | Not null, default `now()` |

`account_credentials_email_normalized` is `CHECK (email = lower(email) AND char_length(email) <= 254)`. The API lowercases emails before writing them, and maps a unique violation (`23505`) on `account_credentials_email_key` to `409 EMAIL_TAKEN`. `password_hash` is an argon2id PHC string; see [ADR 0009](decisions/0009-accounts-and-sessions.md).

### `sessions`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, default `gen_random_uuid()` |
| `account_id` | `uuid` | Not null, foreign key to `accounts.id` `ON DELETE CASCADE`, index `sessions_account_id_idx` |
| `token_hash` | `text` | Not null, unique |
| `created_at` | `timestamp with time zone` | Not null, default `now()` |
| `expires_at` | `timestamp with time zone` | Not null |

`token_hash` is the hex SHA-256 of the session cookie's token, 64 characters. The token itself is not stored. The API sets `expires_at` to 30 days after creation and treats a row whose `expires_at` has passed as no session.

### `audit_log`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `bigint` | Primary key, `GENERATED ALWAYS AS IDENTITY` |
| `at` | `timestamp with time zone` | Not null, default `now()` |
| `actor_account_id` | `uuid` | Nullable, no foreign key |
| `event` | `text` | Not null |
| `ip` | `text` | Nullable |
| `request_id` | `text` | Nullable |
| `metadata` | `jsonb` | Not null, default `'{}'` |

`actor_account_id` has no foreign key so that rows remain after the account is deleted. Events written by the API:

| `event` | `actor_account_id` | `metadata` |
| --- | --- | --- |
| `account.registered` | The new account | `{"role": ...}` |
| `auth.login.succeeded` | The account | `{}` |
| `auth.login.failed` | `null` | `{"emailSha256": ...}`, the hex SHA-256 of the lowercased email |
| `auth.logout` | The session's account | `{}` |
| `auth.rate_limited` | `null` | `{"scope": "login-ip" \| "login-email" \| "register-ip"}` |

`auth.logout` is written only when the cookie named a session that was deleted. `auth.rate_limited` is written once per rate-limit key and window; see [ADR 0010](decisions/0010-rate-limiting.md#decision).

### `rate_limits`

| Column | Type | Constraints |
| --- | --- | --- |
| `key` | `text` | Not null, part of the primary key |
| `window_start` | `timestamp with time zone` | Not null, part of the primary key, index `rate_limits_window_start_idx` |
| `count` | `integer` | Not null |

The primary key `rate_limits_pkey` is `(key, window_start)`. Each row counts the hits for one key in one fixed window. Keys are `login:ip:<client>`, `register:ip:<client>` and `login:email:<hex SHA-256 of the lowercased email>`, where `<client>` is an IPv4 address or an IPv6 /64 such as `2001:db8:0:1/64`. The API computes `window_start` from its own clock and increments `count` with `INSERT ... ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1`. Rows whose `window_start` is more than 24 hours old are deleted by a sampled request; `rate_limits_window_start_idx` serves that deletion. See [ADR 0010](decisions/0010-rate-limiting.md).

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

## Append-only audit log

Migration `20261025194207_audit-log-append-only` is a custom migration that adds a function and a row trigger:

```sql
CREATE FUNCTION "audit_log_reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_change"();
```

- Any `UPDATE` or `DELETE` that touches a row fails with SQLSTATE `42501` (`insufficient_privilege`) and the message `audit_log is append-only: UPDATE is not allowed` or `... DELETE ...`.
- `TRUNCATE` does not fire row triggers and is not blocked.
- The table's owner can drop or disable the trigger. See [ADR 0009](decisions/0009-accounts-and-sessions.md#consequences).
- Like the booking constraints, the function and trigger exist only in the migration SQL, not in `schema.ts` or the snapshots.

Because rows cannot be deleted, tests that write audit rows leave them in the database, and select them by the client address of the request that wrote them instead of counting rows.

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
