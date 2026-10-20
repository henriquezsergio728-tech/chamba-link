# 0002. Drizzle with checked-in SQL migrations

## Context

The schema needs a typed definition and a reviewable, repeatable way to change the production database. The operator already knows Drizzle. Kysely was considered and not adopted.

## Decision

Use Drizzle. Generate SQL migrations with `drizzle-kit generate`, commit them under `api/drizzle/`, and apply them in production with a programmatic migrator (`api/src/migrate.ts`) that ships in the API image. Do not use `drizzle-kit push`.

## Consequences

- Every schema change is a reviewed SQL file in the repository.
- SQL that the schema cannot express, such as the exclusion constraint in [0003](0003-exclusion-constraint-double-booking.md), is added as a custom migration and is not reflected in `schema.ts` or the snapshots.
- Production does not need drizzle-kit: the image runs `node dist/migrate.js` with `drizzle-orm` only.
- The CI `test` job applies migrations with `drizzle-kit migrate`. The CI `image` job and production apply them with the programmatic migrator from the image. All read the same `api/drizzle/` folder.
- `drizzle-orm` and `drizzle-kit` are pinned to the exact version `1.0.0-rc.4`, a release candidate.
