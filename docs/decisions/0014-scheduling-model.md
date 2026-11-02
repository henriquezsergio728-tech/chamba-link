# 0014. Scheduling model

## Context

Providers publish a profile, a catalog of services and weekly availability; clients browse the catalog, look for free times and book them, and providers confirm or decline. A booking must hold its slot while the provider decides, but not forever. The rules for time, money, categories and places affect every route and table, so they are settled once, as constants in [`api/src/domain.ts`](../../api/src/domain.ts), not as environment variables that could differ between deployments.

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
| `PENDING_HOLD_HOURS` | `24` |
| `SLOTS_MAX_RANGE_DAYS` | `14` |
| `WHATSAPP_BASE_URL` | `https://wa.me/` |

Categories and departments are TypeBox unions of these slugs in the API ([`api/src/schemas.ts`](../../api/src/schemas.ts)); the columns are `text` without a check, so adding a slug needs no migration.

**Time.** There is one timezone. El Salvador does not observe daylight saving time, so local time is always UTC-6 and [`api/src/time.ts`](../../api/src/time.ts) converts with the fixed offset instead of a timezone database. Availability rules are local wall-clock `time` values; instants are stored as `timestamptz` and `tstzrange`. Requests accept ISO 8601 timestamps with any offset (`format: date-time`, which requires one); responses write them in local time with the offset, for example `2026-11-03T09:00:00-06:00`.

