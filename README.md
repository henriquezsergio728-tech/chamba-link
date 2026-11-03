# ChambaLink

[![CI](https://github.com/henriquezsergio728-tech/chamba-link/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/henriquezsergio728-tech/chamba-link/actions/workflows/ci.yml)

ChambaLink is a scheduling and marketplace platform for informal-economy service providers and their clients. This repository contains its API service, database schema, container image, CI pipeline and production deployment configuration.

## What the repo implements today

- A Fastify API on Node 24 and TypeScript that serves `GET /healthz` and its generated OpenAPI document at `GET /v1/openapi.json`, returns errors as RFC 9457 problem details, tags every response with `x-request-id`, validates its environment at startup and shuts down cleanly on `SIGTERM`.
- Email and password accounts with argon2id password hashes, 30-day cookie sessions stored as token hashes, an append-only audit log of registrations, logins and logouts, and Postgres-backed rate limits on registration and login, served at `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/logout` and `GET /v1/me`.
- Provider profiles, service catalogs, weekly availability and time off, managed by provider accounts under `/v1/providers/me`, with a WhatsApp `wa.me` link built from the provider's number.
- A public catalog at `GET /v1/services` with category, department and title filters, keyset pagination and `ETag` caching, public provider pages at `GET /v1/providers/:id`, and free slots computed from availability, time off and bookings at `GET /v1/providers/:id/slots`, in the fixed timezone `America/El_Salvador`.
- A Postgres 16 schema, managed with Drizzle, with `accounts`, `account_credentials`, `sessions`, `audit_log`, `rate_limits`, `provider_profiles`, `services`, `availability_rules`, `time_off` and `bookings` tables.
- Bookings by client accounts at `POST /v1/bookings`, held for the provider to confirm for up to 24 hours, with confirm, decline, cancel and complete transitions, a per-client rate limit, and a WhatsApp `wa.me` link to the provider with the booking's reference.
- A database-level guarantee that a provider cannot hold two overlapping pending, confirmed or completed bookings, covered by integration tests, with lapsed holds expired in the transaction that inserts the next booking.
- A container image for the API that also ships a programmatic migrator.
- A GitHub Actions pipeline that typechecks, migrates and tests on every pull request, builds an arm64 image, runs its migrator against a fresh Postgres, smoke-tests it, and publishes it to GitHub Container Registry from `main`.
- Compose files for a two-host production setup, an application host that runs the API and a database host that runs Postgres on its private address, and an nginx config on the application host that serves `chambalink.online` and `www.chambalink.online` behind the Cloudflare proxy, terminates TLS with a Cloudflare Origin CA certificate, and restores visitor addresses from `CF-Connecting-IP`.
- Client addresses taken from `X-Forwarded-For` when the API's peer is a loopback or private-network proxy, covered by tests.

## Repository layout

```text
.
├── api/                      @chamba/api workspace package
│   ├── src/
│   │   ├── app.ts            Fastify app factory and routes
│   │   ├── server.ts         HTTP entry point and graceful shutdown
│   │   ├── config.ts         Environment validation for the entry points
│   │   ├── db.ts             Postgres pool and Drizzle Fastify plugin
│   │   ├── errors.ts         AppError and problem+json error handlers
│   │   ├── audit.ts          Audit log writer
│   │   ├── rate-limit.ts     Fixed-window rate limits stored in Postgres
│   │   ├── auth/             Password hashing, sessions and account routes
│   │   ├── providers/        Provider profile, services, availability and time-off routes
│   │   ├── catalog/          Public catalog, provider page and slot routes, slot algorithm, cache headers
│   │   ├── bookings/         Booking routes, transitions and the expiry of lapsed holds
│   │   ├── domain.ts         Fixed values: timezone, currency, categories, departments, slot rules
│   │   ├── time.ts           Local time conversion at the fixed UTC-6 offset
│   │   ├── pagination.ts     Keyset cursors
│   │   ├── schemas.ts        Shared TypeBox schemas
│   │   ├── migrate.ts        Programmatic migrator
│   │   └── db/schema.ts      Drizzle schema
│   ├── drizzle/              Generated and custom SQL migrations
│   ├── test/                 Vitest tests
│   └── drizzle.config.ts     drizzle-kit configuration
├── deploy/
│   ├── nginx/                nginx site config and Cloudflare real-IP ranges for the application host
│   ├── db/compose.yaml       Postgres-only Compose project for a database host
│   ├── app/compose.yaml      Overlay that runs the API without a local database
│   └── app/migrate.yaml      Overlay that adds the migrator service
├── load/                     k6 load scripts and their README
├── ops/                      Database backup script and its systemd units
├── docs/                     Project documentation and ADRs
├── .github/
│   ├── workflows/ci.yml      CI pipeline
│   └── dependabot.yml        Weekly GitHub Actions updates
├── compose.yaml              Postgres for development and production
├── compose.prod.yaml         Production overlay that adds the API container
├── Dockerfile                API image
├── .env.example              Environment variable template
├── .gitattributes            LF line endings for text files
├── .nvmrc                    Node major version
├── CLAUDE.md                 Working agreements for Claude Code
├── LICENSE                   MIT license
├── package.json              Workspace root scripts and pnpm pin
└── pnpm-workspace.yaml       Workspace packages and build-script approvals
```

## Quick start

### Prerequisites

- Node 24 (see `.nvmrc`)
- Corepack, to provide the pnpm version pinned in `package.json`
- Docker with the Compose plugin

### Install

```bash
corepack enable pnpm
pnpm install
```

### Start the local database

```bash
cp .env.example .env
docker compose up -d --wait db
```

Postgres listens on `127.0.0.1:5432` only.

### Apply migrations

```bash
pnpm --filter @chamba/api exec drizzle-kit migrate
```

### Run the API

```bash
set -a; . ./.env; set +a
pnpm dev
curl http://127.0.0.1:3000/healthz
```

The server reads `DATABASE_URL` from the environment and exits if it is missing or invalid. The expected response is `{"status":"ok"}`. See [Development](docs/development.md#running-the-api) for the other variables.

### Typecheck and test

```bash
pnpm typecheck
pnpm test
```

The booking, database plugin, auth, rate-limit, provider, catalog and bookings route tests need the database to be running and migrated.

## Documentation

- [Architecture](docs/architecture.md): components as deployed, request path and runtime configuration
- [Data model](docs/data-model.md): tables, the no-overlap guarantee, the append-only audit log, rate-limit counters and migrations
- [Development](docs/development.md): toolchain, scripts, tests and contribution rules
- [CI/CD](docs/ci-cd.md): the GitHub Actions pipeline and image registry
- [Deployment](docs/deployment.md): production runbook for the application and database hosts
- [Performance](docs/performance.md): load-test method and measured results
- [Decisions](docs/decisions/): architecture decision records
  - [0001 Fastify on TypeScript and Node 24](docs/decisions/0001-fastify-typescript-node.md)
  - [0002 Drizzle with checked-in SQL migrations](docs/decisions/0002-drizzle-sql-migrations.md)
  - [0003 Prevent double booking with an exclusion constraint](docs/decisions/0003-exclusion-constraint-double-booking.md)
  - [0004 Native arm64 image build in CI](docs/decisions/0004-native-arm64-image-build.md)
  - [0005 Compose overlay with host nginx in production](docs/decisions/0005-compose-overlay-host-nginx.md)
  - [0006 Cloudflare Origin CA certificate behind the Cloudflare proxy](docs/decisions/0006-cloudflare-origin-ca-certificate.md)
  - [0007 Host firewall restricted to Cloudflare's IPv4 ranges](docs/decisions/0007-host-firewall-cloudflare-ranges.md)
  - [0008 API conventions](docs/decisions/0008-api-conventions.md)
  - [0009 Accounts, password hashing, cookie sessions and audit log](docs/decisions/0009-accounts-and-sessions.md)
  - [0010 Rate limiting in Postgres](docs/decisions/0010-rate-limiting.md)
  - [0011 Logical database backups to Object Storage](docs/decisions/0011-database-backups.md)
  - [0012 Dedicated database host](docs/decisions/0012-dedicated-database-host.md)
  - [0013 Least-privilege database role](docs/decisions/0013-least-privilege-database-role.md)
  - [0014 Scheduling model](docs/decisions/0014-scheduling-model.md)
  - [0015 nginx connection reuse and connection limits](docs/decisions/0015-nginx-connection-reuse-and-limits.md)

## License

MIT. See [LICENSE](LICENSE).
