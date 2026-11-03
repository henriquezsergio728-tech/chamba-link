# Data model

The schema is defined in [`api/src/db/schema.ts`](../api/src/db/schema.ts) and created by the SQL migrations in [`api/drizzle/`](../api/drizzle/). The database is Postgres 16.

## Enums

| Enum | Values |
| --- | --- |
| `account_role` | `provider`, `client` |
| `booking_status` | `pending`, `confirmed`, `declined`, `cancelled`, `expired`, `completed` |

## Tables

### `accounts`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, default `gen_random_uuid()` |
| `role` | `account_role` | Not null |
| `display_name` | `text` | Not null |
| `created_at` | `timestamp with time zone` | Not null, default `now()` |

`accounts_id_role_key` is `UNIQUE (id, role)`. It exists as the target of the composite foreign key from `provider_profiles`.

### `bookings`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, default `gen_random_uuid()` |
| `provider_id` | `uuid` | Not null, foreign key to `accounts.id` |
| `client_id` | `uuid` | Not null, foreign key to `accounts.id` |
| `service_id` | `uuid` | Not null, foreign key `bookings_service_id_fkey` to `services.id` |
| `during` | `tstzrange` | Not null, `bookings_during_bounded` |
| `status` | `booking_status` | Not null, default `pending` |
| `expires_at` | `timestamp with time zone` | Nullable; not null while `status` is `pending` (`bookings_pending_expires`) |
| `client_note` | `text` | Nullable, `bookings_client_note_length` (`char_length(client_note) <= 500`) |
| `created_at` | `timestamp with time zone` | Not null, default `now()` |
| `updated_at` | `timestamp with time zone` | Not null, default `now()` |

