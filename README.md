# ChambaLink

[![CI](https://github.com/henriquezsergio728-tech/chamba-link/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/henriquezsergio728-tech/chamba-link/actions/workflows/ci.yml)

ChambaLink is a scheduling and marketplace platform for informal-economy service providers and their clients. This repository contains its API service, database schema, container image, CI pipeline and production deployment configuration.

## What the repo implements today

- A Fastify API on Node 24 and TypeScript that serves `GET /healthz`.
- A Postgres 16 schema, managed with Drizzle, with `accounts` and `bookings` tables.
- A database-level guarantee that a provider cannot hold two overlapping non-cancelled bookings, covered by integration tests.
- A container image for the API that also ships a programmatic migrator.
- A GitHub Actions pipeline that typechecks, migrates and tests on every pull request, builds an arm64 image, runs its migrator against a fresh Postgres, smoke-tests it, and publishes it to GitHub Container Registry from `main`.
- A production Compose overlay and an nginx config for a single VM that serves `chambalink.online` and `www.chambalink.online` behind the Cloudflare proxy, terminates TLS with a Cloudflare Origin CA certificate, and restores visitor addresses from `CF-Connecting-IP`.
- Client addresses taken from `X-Forwarded-For` when the API's peer is a loopback or private-network proxy, covered by tests.

## Repository layout

```text
.
├── api/                      @chamba/api workspace package
│   ├── src/
│   │   ├── app.ts            Fastify app factory and routes
│   │   ├── server.ts         HTTP entry point
│   │   ├── migrate.ts        Programmatic migrator
│   │   └── db/schema.ts      Drizzle schema
│   ├── drizzle/              Generated and custom SQL migrations
│   ├── test/                 Vitest tests
│   └── drizzle.config.ts     drizzle-kit configuration
├── deploy/nginx/             nginx site config and Cloudflare real-IP ranges for the production VM
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
pnpm dev
curl http://127.0.0.1:3000/healthz
```

The expected response is `{"status":"ok"}`.

### Typecheck and test

```bash
pnpm typecheck
pnpm test
```

The booking tests need the database to be running and migrated.

## Documentation

- [Architecture](docs/architecture.md): components as deployed, request path and runtime configuration
- [Data model](docs/data-model.md): tables, the no-overlap guarantee and migrations
- [Development](docs/development.md): toolchain, scripts, tests and contribution rules
- [CI/CD](docs/ci-cd.md): the GitHub Actions pipeline and image registry
- [Deployment](docs/deployment.md): production VM runbook
- [Decisions](docs/decisions/): architecture decision records
  - [0001 Fastify on TypeScript and Node 24](docs/decisions/0001-fastify-typescript-node.md)
  - [0002 Drizzle with checked-in SQL migrations](docs/decisions/0002-drizzle-sql-migrations.md)
  - [0003 Prevent double booking with an exclusion constraint](docs/decisions/0003-exclusion-constraint-double-booking.md)
  - [0004 Native arm64 image build in CI](docs/decisions/0004-native-arm64-image-build.md)
  - [0005 Compose overlay with host nginx in production](docs/decisions/0005-compose-overlay-host-nginx.md)
  - [0006 Cloudflare Origin CA certificate behind the Cloudflare proxy](docs/decisions/0006-cloudflare-origin-ca-certificate.md)

## License

MIT. See [LICENSE](LICENSE).
