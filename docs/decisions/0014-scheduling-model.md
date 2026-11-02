# 0014. Scheduling model

## Context

Providers publish a profile, a catalog of services and weekly availability; clients browse the catalog and look for free times. The rules for time, money, categories and places affect every route and table, so they are settled once, as constants in [`api/src/domain.ts`](../../api/src/domain.ts), not as environment variables that could differ between deployments.

## Decision

**Fixed values.** `api/src/domain.ts` exports:

| Constant | Value |
| --- | --- |
| `TIMEZONE`, `UTC_OFFSET_MINUTES` | `America/El_Salvador`, `-360` |
| `CURRENCY` | `USD` |
| `CATEGORIES` | `plumbing`, `electrical`, `cleaning`, `gardening`, `beauty`, `mechanics`, `construction`, `tutoring`, `other` |
| `DEPARTMENTS` | `ahuachapan`, `santa-ana`, `sonsonate`, `chalatenango`, `la-libertad`, `san-salvador`, `cuscatlan`, `la-paz`, `cabanas`, `san-vicente`, `usulutan`, `san-miguel`, `morazan`, `la-union` |
| `SLOT_STEP_MINUTES` | `30` |
| `SERVICE_DURATION_MIN_MINUTES`, `SERVICE_DURATION_MAX_MINUTES` | `30`, `480` |
| `BOOKING_MIN_LEAD_MINUTES`, `BOOKING_HORIZON_DAYS` | `60`, `60` |
| `SLOTS_MAX_RANGE_DAYS` | `14` |
| `WHATSAPP_BASE_URL` | `https://wa.me/` |

Categories and departments are TypeBox unions of these slugs in the API ([`api/src/schemas.ts`](../../api/src/schemas.ts)); the columns are `text` without a check, so adding a slug needs no migration.

**Time.** There is one timezone. El Salvador does not observe daylight saving time, so local time is always UTC-6 and [`api/src/time.ts`](../../api/src/time.ts) converts with the fixed offset instead of a timezone database. Availability rules are local wall-clock `time` values; instants are stored as `timestamptz` and `tstzrange`. Requests accept ISO 8601 timestamps with any offset (`format: date-time`, which requires one); responses write them in local time with the offset, for example `2026-11-03T09:00:00-06:00`.

