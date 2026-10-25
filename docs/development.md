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
| `errors.test.ts` | No. Checks problem+json responses for `AppError`, unknown errors, validation errors, malformed JSON and unknown routes. |
| `request-id.test.ts` | No. Checks which incoming `x-request-id` values are kept or replaced, and the header on error responses. |
| `helmet.test.ts` | No. Checks `x-content-type-options` is set and HSTS and CSP are absent. |
| `openapi.test.ts` | No. Checks `GET /v1/openapi.json` returns a document listing `/healthz`. |
| `db.test.ts` | Yes for two tests: one runs `SELECT 1` through `app.db` with `DATABASE_URL` and checks the pool is ended after `app.close()`; the other registers a route before the database plugin, as `server.ts` does, and queries through it. The other two use an unreachable URL: they check that an `error` event on the pool is handled and that the plugin does not connect at registration. |
| `booking-overlap.test.ts` | Yes. Needs a migrated database and `DATABASE_URL`, loaded from the environment or from `.env` at the repo root. |
| `booking-concurrency.test.ts` | Yes. Same requirements as `booking-overlap.test.ts`. Commits on separate pooled connections and deletes every row it creates in `afterAll`. |

```bash
pnpm test
```

See [Data model](data-model.md#tests) for what the booking tests cover.

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
