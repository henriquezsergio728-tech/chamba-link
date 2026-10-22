# Deployment

Runbook for the production VM. Commands that start with `cd /opt/chambalink` or use `docker compose` run on the VM as the `ubuntu` user unless they use `sudo`. Commands marked as run from outside the VM run on any other machine.

Production is a single host. The repository defines no backup for the `pgdata` volume. The origin accepts direct connections on ports 80 and 443 from any address; they are not restricted to Cloudflare's ranges.

## Host

| Item | Value |
| --- | --- |
| Platform | Oracle Cloud Infrastructure Always Free VM, Ampere A1 (arm64), 1 OCPU, 6 GB RAM |
| OS | Ubuntu 24.04 LTS |
| Hostname | `chambalink`, kept across reboots by `preserve_hostname: true` in `/etc/cloud/cloud.cfg.d/99-hostname.cfg` |
| Network | IPv4 only; the VM has no IPv6 address |
| Container runtime | Docker Engine with the Compose plugin v5.6.0 |
| Reverse proxy | nginx 1.24 from the Ubuntu package |

## Layout

| Path | Owner and mode | Contents |
| --- | --- | --- |
| `/opt/chambalink` | `ubuntu` | Clone of this repository |
| `/opt/chambalink/.env` | mode `600`, not in git | Production environment |
| `/etc/nginx/sites-enabled/` | root | Symlink to `/opt/chambalink/deploy/nginx/chambalink.conf`; the stock `default` site is removed |
| `/etc/ssl/chambalink/origin.key` | `root`, mode `600` | TLS private key |
| `/etc/ssl/chambalink/origin.pem` | `root` | Cloudflare Origin CA certificate |
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

## DNS

| Item | Value |
| --- | --- |
| Domain | `chambalink.online`, registered at GoDaddy |
| DNS | Cloudflare, Free plan |
| Apex | `A` record to the production VM, proxied |
| `www` | `CNAME` to the apex, proxied |

Because both records are proxied, public DNS returns Cloudflare addresses, not the VM's address.

Check from outside the VM:

```bash
dig +short NS chambalink.online
dig +short chambalink.online A
dig +short www.chambalink.online
```

Expected: two `*.ns.cloudflare.com` name servers, and Cloudflare addresses for the apex and `www`.

## TLS

| Hop | Certificate | Setting |
| --- | --- | --- |
| Client to Cloudflare | Cloudflare edge certificate | Always Use HTTPS on: plain HTTP requests get a `301` to HTTPS |
| Cloudflare to nginx | Cloudflare Origin CA certificate on the VM | SSL/TLS mode Full (strict) |

The origin certificate:

- covers `chambalink.online` and a wildcard, and expires on Oct 18 2041;
- uses an RSA 2048 key generated on the VM with `openssl`; only the CSR was submitted to Cloudflare, so the private key has not left the VM;
- is trusted only by Cloudflare, so a client connecting to the origin directly gets an untrusted-certificate error.

Cloudflare sends no expiry notifications for Origin CA certificates. No renewal is configured on the VM. See [ADR 0006](decisions/0006-cloudflare-origin-ca-certificate.md).

Check the certificate and key on the VM:

```bash
sudo openssl x509 -in /etc/ssl/chambalink/origin.pem -noout -subject -enddate -ext subjectAltName
sudo stat -c '%a %U' /etc/ssl/chambalink/origin.key
diff <(sudo openssl x509 -in /etc/ssl/chambalink/origin.pem -noout -pubkey) <(sudo openssl pkey -in /etc/ssl/chambalink/origin.key -pubout) && echo match
```

Expected: `notAfter=Oct 18 ... 2041 GMT`, a `subjectAltName` with the apex and the wildcard, `600 root`, and `match`.

Check that the origin certificate validates against Cloudflare's Origin CA RSA root, on the VM:

```bash
curl -fsS -o /tmp/origin_ca_rsa_root.pem https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem
curl -sS --cacert /tmp/origin_ca_rsa_root.pem --resolve chambalink.online:443:127.0.0.1 https://chambalink.online/healthz
```

Expected: `{"status":"ok"}`.

## Initial deployment

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

## Updating the running version

This sequence has been executed once on the production VM. Set `RELEASE_SHA` as above.

```bash
RELEASE_SHA=<full 40-character commit SHA>
cd /opt/chambalink
git pull --ff-only
sed -i "s/^API_TAG=.*/API_TAG=${RELEASE_SHA}/" .env
grep '^API_TAG=' .env
docker compose pull
docker compose run --rm --no-deps api node dist/migrate.js
docker compose up -d --wait
```

When it was executed, `docker compose pull` also fetched a newer `postgres:16` image, because `compose.yaml` references the tag `postgres:16` rather than a digest. `docker compose up -d` then recreated the `db` container. The `pgdata` volume was kept.

`git pull --ff-only` updates the Compose files and the nginx config in the working copy. nginx reads a changed config only after a reload; see [nginx](#nginx).

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

Health endpoint through nginx, on the VM:

```bash
curl -i http://127.0.0.1/healthz
```

Expected: `HTTP/1.1 200 OK` and the body `{"status":"ok"}`.

Health endpoint through Cloudflare, from outside the VM:

```bash
curl -sI http://chambalink.online/healthz
curl -si https://chambalink.online/healthz
```

Expected: the first returns `301` with `Location: https://chambalink.online/healthz`. The second returns `HTTP/2 200`, `server: cloudflare`, a `cf-ray` header, and the body `{"status":"ok"}`.

Visitor address: after the request above, on the VM:

```bash
docker compose logs --since 1m api | grep remoteAddress | grep -v '"remoteAddress":"127.0.0.1"'
```

Expected: `remoteAddress` is the public address of the machine that sent the request, not a Cloudflare or Docker address. Entries with `remoteAddress` `127.0.0.1` come from the container healthcheck and are filtered out.

## nginx

The site config is versioned at [`deploy/nginx/chambalink.conf`](../deploy/nginx/chambalink.conf) and described in [Architecture](architecture.md#nginx). It includes [`deploy/nginx/cloudflare-real-ip.conf`](../deploy/nginx/cloudflare-real-ip.conf) by its absolute path in the clone.

The site is enabled by a symlink from `/etc/nginx/sites-enabled/` to the file in the clone. After any change to either file:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Check the enabled sites:

```bash
ls -l /etc/nginx/sites-enabled/
```

Expected: one symlink pointing to `/opt/chambalink/deploy/nginx/chambalink.conf` and no `default` entry.

## Cloudflare real-IP ranges

`deploy/nginx/cloudflare-real-ip.conf` is generated from Cloudflare's published lists. Run from the repository root:

```bash
{ echo '# Cloudflare proxy ranges. Generated from https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6'; for f in ips-v4 ips-v6; do curl -fsS https://www.cloudflare.com/$f | sed 's/.*/set_real_ip_from &;/'; echo; done; echo 'real_ip_header CF-Connecting-IP;'; } > deploy/nginx/cloudflare-real-ip.conf
```

The file is committed. nginx on the VM reads the copy in `/opt/chambalink` after `git pull --ff-only` and a reload.

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

For requests from Cloudflare's ranges, nginx logs and forwards the visitor address from `CF-Connecting-IP`. The API logs the client address as seen by Fastify, which trusts `X-Forwarded-For` from loopback and private-network peers (`trustProxy: "loopback,uniquelocal"`).