- The foreign keys do not check the `role` of the referenced account; the API creates bookings only for client accounts and active services of providers with a profile. None of them cascades, so an account or service with bookings cannot be deleted.
- `expires_at` is when a pending booking lapses: 24 hours after creation, or the start time if that comes sooner. A `pending` row whose `expires_at` has passed stays `pending` until the API marks it `expired`; the API reports it as `expired` before then. See [ADR 0014](decisions/0014-scheduling-model.md#decision).
- `bookings_client_id_created_at_idx` on `(client_id, created_at, id)` and `bookings_provider_id_created_at_idx` on `(provider_id, created_at, id)` serve `GET /v1/bookings`.
- Migration `20261102231916_bookings-lifecycle` replaces the enum `booking_status` instead of adding values with `ALTER TYPE ... ADD VALUE`, because an added value cannot be used in the transaction that adds it, and the new exclusion predicate in the same migration names the new values. It adds `service_id` as `NOT NULL` without a default, so it fails on a `bookings` table that already holds rows.

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
| `provider.profile.updated` | The provider | `{}` |
| `provider.service.created`, `provider.service.updated`, `provider.service.deactivated` | The provider | `{"serviceId": ...}` |
| `provider.availability.replaced` | The provider | `{}` |
| `provider.time_off.created`, `provider.time_off.deleted` | The provider | `{"timeOffId": ...}` |

| `booking.created` | The client | `{"bookingId": ..., "serviceId": ..., "providerId": ...}` |
| `booking.confirmed`, `booking.declined`, `booking.cancelled`, `booking.completed` | The party who made the change | `{"bookingId": ...}` |
| `booking.expired` | `null` | `{"bookingId": ...}`; written by the request whose booking insert marked the lapsed hold expired |
| `booking.rate_limited` | The client | `{"scope": "booking-client"}` |

Provider and booking events hold ids only, never text a provider or client wrote. `provider.service.deactivated` is written only when the service was active. `booking.rate_limited` is written once per account and window.

`auth.logout` is written only when the cookie named a session that was deleted. `auth.rate_limited` is written once per rate-limit key and window; see [ADR 0010](decisions/0010-rate-limiting.md#decision).

### `rate_limits`

| Column | Type | Constraints |
| --- | --- | --- |
| `key` | `text` | Not null, part of the primary key |
| `window_start` | `timestamp with time zone` | Not null, part of the primary key, index `rate_limits_window_start_idx` |
| `count` | `integer` | Not null |

The primary key `rate_limits_pkey` is `(key, window_start)`. Each row counts the hits for one key in one fixed window. Keys are `login:ip:<client>`, `register:ip:<client>`, `login:email:<hex SHA-256 of the lowercased email>` and `booking:account:<account id>`, where `<client>` is an IPv4 address or an IPv6 /64 such as `2001:db8:0:1/64`. The API computes `window_start` from its own clock and increments `count` with `INSERT ... ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1`. Rows whose `window_start` is more than 24 hours old are deleted by a sampled request; `rate_limits_window_start_idx` serves that deletion. See [ADR 0010](decisions/0010-rate-limiting.md).

### `provider_profiles`

| Column | Type | Constraints |
| --- | --- | --- |
| `account_id` | `uuid` | Primary key |
| `role` | `account_role` | Not null, default `provider`, `provider_profiles_role_provider` |
| `headline` | `text` | Not null |
| `bio` | `text` | Not null |
| `department` | `text` | Not null |
| `municipality` | `text` | Not null |
| `whatsapp_e164` | `text` | Nullable, `provider_profiles_whatsapp_e164` |
| `created_at` | `timestamp with time zone` | Not null, default `now()` |
| `updated_at` | `timestamp with time zone` | Not null, default `now()` |

- `provider_profiles_account_fkey` is `FOREIGN KEY (account_id, role) REFERENCES accounts (id, role) ON DELETE CASCADE`, and `provider_profiles_role_provider` is `CHECK (role = 'provider')`. Together they allow a profile only for a provider account. See [ADR 0014](decisions/0014-scheduling-model.md#decision).
- `provider_profiles_whatsapp_e164` is `CHECK (whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$')`.
- `department` holds a department slug from `api/src/domain.ts`; the API validates it, the column does not.

### `services`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, default `gen_random_uuid()` |
| `provider_id` | `uuid` | Not null, foreign key `services_provider_id_fkey` to `provider_profiles.account_id` `ON DELETE CASCADE`, index `services_provider_id_idx` |
| `title` | `text` | Not null |
| `description` | `text` | Not null |
| `category` | `text` | Not null |
| `price_from_cents` | `integer` | Nullable, `services_price_from_cents_nonnegative` (`>= 0`) |
| `duration_minutes` | `integer` | Not null, `services_duration_minutes_steps` (30 to 480, a multiple of 30) |
| `active` | `boolean` | Not null, default `true` |
| `created_at` | `timestamp with time zone` | Not null, default `now()` |

`services_created_at_id_idx` on `(created_at, id)` serves the catalog's keyset pagination. Deleting a service through the API sets `active` to `false`. Prices are in US dollar cents.

### `availability_rules`

| Column | Type | Constraints |
| --- | --- | --- |
| `provider_id` | `uuid` | Not null, foreign key `availability_rules_provider_id_fkey` to `provider_profiles.account_id` `ON DELETE CASCADE` |
| `weekday` | `smallint` | Not null, `availability_rules_weekday` (0 to 6, 0 = Sunday) |
| `start_time` | `time` | Not null |
| `end_time` | `time` | Not null, `availability_rules_end_after_start` (`end_time > start_time`) |

The primary key `availability_rules_pkey` is `(provider_id, weekday, start_time)`. Times are local wall-clock times in `America/El_Salvador`; `end_time` may be `24:00`. The migration adds an exclusion constraint that is not in `schema.ts`:

```sql
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_no_overlap"
  EXCLUDE USING gist ("provider_id" WITH =, "weekday" WITH =,
    tsrange(DATE '2000-01-01' + "start_time", DATE '2000-01-01' + "end_time") WITH &&);
```

`time` has no built-in range type, so each rule is compared as a half-open `tsrange` on a fixed date; `date + time` is immutable, as an exclusion constraint requires. Rules that touch, such as `09:00-12:00` and `12:00-13:00`, do not overlap. A violation raises `23P01`.

### `time_off`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, default `gen_random_uuid()` |
| `provider_id` | `uuid` | Not null, foreign key `time_off_provider_id_fkey` to `provider_profiles.account_id` `ON DELETE CASCADE` |
| `during` | `tstzrange` | Not null, `time_off_during_bounded` |
| `created_at` | `timestamp with time zone` | Not null, default `now()` |

`time_off_during_bounded` is the same check as `bookings_during_bounded`. The GiST index `time_off_provider_id_during_idx` on `(provider_id, during)` serves the overlap query of the slots route.

### Privileges of `chambalink_app` on these tables

Granted by migration `20261102225353_provider-catalog`, which creates the tables:

| Table | Privileges |
| --- | --- |
| `provider_profiles` | `SELECT`, `INSERT`; `UPDATE` on `headline`, `bio`, `department`, `municipality`, `whatsapp_e164`, `updated_at` |
| `services` | `SELECT`, `INSERT`; `UPDATE` on `title`, `description`, `category`, `price_from_cents`, `duration_minutes`, `active` |
| `availability_rules` | `SELECT`, `INSERT`, `DELETE` |
| `time_off` | `SELECT`, `INSERT`, `DELETE` |
| `bookings` | `SELECT`, for the slots query. `20261102231916_bookings-lifecycle` adds `INSERT` and `UPDATE` on `status` and `updated_at` |

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

Migration `20261102231916_bookings-lifecycle` drops `bookings_no_provider_overlap` and adds it again with the predicate it has now:

```sql
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_provider_overlap"
  EXCLUDE USING gist ("provider_id" WITH =, "during" WITH &&)
  WHERE ("status" IN ('pending', 'confirmed', 'completed'));
```

- `bookings_no_provider_overlap` rejects a row whose `during` overlaps (`&&`) the `during` of another `pending`, `confirmed` or `completed` row with the same `provider_id`. A violation raises SQLSTATE `23P01` (`exclusion_violation`).
- The predicate cannot depend on the time, so a `pending` row past its `expires_at` still counts until the API marks it `expired`; the API does that in the transaction that inserts a booking for the provider. See [ADR 0014](decisions/0014-scheduling-model.md#decision).
- `btree_gist` provides the GiST operator class that lets the constraint compare `uuid` with `=` alongside the range.
- `bookings_during_bounded` rejects empty ranges and ranges with an unbounded lower or upper end. A violation raises SQLSTATE `23514` (`check_violation`).
- Ranges written as `[start,end)` are half-open: the end instant is excluded, so a booking ending at 10:00 and another starting at 10:00 for the same provider do not overlap.
- Rows with status `declined`, `cancelled` or `expired` are excluded from the constraint and do not block their slot.
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
- The table's owner can drop or disable the trigger and `TRUNCATE` the table. The API's role, `chambalink_app`, has only `INSERT` on `audit_log` and can do neither. See [ADR 0009](decisions/0009-accounts-and-sessions.md#consequences) and [ADR 0013](decisions/0013-least-privilege-database-role.md).
- Like the booking constraints, the function and trigger exist only in the migration SQL, not in `schema.ts` or the snapshots.

Because rows cannot be deleted, tests that write audit rows leave them in the database, and select them by the client address of the request that wrote them instead of counting rows.

## Tests

[`api/test/booking-overlap.test.ts`](../api/test/booking-overlap.test.ts) runs against a real database inside one transaction that is rolled back at the end. Each insert runs inside a savepoint so that a rejected row does not abort the transaction. Both providers get a profile and a service, which every booking references, and pending bookings get an `expires_at`. It covers:

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
| New booking over a `declined` and an `expired` booking's slot | Accepted |
| Overlapping `confirmed` booking over a `completed` one | `23P01` |
| `pending` booking without `expires_at` | `23514` |

[`api/test/booking-concurrency.test.ts`](../api/test/booking-concurrency.test.ts) exercises concurrent writers on separate pooled connections that commit. Each test creates its own accounts, provider profile and service, and every row it creates is deleted in `afterAll`. It covers:

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
| Production | `docker compose run --rm migrate`, which runs `node dist/migrate.js` inside the API image | `DATABASE_URL` set from `MIGRATE_DATABASE_URL` by the `migrate` service in `deploy/app/migrate.yaml` |

`api/src/migrate.ts` uses the `drizzle-orm` node-postgres migrator with `migrationsFolder: './drizzle'`. The image includes `api/drizzle/` because it is listed in the `files` field of `api/package.json`. On success it prints `migrations applied`.

Both paths record applied migrations in the table `drizzle.__drizzle_migrations`.
