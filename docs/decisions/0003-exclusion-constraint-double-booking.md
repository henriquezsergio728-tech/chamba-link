# 0003. Prevent double booking with an exclusion constraint

## Context

A provider must not have two active bookings whose times overlap. An application-level check only protects writes that go through that code path.

## Decision

Store each booking's time as a `tstzrange` column, `during`, and enforce non-overlap in Postgres with an exclusion constraint:

```sql
EXCLUDE USING gist ("provider_id" WITH =, "during" WITH &&) WHERE ("status" <> 'cancelled')
```

A `CHECK` constraint rejects empty and unbounded ranges. See [Data model](../data-model.md#no-overlap-guarantee).

## Consequences

- The database enforces the rule for every writer.
- Overlapping inserts fail with SQLSTATE `23P01`; empty or unbounded ranges fail with `23514`.
- Half-open ranges (`[start,end)`) allow back-to-back bookings.
- Cancelled bookings do not block their slot.
- The migration requires the `btree_gist` extension.
- The constraint is covered by `api/test/booking-overlap.test.ts`, which runs against a real Postgres.
