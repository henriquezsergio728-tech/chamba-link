# Development

## Toolchain

| Tool | Pin | Where |
| --- | --- | --- |
| Node | `24` | `.nvmrc`; `engines.node` is `>=24 <25` in `package.json` |
| pnpm | `12.14.0` | `packageManager` in `package.json`, provided by Corepack |
| TypeScript | `^7.0.2` | `api/package.json` |
| Postgres | `16` | `compose.yaml` |

Enable the pinned pnpm with:

```bash
corepack enable pnpm
```

`pnpm-workspace.yaml` approves the build script of `esbuild` (`allowBuilds: esbuild: true`). esbuild is a transitive dependency of `drizzle-kit`, `tsx` and `vitest`. pnpm skips dependency build scripts that are not approved.

The workspace has one package, `api` (`@chamba/api`). It is an ES module package (`"type": "module"`) compiled with `module` and `moduleResolution` set to `NodeNext`, so relative imports in `src/` use the `.js` extension.

## Scripts

Root `package.json`:

| Script | Runs |
| --- | --- |
| `pnpm dev` | `pnpm --filter @chamba/api dev` |
| `pnpm typecheck` | `typecheck` in every workspace package |
| `pnpm test` | `test` in every workspace package |

`api/package.json`:

| Script | Runs |
| --- | --- |
| `dev` | `tsx watch src/server.ts` |
| `build` | `tsc -p tsconfig.build.json`, output to `api/dist/` |
| `start` | `node dist/server.js` |
| `test` | `vitest run` |
| `typecheck` | `tsc --noEmit` |

Run a package script from the root with `pnpm --filter @chamba/api <script>`.

`pnpm typecheck` runs `tsc --noEmit` in `api/` with `api/tsconfig.json`, which includes `src`, `test` and `drizzle.config.ts`. The `build` script compiles with `api/tsconfig.build.json`, which extends it and compiles `src` only into `dist/`. Vitest transpiles test files without typechecking them, so type errors in `api/test/` surface only through `pnpm typecheck`.

## Local database

`compose.yaml` defines one service, `db`, from `postgres:16` pinned to a digest (see `compose.yaml` for the reference). It reads `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` from `.env`, publishes `127.0.0.1:5432`, and stores data in the named volume `pgdata`.

```bash
cp .env.example .env
docker compose up -d --wait db
pnpm --filter @chamba/api exec drizzle-kit migrate
```

`.env.example` also defines `DATABASE_URL`, which drizzle-kit and the tests use. `.env` and `.env.*` are ignored by git, except `.env.example`.

Locally, Compose uses `compose.yaml` only, so the API runs on the host with `pnpm dev`.

## Running the API

The server reads its configuration from the process environment and does not load `.env`. It exits with code 1, naming the variable, if `DATABASE_URL` is unset or invalid.

| Variable | Required | Default |
| --- | --- | --- |
| `DATABASE_URL` | Yes; must start with `postgres://` or `postgresql://` | none |
| `PORT` | No; integer from 1 to 65535 | `3000` |
| `HOST` | No | `127.0.0.1` |
| `LOG_LEVEL` | No; `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` | `info` |
| `DB_POOL_MAX` | No; integer from 1 to 20, the maximum number of Postgres connections in the API's pool | `5` |

To run it with the values from `.env`:

```bash
set -a; . ./.env; set +a
pnpm dev
```

