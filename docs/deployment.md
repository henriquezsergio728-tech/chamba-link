# Deployment

Runbook for the production VM. All commands run on the VM as the `ubuntu` user unless they use `sudo`.

Production is a single host. The repository defines no backup for the `pgdata` volume. Production serves plain HTTP only.

## Host

| Item | Value |
| --- | --- |
| Platform | Oracle Cloud Infrastructure Always Free VM, Ampere A1 (arm64), 1 OCPU, 6 GB RAM |
| OS | Ubuntu 24.04 LTS |
| Hostname | `chambalink`, kept across reboots by `preserve_hostname: true` in `/etc/cloud/cloud.cfg.d/99-hostname.cfg` |
| Container runtime | Docker Engine with the Compose plugin v5.6.0 |
| Reverse proxy | nginx 1.24 from the Ubuntu package |

## Layout

| Path | Owner and mode | Contents |
| --- | --- | --- |
| `/opt/chambalink` | `ubuntu` | Clone of this repository |
| `/opt/chambalink/.env` | mode `600`, not in git | Production environment |
| `/etc/nginx/sites-enabled/` | root | Symlink to `/opt/chambalink/deploy/nginx/chambalink.conf`; the stock `default` site is removed |
| `/etc/docker/daemon.json` | root | Docker log rotation |
| `/etc/cloud/cloud.cfg.d/99-hostname.cfg` | root | `preserve_hostname: true` |

The clone uses a read-only GitHub deploy key scoped to this repository. The key exists only on the VM.

## Production environment

`/opt/chambalink/.env` defines:

| Variable | Purpose |
| --- | --- |
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password, generated with `openssl rand -hex 24` |
| `POSTGRES_DB` | Database name |
| `COMPOSE_FILE` | `compose.yaml:compose.prod.yaml`, so every `docker compose` command in `/opt/chambalink` uses both files |
| `API_TAG` | Full commit SHA of a published image |

`compose.prod.yaml` builds `DATABASE_URL` for the `api` service from the `POSTGRES_*` variables and fails if `API_TAG` is unset.

Check the file mode:

```bash
stat -c '%a %U' /opt/chambalink/.env
```

Expected output: `600 ubuntu`.

## Release

This is the sequence used for the initial deployment. Set `RELEASE_SHA` to the full commit SHA of a commit on `main` whose `image` job pushed an image.

```bash
RELEASE_SHA=<full 40-character commit SHA>
cd /opt/chambalink
```

Confirm the image exists in the registry:

```bash
docker manifest inspect "ghcr.io/henriquezsergio728-tech/chamba-link-api:${RELEASE_SHA}" > /dev/null && echo found
```

Set `API_TAG` in `.env`:

```bash
sed -i "s/^API_TAG=.*/API_TAG=${RELEASE_SHA}/" .env
grep '^API_TAG=' .env
```

Pull images, start the database, apply migrations, then start everything:

```bash
docker compose pull
docker compose up -d --wait db
docker compose run --rm --no-deps api node dist/migrate.js
docker compose up -d --wait
```

- `--wait` blocks until the started services report healthy.
- `run --no-deps` skips `depends_on`, because `db` is already running.
- `run` does not publish the service's ports, so the one-off migrator container does not conflict with the `api` port.
- The migrator prints `migrations applied` on success.

The Compose files and nginx config come from the working copy in `/opt/chambalink`. Changing `API_TAG` changes only the API image.

`API_TAG` pins the API image to one commit SHA. No rollback has been exercised.

## Verification

Image architecture:

```bash
docker image inspect --format '{{.Architecture}}' "ghcr.io/henriquezsergio728-tech/chamba-link-api:${RELEASE_SHA}"
```

Expected output: `arm64`.

Container health:

```bash
docker compose ps
```

Expected: services `api` and `db` both show `(healthy)` in `STATUS`.

Listening ports:

```bash
sudo ss -ltn '( sport = :3000 or sport = :5432 )'
```

Expected: `127.0.0.1:3000` and `127.0.0.1:5432` only, with no `0.0.0.0` or `[::]` entries.

Database constraints and extension:

```bash
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d bookings" -c "\dx btree_gist"'
```

Expected: `bookings_no_provider_overlap` under `Indexes`, `bookings_during_bounded` under `Check constraints`, and `btree_gist` version `1.7`.

Health endpoint through nginx:

```bash
curl -i http://127.0.0.1/healthz
```

Expected: `HTTP/1.1 200 OK` and the body `{"status":"ok"}`. From outside the VM, the same request to the VM's public address returns the same response.

## nginx

The site config is versioned at [`deploy/nginx/chambalink.conf`](../deploy/nginx/chambalink.conf). It listens on port 80 for IPv4 and IPv6 as `default_server` with `server_name _`, and proxies every path to `http://127.0.0.1:3000` with forwarding headers.

The site is enabled by a symlink from `/etc/nginx/sites-enabled/` to the file in the clone. After any change to the config:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Check the enabled sites:

```bash
ls -l /etc/nginx/sites-enabled/
```

Expected: one symlink pointing to `/opt/chambalink/deploy/nginx/chambalink.conf` and no `default` entry.

## Firewall

The stock OCI Ubuntu image has an iptables `INPUT` chain that ends in a `REJECT` rule. Ports 80 and 443 stay blocked by it even when the VCN security list allows them. On the production VM, `ACCEPT` rules for TCP 80 and 443 are inserted above the `REJECT` rule and persisted with `netfilter-persistent save`. They were saved before Docker was installed, so Docker's chains are not part of the persisted rules.

Check the rule order:

```bash
sudo iptables -L INPUT -n --line-numbers
```

Expected: `ACCEPT` rules for `tcp dpt:80` and `tcp dpt:443` with lower line numbers than the `REJECT` rule.

Running `sudo netfilter-persistent save` now that Docker is installed would also persist Docker's chains.

Docker-published ports bypass `INPUT` rules. For this reason both containers publish on `127.0.0.1` only, and only nginx is reachable from outside.

## Logs

| Source | Command |
| --- | --- |
| API | `docker compose logs --tail 200 api` |
| Database | `docker compose logs --tail 200 db` |
| nginx access and errors | `sudo tail -n 200 /var/log/nginx/access.log /var/log/nginx/error.log` |
| nginx service | `sudo journalctl -u nginx --since today` |

Run the `docker compose` commands from `/opt/chambalink`. Add `-f` to follow.

`/etc/docker/daemon.json` sets the `json-file` log driver with `max-size` `10m` and `max-file` `3`, so each container keeps at most three 10 MB log files.

The API logs the client address as seen by Fastify. Fastify trusts `X-Forwarded-For` from loopback and private-network peers (`trustProxy: "loopback,uniquelocal"`), so `request.ip` comes from the header nginx sets when the peer is in those ranges.
