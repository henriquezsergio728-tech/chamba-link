# CI/CD

The pipeline is defined in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) as the workflow `CI`.

## Triggers

| Event | Scope |
| --- | --- |
| `pull_request` | Any pull request |
| `push` | Branch `main` |

## Permissions

The workflow default is `contents: read`. The `image` job adds `packages: write` to push to GitHub Container Registry with `GITHUB_TOKEN`.

## Concurrency

Runs are grouped by `ci-${{ github.ref }}`. On pull requests, a new run cancels the one in progress for the same ref. On pushes to `main`, runs are not cancelled.

## Job `test`

Runs on `ubuntu-24.04` with a `postgres:16` service container:

- user, password and database `chamba`
- port `5432` mapped to the runner
- health check `pg_isready -U chamba -d chamba` every 5 s, up to 10 retries

Job environment: `DATABASE_URL=postgres://chamba:chamba@127.0.0.1:5432/chamba` and `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.

Steps:

1. `actions/checkout@v7`
2. `actions/setup-node@v7` with `node-version-file: .nvmrc`
3. `corepack enable pnpm`
4. `pnpm install --frozen-lockfile`
5. `pnpm typecheck`
6. `pnpm --filter @chamba/api exec drizzle-kit migrate`
7. `pnpm test`

Step 6 applies the committed migrations to the empty service database, so every run checks that the migrations apply from scratch before the tests run.

## Job `image`

Runs after `test` succeeds (`needs: test`), on `ubuntu-24.04-arm`, a native arm64 runner. The image name is `ghcr.io/henriquezsergio728-tech/chamba-link-api`.

| Step | Pull request | Push to `main` |
| --- | --- | --- |
| Build: `docker build` tagged `$GITHUB_SHA`, labelled `org.opencontainers.image.revision=$GITHUB_SHA` | Yes | Yes |
| Migrate: shipped migrator against a fresh Postgres, run twice | Yes | Yes |
| Smoke test | Yes | Yes |
| Log in to `ghcr.io` with `GITHUB_TOKEN` | No | Yes |
| Push `:<sha>` and `:latest` | No | Yes |

The migrate step tests the migrator inside the built image:

1. Creates a Docker network `ci` and starts a `postgres:16` container `pg` on it, with user, password and database `chamba`.
2. Polls `pg_isready` once per second, up to 60 times, then runs `pg_isready` once more so the step fails if Postgres is not ready.
3. Runs `node dist/migrate.js` from the built image twice, with `DATABASE_URL=postgres://chamba:chamba@pg:5432/chamba`. The second run checks that applying migrations to an already migrated database succeeds.
4. Queries `pg_constraint` and fails unless both `bookings_no_provider_overlap` and `bookings_during_bounded` exist.
5. Removes the `pg` container.

The smoke test runs the image with port `127.0.0.1:3000:3000` and polls `GET /healthz` with `curl -fsS`, retrying up to 20 times at 1 s intervals on any error, including connection refused and connection reset. On failure it prints `docker ps -a` and the container logs, then fails the job. The container runs without `DATABASE_URL`, which works because the API does not connect to the database.

## Image

The [`Dockerfile`](../Dockerfile) has two stages, both `node:24-slim`:

1. `build`: enables pnpm through Corepack, runs `pnpm install --frozen-lockfile`, compiles with `pnpm --filter @chamba/api build`, and assembles production dependencies with `pnpm --filter @chamba/api --prod deploy /prod/api`.
2. Runtime: copies `/prod/api` to `/app` owned by `node`, runs as user `node`, sets `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, exposes 3000, defines a `/healthz` health check, and starts `node dist/server.js`.

The image contains `dist/` and `drizzle/`, so it can run the migrator with `node dist/migrate.js`. `.dockerignore` excludes `node_modules`, `dist`, `.git`, `.github` and `.env` files from the build context.

## Registry

- Image: `ghcr.io/henriquezsergio728-tech/chamba-link-api`
- Visibility: public; anonymous pulls work.
- Tags: the full 40-character commit SHA of each push to `main`, and `latest`.
- Platform: `linux/arm64` only.

The SHA tag identifies one build. `latest` moves on every push to `main`. Production selects an image by SHA through `API_TAG`.

Publishing an image does not deploy it. Deployment is manual; see [Deployment](deployment.md).

## Dependabot

[`.github/dependabot.yml`](../.github/dependabot.yml) checks the `github-actions` ecosystem in `/` weekly and opens pull requests with the commit-message prefix `ci`. It does not cover npm dependencies or Docker base images.

## Branch protection

`main` is protected by a repository ruleset that requires a pull request and the passing status checks `test` and `image`.