Check it with:

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/v1/openapi.json
```

`Ctrl+C` sends `SIGINT`, which closes the app and the Postgres pool before the process exits. See [ADR 0008](decisions/0008-api-conventions.md) for the error format, request ids and the other API conventions.

## Tests

Tests use Vitest and live in `api/test/`.

| File | Needs Postgres |
| --- | --- |
| `health.test.ts` | No. Uses Fastify `inject`. |
| `client-ip.test.ts` | No. Uses Fastify `inject` with `remoteAddress` `127.0.0.1` to check `request.ip` for a given `X-Forwarded-For`. |
| `config.test.ts` | No. Checks environment validation, defaults, and that error output names variables without their values. |
| `errors.test.ts` | No. Checks problem+json responses for `AppError`, unknown errors, validation errors, malformed JSON and unknown routes, and that `describeError` logs a database error without its query parameters or pg `detail` while leaving other errors unchanged. |
| `request-id.test.ts` | No. Checks which incoming `x-request-id` values are kept or replaced, and the header on error responses. |
| `helmet.test.ts` | No. Checks `x-content-type-options` is set and HSTS and CSP are absent. |
| `openapi.test.ts` | No. Checks `GET /v1/openapi.json` returns a document listing `/healthz`, the four account and session routes, and the `cookieAuth` security scheme on `/v1/me`; that the `/v1/providers/me` routes require `cookieAuth` and the catalog routes do not; that nullable fields are type arrays; and that the `/v1/bookings` routes require `cookieAuth` and `POST /v1/bookings` documents its `429`. |
| `slots.test.ts` | No. Checks the fixed UTC-6 conversion and `computeSlots`: half-hour starts where the whole service fits, merged touching rules, rules ending at `24:00`, half-open blocked intervals, `[from, to)`, the one-hour lead, the 60-day horizon and grid alignment. |
| `password.test.ts` | No. Checks the argon2id PHC format, that verification accepts only the right password, reads its parameters from the stored string and returns `false` for malformed hashes, and that two hashes of one password differ. |
| `db.test.ts` | Yes for two tests: one runs `SELECT 1` through `app.db` with `DATABASE_URL` and checks the pool is ended after `app.close()`; the other registers a route before the database plugin, as `server.ts` does, and queries through it. The other two use an unreachable URL: they check that an `error` event on the pool is handled and that the plugin does not connect at registration. |
| `booking-overlap.test.ts` | Yes. Needs a migrated database and `DATABASE_URL`, loaded from the environment or from `.env` at the repo root. Inserts bookings directly, with a provider profile and service for each provider. |
| `booking-concurrency.test.ts` | Yes. Same requirements as `booking-overlap.test.ts`. Commits on separate pooled connections and deletes every row it creates in `afterAll`. |
| `rate-limit.test.ts` | Yes. Same requirements as `booking-overlap.test.ts`. Checks `consume` counts, limits, `retryAfterSeconds` and window rollover with an injected `now`, 20 concurrent consumes with exactly 5 allowed, `peek`, `reset`, `prune`, and `clientKey` for IPv4, IPv4-mapped, IPv6 /64 and unparsable values. Deletes the rows it creates in `afterAll`. |
| `app-role.test.ts` | Yes. Same requirements as `booking-overlap.test.ts`, and the `DATABASE_URL` user must be a superuser or a member of `chambalink_app`. Inside rolled-back transactions with `SET LOCAL ROLE chambalink_app`, checks that the role can insert and read `accounts` and append to `audit_log`, and cannot update or delete audit rows, disable the audit trigger, drop tables, create tables, `TRUNCATE`, read `drizzle.__drizzle_migrations` or create extensions. For `provider_profiles` and `services` it checks that the role can insert and update the columns the API writes and no others, and cannot delete; for `availability_rules` and `time_off`, that it can insert, read and delete but not update; and that it cannot truncate or drop any of the four. For `bookings` it checks that the role can insert, read, lock and update `status` and `updated_at`, and cannot update any other column, delete or truncate. Also creates a table as the connecting user, switches to the role, and checks that the role cannot read it. |
| `auth.test.ts` | Yes. Same requirements as `app-role.test.ts`: the API's pool connects with the startup option `-c role=chambalink_app`, and a second pool with the plain `DATABASE_URL` deletes accounts, expires sessions and reads and tests `audit_log`. Drives register, login, logout and `/v1/me` through `inject` with a random email and client address per test, and checks cookie attributes, stored hashes, identical login failures, `EMAIL_TAKEN`, expired and logged-out sessions, validation errors including the ASCII-only email pattern, `Cache-Control`, audit rows and the append-only trigger. It also checks the rate limits on register and login: `429` with `Retry-After`, the per-email lock without password work, the reset after a successful login, IPv6 /64 keys, one `auth.rate_limited` row per key and window, and that a failing limiter store leaves responses unchanged. It replaces `src/rate-limit.js` and `src/auth/password.js` with pass-through `vi.mock` wrappers, which a flag switches to failing limiter calls and which count password verifications. Deletes the accounts and rate-limit rows it creates in `afterAll`, which cascades to credentials and sessions; its audit rows remain. |
| `providers.test.ts` | Yes. Same requirements as `auth.test.ts`, through the shared helper `test/harness.ts`: the API runs as `chambalink_app` and an owner pool creates accounts with a session row, checks the database and deletes what the tests create. Checks every `/v1/providers/me` route for `401` anonymous, `403` for a client and `Cache-Control: no-store`, `404` for another provider's service or time off, the profile, service, availability and time-off flows and their validation errors, `409 PROFILE_REQUIRED`, the database guarantee that only provider accounts have a profile, the rule exclusion constraint, and one audit event per change with ids only. |
| `catalog.test.ts` | Yes. Same requirements and helper as `providers.test.ts`. Checks the catalog's filters, `q` escaping, keyset pagination over rows with equal `created_at`, invalid cursors and limits, `Cache-Control`, `ETag` and `304`, the public provider page and its `wa.me` link, and the slots route: availability minus time off minus blocking bookings, the one-hour lead and 60-day horizon, range limits and `404`s. |
| `bookings.test.ts` | Yes. Same requirements and helper as `providers.test.ts`. Checks `401`, `403` and `404` for every booking route, creation with its hold and `wa.me` link, `422` for misaligned starts, the horizon, availability and time off, `409 SLOT_TAKEN` and slots freed by declining or cancelling, 20 concurrent bookings of one slot with exactly one `201`, a lapsed hold that frees its slot and is marked `expired` by the next booking, every valid and invalid transition, `booking.*` audit rows with ids only, keyset pages and the `status` filter, and the 20-per-hour rate limit with one `booking.rate_limited` row. It replaces `src/rate-limit.js` with a pass-through `vi.mock` wrapper that a flag switches to failing calls, to check that bookings proceed when the limiter fails. |

```bash
pnpm test
```

See [Data model](data-model.md#tests) for what the booking tests cover, and [Data model](data-model.md#append-only-audit-log) for why audit rows remain after the tests.

## Branches and pull requests

`main` is protected by a ruleset that requires a pull request and the status checks `test` and `image`. See [CI/CD](ci-cd.md#branch-protection).

Branch names in the history follow `<type>/<topic>`, for example `feat/api-image` and `ci/add-workflow`. Pull requests are merged with merge commits.

## Commit style

Commits follow the Conventional Commits format, `<type>(<scope>): <summary>`, with a lowercase imperative summary. Types and scopes observed in `git log`:

| Type | Scopes |
| --- | --- |
| `feat` | `api`, `db`, `deploy` |
| `test` | `db` |
| `ci` | none |
| `chore` | none |
| `docs` | none |

Dependabot commits use the `ci` prefix (`.github/dependabot.yml`).

## Repository conventions

- `.gitattributes` sets `* text=auto eol=lf`, so text files are stored and checked out with LF line endings.
- `CLAUDE.md` holds the working agreements for Claude Code sessions in this repository.
- The repository is licensed under MIT; see [`LICENSE`](../LICENSE).
