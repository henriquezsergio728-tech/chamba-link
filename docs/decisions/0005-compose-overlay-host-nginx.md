# 0005. Compose overlay with host nginx in production

## Context

Production runs on a single VM. Development already uses `compose.yaml` for Postgres.

## Decision

Run production as a Compose overlay: `compose.prod.yaml` adds the `api` service on top of `compose.yaml`, selected with `COMPOSE_FILE=compose.yaml:compose.prod.yaml` in the production `.env`. Run nginx on the host from the Ubuntu package, with its site config versioned at `deploy/nginx/chambalink.conf` and symlinked into `/etc/nginx/sites-enabled/`.

## Consequences

- Development and production use the same `db` service definition.
- The `db` service publishes `127.0.0.1:5432` in production as well as in development.
- Containers publish on `127.0.0.1` only. nginx is the only component listening on a public interface.
- Changes to the nginx config go through pull requests like any other file.
- nginx is managed with `systemctl`, outside Compose.