**Availability.** A provider's weekly rules are `(weekday, start, end)` with `0` = Sunday. Times are on the half-hour grid (`HH:00` or `HH:30`), and an end of `24:00` means the midnight that ends the day. `PUT /v1/providers/me/availability` replaces all rules in one transaction, after locking the provider's profile row so that concurrent replaces run one after the other. The API rejects a rule that does not end after it starts (`422 INVALID_RULE`) and rules that overlap on one weekday (`422 OVERLAPPING_RULES`); the database enforces the same with `availability_rules_end_after_start` and the exclusion constraint `availability_rules_no_overlap` ([Data model](../data-model.md#availability_rules)). Time off is a bounded `tstzrange` per provider.

**Slots.** `GET /v1/providers/:id/slots?serviceId=&from=&to=` computes free slots in [`api/src/catalog/slots.ts`](../../api/src/catalog/slots.ts), a pure function of the rules, the blocked intervals, the service duration, the range and the current time:

1. For each local day that the range touches, the day's rules are sorted and rules that touch are merged, so a service can span two adjacent rules.
2. Inside each merged interval, a candidate starts at the interval's start and every 30 minutes after it, as long as the whole service ends by the interval's end. Rules are on the half-hour grid, so every start is too. Availability ends at local midnight and does not continue into the next day's rules.
3. A candidate is kept if its start is in `[from, to)`, at least 60 minutes from now and at most 60 days from now, and its `[start, start + duration)` overlaps no blocked interval. Ranges are half-open, so a slot that ends when a booking starts is free.

Blocked intervals are the provider's time off and bookings with a status other than `cancelled`, the rows that `bookings_no_provider_overlap` compares, that overlap `[from, to + duration)`. The range may span at most 14 days and `to` must be after `from` (`422 INVALID_RANGE`). The service must be active and belong to the provider (`404`). Times come from the application clock, as in [ADR 0010](0010-rate-limiting.md#decision).

**Profiles belong to providers.** `provider_profiles` has a `role` column, always `provider` by `CHECK`, and a composite foreign key `(account_id, role)` to `accounts (id, role)`, which the migration makes unique for that purpose. A client account cannot have a profile, in the database as well as in the API, without a trigger. `accounts.role` cannot change while a profile references it, because the foreign key has no `ON UPDATE` action; the API has no route that changes a role. Services, availability rules and time off reference the profile, so a provider creates the profile first; until then those writes answer `409 PROFILE_REQUIRED`.

**WhatsApp.** A provider may store a number in E.164 form (`^\+[1-9][0-9]{7,14}$`, checked by the schema and by `provider_profiles_whatsapp_e164`). `GET /v1/providers/:id` returns `whatsappLink`, `https://wa.me/<digits>?text=<message>` with the URL-encoded message `Hola <display name>, vi su perfil en ChambaLink.`, built in [`api/src/providers/whatsapp.ts`](../../api/src/providers/whatsapp.ts), or `null` without a number. No WhatsApp API is called.

**Grants per migration.** The migration that creates a table grants `chambalink_app` exactly the privileges the API's statements need ([ADR 0013](0013-least-privilege-database-role.md)). `UPDATE` is granted per column where the API updates only some columns, so a statement that writes any other column fails with `permission denied`.

**Caching.** Routes under `/v1/providers/me` send `Cache-Control: no-store` on every response, like the account routes. Public routes set caching headers on `200` responses only, so errors are not kept by shared caches:

| Route | `Cache-Control` | `ETag` |
| --- | --- | --- |
| `GET /v1/services`, `GET /v1/providers/:id` | `public, max-age=30, stale-while-revalidate=60` | Strong: the base64url SHA-256 of the serialized body, in quotes |
| `GET /v1/providers/:id/slots` | `public, max-age=15` | None |

A request whose `If-None-Match` lists the current ETag, with or without a `W/` prefix, or `*`, receives `304` with an empty body and the same `ETag` and `Cache-Control`. The ETag is computed after the body is serialized, in an `onSend` hook ([`api/src/catalog/http-cache.ts`](../../api/src/catalog/http-cache.ts)), so it changes whenever the body does; the database is still queried for a `304`.

**Catalog pagination.** `GET /v1/services` orders active services by `(created_at, id)` descending and pages with a keyset. The cursor is the base64url JSON of the last row's `created_at` in Postgres text form, which keeps microseconds, and its `id`; the next page selects rows with `(created_at, id)` below it. A cursor this API did not produce answers `400 INVALID_CURSOR`. `limit` is 1 to 50, default 20. `q` matches a case-insensitive substring of the title with `ILIKE`, with `%`, `_` and `\` escaped so they match only themselves.

**Nullable fields.** Fastify's Ajv instance coerces types, and coerces `null` to `0` or `""` when it tries the first branch of `anyOf [integer, null]`. Nullable fields are therefore declared as a JSON Schema type array, `{"type": ["integer", "null"]}`, with the `Nullable` helper in `api/src/schemas.ts`.

## Alternatives

- **A timezone database (`Intl`) instead of a fixed offset.** It would follow any change to El Salvador's rules that reaches the timezone database, but every conversion would depend on the ICU data shipped in the Node image, and the product has one timezone without daylight saving time.
- **A trigger that checks `accounts.role`.** It would work, but the composite foreign key gives the same guarantee declaratively and is enforced on account changes as well.
- **Offset pagination.** Simpler, but inserts between requests shift pages and cause repeated or skipped rows.
- **Weak ETags or `Last-Modified`.** `services` has no update timestamp, and a hash of the body detects every change, including a changed provider name.

## Consequences

- Changing a fixed value is a code change that applies to every deployment.
- A client sees times in UTC-6 regardless of where it runs.
- A provider whose availability crosses midnight gives two rules, one ending at `24:00` and one starting at `00:00`; a service cannot span them.
- A `304` saves bandwidth but not the database query.
- A shared cache can serve a catalog page or a provider page up to 90 seconds old, and slots up to 15 seconds old; a slot shown as free can therefore already be taken.
- Deactivated services stay in the table and in the provider's own list; no route reactivates one.