**Availability.** A provider's weekly rules are `(weekday, start, end)` with `0` = Sunday. Times are on the half-hour grid (`HH:00` or `HH:30`), and an end of `24:00` means the midnight that ends the day. `PUT /v1/providers/me/availability` replaces all rules in one transaction, after locking the provider's profile row so that concurrent replaces run one after the other. The API rejects a rule that does not end after it starts (`422 INVALID_RULE`) and rules that overlap on one weekday (`422 OVERLAPPING_RULES`); the database enforces the same with `availability_rules_end_after_start` and the exclusion constraint `availability_rules_no_overlap` ([Data model](../data-model.md#availability_rules)). Time off is a bounded `tstzrange` per provider.

**Slots.** `GET /v1/providers/:id/slots?serviceId=&from=&to=` computes free slots in [`api/src/catalog/slots.ts`](../../api/src/catalog/slots.ts), a pure function of the rules, the blocked intervals, the service duration, the range and the current time:

1. For each local day that the range touches, the day's rules are sorted and rules that touch are merged, so a service can span two adjacent rules.
2. Inside each merged interval, a candidate starts at the interval's start and every 30 minutes after it, as long as the whole service ends by the interval's end. Rules are on the half-hour grid, so every start is too. Availability ends at local midnight and does not continue into the next day's rules.
3. A candidate is kept if its start is in `[from, to)`, at least 60 minutes from now and at most 60 days from now, and its `[start, start + duration)` overlaps no blocked interval. Ranges are half-open, so a slot that ends when a booking starts is free.

Blocked intervals are the provider's time off and the bookings that hold their slot at the current time (see **Holds and lazy expiry**), that overlap `[from, to + duration)`. The range may span at most 14 days and `to` must be after `from` (`422 INVALID_RANGE`). The service must be active and belong to the provider (`404`). Times come from the application clock, as in [ADR 0010](0010-rate-limiting.md#decision).

**Bookings.** `POST /v1/bookings` (client accounts only) takes `serviceId`, `start` and an optional `clientNote` of up to 500 characters. The service must be active (`404`). `start` must be on the half-hour (`422 START_MISALIGNED`); the offset is a whole number of hours, so the local half-hour grid is the UTC one. It must lie between 60 minutes and 60 days from now (`422 OUTSIDE_HORIZON`). Then, in one transaction, the API expires the provider's lapsed holds, checks that the whole service fits inside the provider's availability by running the slot function on that one start (`422 OUTSIDE_AVAILABILITY`) and that it overlaps no time off (`422 TIME_OFF`), inserts the booking as `pending` and writes `booking.created`. An exclusion violation (`23P01`) on `bookings_no_provider_overlap` answers `409 SLOT_TAKEN`. Concurrent inserters for one slot can wait on each other's uncommitted rows, and Postgres then fails one with `40P01` instead ([Data model](../data-model.md#tests)); the API retries the transaction once after a `40P01` and answers `409 SLOT_TAKEN` if it fails again. The response carries `whatsappLink`, a `wa.me` link to the provider with the message `Hola <display name>, reservé "<service>" para el <YYYY-MM-DD HH:MM> (hora de El Salvador). Referencia: <reference>.`, or `null` without a number. The reference is `CL-` and the first 8 characters of the booking id in upper case; it is for people to quote and is not guaranteed unique.

**Holds and lazy expiry.** A booking is created `pending` with `expires_at` set to 24 hours after creation, or to its start time if that comes sooner. `bookings_no_provider_overlap` blocks `pending`, `confirmed` and `completed` bookings and ignores `declined`, `cancelled` and `expired` ones. A pending booking whose `expires_at` has passed should stop blocking, but a constraint's predicate, like an index predicate, may use only immutable expressions, so it cannot compare with `now()`. There is no background worker either. Instead:

- Before inserting a booking, the same transaction marks the provider's `pending` rows with `expires_at <= now` as `expired`, writing `booking.expired` for each, so the constraint no longer counts them.
- The slots query treats a booking as blocking if it is `confirmed` or `completed`, or `pending` with `expires_at` after now (`holdsSlot` in [`api/src/catalog/availability.ts`](../../api/src/catalog/availability.ts)). It therefore counts the same rows as the exclusion constraint does once an insert has swept the provider's lapsed holds. It does not write; `GET` routes do not change state ([ADR 0009](0009-accounts-and-sessions.md#decision)).
- Every read reports a `pending` row whose `expires_at` has passed as `expired`, in the booking body and in the `status` filter of `GET /v1/bookings`, whether or not a sweep has marked it yet. Transitions see the same status.

`now` is the application clock, passed to Postgres as a parameter.

**Transitions.** Each transition locks the booking row (`SELECT ... FOR UPDATE`), checks it against the status as reported above, updates `status` and `updated_at`, and writes `booking.<status>` with `{"bookingId": ...}`:

| Route | Who | From | Also |
| --- | --- | --- | --- |
| `POST /v1/bookings/:id/confirm` | Provider | `pending` | |
| `POST /v1/bookings/:id/decline` | Provider | `pending` | |
| `POST /v1/bookings/:id/cancel` | Either party | `pending`, `confirmed` | A client only before the start time |
| `POST /v1/bookings/:id/complete` | Provider | `confirmed` | Only from the start time on |

Any other transition answers `409 INVALID_TRANSITION`. The client calling a provider-only transition gets `403 FORBIDDEN`; an account that is not a party gets `404`, as it does from `GET /v1/bookings/:id`, so booking ids are not revealed.

**Booking rate limit.** `POST /v1/bookings` consumes the rule `BOOKING_CLIENT`, 20 per hour per client account, keyed `booking:account:<account id>`, with `consume` from [`api/src/rate-limit.ts`](../../api/src/rate-limit.ts). It counts every request that passes schema validation and the role check, including ones answered `422` or `409`. A rejection is the same `429` as for the auth routes ([ADR 0010](0010-rate-limiting.md#decision)), `booking.rate_limited` with `{"scope": "booking-client"}` is written once per account and window, and a limiter failure is logged and the request proceeds.

**Profiles belong to providers.** `provider_profiles` has a `role` column, always `provider` by `CHECK`, and a composite foreign key `(account_id, role)` to `accounts (id, role)`, which the migration makes unique for that purpose. A client account cannot have a profile, in the database as well as in the API, without a trigger. `accounts.role` cannot change while a profile references it, because the foreign key has no `ON UPDATE` action; the API has no route that changes a role. Services, availability rules and time off reference the profile, so a provider creates the profile first; until then those writes answer `409 PROFILE_REQUIRED`.

**WhatsApp.** A provider may store a number in E.164 form (`^\+[1-9][0-9]{7,14}$`, checked by the schema and by `provider_profiles_whatsapp_e164`). `GET /v1/providers/:id` returns `whatsappLink`, `https://wa.me/<digits>?text=<message>` with the URL-encoded message `Hola <display name>, vi su perfil en ChambaLink.`, built in [`api/src/providers/whatsapp.ts`](../../api/src/providers/whatsapp.ts), or `null` without a number. No WhatsApp API is called.

**Grants per migration.** The migration that creates a table grants `chambalink_app` exactly the privileges the API's statements need ([ADR 0013](0013-least-privilege-database-role.md)). `UPDATE` is granted per column where the API updates only some columns, so a statement that writes any other column fails with `permission denied`.

**Caching.** Routes under `/v1/providers/me` and `/v1/bookings` send `Cache-Control: no-store` on every response, like the account routes. Public routes set caching headers on `200` responses only, so errors are not kept by shared caches:

| Route | `Cache-Control` | `ETag` |
| --- | --- | --- |
| `GET /v1/services`, `GET /v1/providers/:id` | `public, max-age=30, stale-while-revalidate=60` | Strong: the base64url SHA-256 of the serialized body, in quotes |
| `GET /v1/providers/:id/slots` | `public, max-age=15` | None |

A request whose `If-None-Match` lists the current ETag, with or without a `W/` prefix, or `*`, receives `304` with an empty body and the same `ETag` and `Cache-Control`. The ETag is computed after the body is serialized, in an `onSend` hook ([`api/src/catalog/http-cache.ts`](../../api/src/catalog/http-cache.ts)), so it changes whenever the body does; the database is still queried for a `304`.

**Keyset pagination.** `GET /v1/services` and `GET /v1/bookings` order rows by `(created_at, id)` descending and page with a keyset ([`api/src/pagination.ts`](../../api/src/pagination.ts)). The cursor is the base64url JSON of the last row's `created_at` in Postgres text form, which keeps microseconds, and its `id`; the next page selects rows with `(created_at, id)` below it. A cursor this API did not produce answers `400 INVALID_CURSOR`. `limit` is 1 to 50, default 20. In the catalog, `q` matches a case-insensitive substring of the title with `ILIKE`, with `%`, `_` and `\` escaped so they match only themselves.

**Nullable fields.** Fastify's Ajv instance coerces types, and coerces `null` to `0` or `""` when it tries the first branch of `anyOf [integer, null]`. Nullable fields are therefore declared as a JSON Schema type array, `{"type": ["integer", "null"]}`, with the `Nullable` helper in `api/src/schemas.ts`.

## Alternatives

- **A timezone database (`Intl`) instead of a fixed offset.** It would follow any change to El Salvador's rules that reaches the timezone database, but every conversion would depend on the ICU data shipped in the Node image, and the product has one timezone without daylight saving time.
- **A trigger that checks `accounts.role`.** It would work, but the composite foreign key gives the same guarantee declaratively and is enforced on account changes as well.
- **A background worker that expires holds.** It would keep `status` current in the table, but it is one more process to deploy and monitor, and between its runs the constraint would still count lapsed holds; the sweep makes the insert correct at the moment it runs.
- **A time-dependent column or generated status.** A generated column must be immutable too, so it cannot depend on the time either.
- **Offset pagination.** Simpler, but inserts between requests shift pages and cause repeated or skipped rows.
- **Weak ETags or `Last-Modified`.** `services` has no update timestamp, and a hash of the body detects every change, including a changed provider name.

## Consequences

- Changing a fixed value is a code change that applies to every deployment.
- A client sees times in UTC-6 regardless of where it runs.
- A provider whose availability crosses midnight gives two rules, one ending at `24:00` and one starting at `00:00`; a service cannot span them.
- A `304` saves bandwidth but not the database query.
- A shared cache can serve a catalog page or a provider page up to 90 seconds old, and slots up to 15 seconds old; a slot shown as free can therefore already be taken.
- Deactivated services stay in the table and in the provider's own list; no route reactivates one.
- A lapsed hold stays `pending` in the table until the next booking for that provider sweeps it; until then, reads report it as `expired`, and so do transitions. Queries on the table outside the API must apply the same rule.
- The sweep writes `booking.expired` rows from a client's request, so their `ip` and `request_id` are that request's and they have no actor. A sweep in a transaction that is rolled back, for example after `409 SLOT_TAKEN` or `422 TIME_OFF`, changes nothing and leaves no rows.
- Booking references can collide; the booking id is the unique key.
