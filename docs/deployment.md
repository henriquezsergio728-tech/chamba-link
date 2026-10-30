# Deployment

Runbook for production. Commands that start with `cd /opt/chambalink` or use `docker compose` run in the clone on the host that the section names; on the application host they run as the `ubuntu` user unless they use `sudo`. Where a section still says "the VM", it means the application host. Commands marked as run from outside the VM or the application host run on any other machine.

Production is two hosts: the application host runs nginx and the `api` container, and the database host runs Postgres. See [Hosts](#hosts) and [ADR 0012](decisions/0012-dedicated-database-host.md). A systemd timer on the database host backs up the database to Object Storage every six hours; see [Backups](#backups). The host firewall rules that restrict port 443 to Cloudflare's IPv4 ranges exist only on the application host, and the network security groups that restrict port 5432 exist only in OCI; neither is in the repository.

## Hosts

Both hosts are Oracle Cloud Infrastructure Always Free VMs.

| Item | Application host | Database host |
| --- | --- | --- |
| Shape | VM.Standard.A1.Flex (Ampere A1, arm64), 1 OCPU, 6 GB RAM | VM.Standard.E2.1.Micro (x86_64) |
| Runs | nginx on the host; the `api` container | The `db` container |
| Compose files | `compose.prod.yaml` and `deploy/app/compose.yaml` | `deploy/db/compose.yaml` |
| Network security group | `app-nodes` | `db-host` |

Application host:

| Item | Value |
| --- | --- |
| OS | Ubuntu 24.04 LTS |
| Hostname | `chambalink`, kept across reboots by `preserve_hostname: true` in `/etc/cloud/cloud.cfg.d/99-hostname.cfg` |
| Network | IPv4 only; the VM has no IPv6 address |
| Container runtime | Docker Engine with the Compose plugin v5.6.0 |
| Reverse proxy | nginx 1.24 from the Ubuntu package |

### Private network access

| Network security group | Holds | Rules |
| --- | --- | --- |
| `app-nodes` | The application host's VNIC | None of its own |
| `db-host` | The database host's VNIC | One ingress rule: TCP 5432 from `app-nodes` |

The subnet's security list has no rule for TCP 5432. Port 5432 is published only on the database host's private address (`DB_BIND_ADDR`). Docker-published ports bypass the host's iptables `INPUT` rules, so access to Postgres is gated by the bind address, the network security groups and the Postgres password. Traffic on port 5432 is not encrypted with TLS.

## Layout

On the application host:

| Path | Owner and mode | Contents |
| --- | --- | --- |
| `/opt/chambalink` | `ubuntu` | Clone of this repository |
| `/opt/chambalink/.env` | mode `600`, not in git | Production environment |
| `/etc/nginx/sites-enabled/` | root | Symlink to `/opt/chambalink/deploy/nginx/chambalink.conf`; the stock `default` site is removed |
| `/etc/ssl/chambalink/origin.key` | `root`, mode `600` | TLS private key |
| `/etc/ssl/chambalink/origin.pem` | `root` | Cloudflare Origin CA certificate |
| `/etc/iptables/rules.v4` | root | Persisted host IPv4 firewall rules |
| `/etc/docker/daemon.json` | root | Docker log rotation |
| `/etc/cloud/cloud.cfg.d/99-hostname.cfg` | root | `preserve_hostname: true` |

On the database host:

| Path | Contents |
| --- | --- |
| `/opt/chambalink` | Clone of this repository |
| `/opt/chambalink/.env` | Database host environment, not in git; see [Database host](#database-host) |
| `/etc/chambalink/backup.env` | Backup configuration, `root`, mode `600`; see [Backups](#backups) |
| `/etc/systemd/system/chambalink-backup.service`, `.timer` | Symlinks to the units in `/opt/chambalink/ops/systemd/` |

The application host's clone uses a read-only GitHub deploy key scoped to this repository. The key exists only on that host.

## Production environment

`/opt/chambalink/.env` on the application host defines:

| Variable | Purpose |
| --- | --- |
| `COMPOSE_FILE` | `compose.prod.yaml:deploy/app/compose.yaml`, so every `docker compose` command in `/opt/chambalink` uses both files and runs only `api` |
| `DATABASE_URL` | `postgres://<user>:<password>@<database host private address>:5432/<database>` |
| `API_TAG` | Full commit SHA of a published image |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Database user, password (generated with `openssl rand -hex 24`) and name. `compose.prod.yaml` ignores them while `DATABASE_URL` is set; step 6 of [Moving the database to another host](#moving-the-database-to-another-host) builds `DATABASE_URL` from them |

`compose.prod.yaml` passes `DATABASE_URL` to the `api` service and fails if `API_TAG` is unset. The database host's `.env` is described in [Database host](#database-host).

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
| Apex | `A` record to the application host, proxied |
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
| Cloudflare to nginx | Cloudflare Origin CA certificate on the application host | SSL/TLS mode Full (strict) |

The origin certificate:

- covers `chambalink.online` and a wildcard, and expires on Oct 18 2041;
- uses an RSA 2048 key generated on the application host with `openssl`; only the CSR was submitted to Cloudflare, so the private key has not left the application host;
- is trusted only by Cloudflare, so a client that reaches the origin directly gets an untrusted-certificate error unless it trusts Cloudflare Origin CA. From outside the application host, only Cloudflare's IPv4 ranges can reach port 443; see [Firewall](#firewall).

Cloudflare sends no expiry notifications for Origin CA certificates. No renewal is configured on the application host. See [ADR 0006](decisions/0006-cloudflare-origin-ca-certificate.md).

Check the certificate and key on the application host:

```bash
sudo openssl x509 -in /etc/ssl/chambalink/origin.pem -noout -subject -enddate -ext subjectAltName
sudo stat -c '%a %U' /etc/ssl/chambalink/origin.key
diff <(sudo openssl x509 -in /etc/ssl/chambalink/origin.pem -noout -pubkey) <(sudo openssl pkey -in /etc/ssl/chambalink/origin.key -pubout) && echo match
```

Expected: `notAfter=Oct 18 ... 2041 GMT`, a `subjectAltName` with the apex and the wildcard, `600 root`, and `match`.

Check that the origin certificate validates against Cloudflare's Origin CA RSA root, on the application host:

```bash
curl -fsS -o /tmp/origin_ca_rsa_root.pem https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem
curl -sS --cacert /tmp/origin_ca_rsa_root.pem --resolve chambalink.online:443:127.0.0.1 https://chambalink.online/healthz
```

Expected: `{"status":"ok"}`.

## Initial deployment

This is the sequence used for the initial deployment, when `db` and `api` ran on one host with `COMPOSE_FILE=compose.yaml:compose.prod.yaml`. Set `RELEASE_SHA` to the full commit SHA of a commit on `main` whose `image` job pushed an image.

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

This sequence runs on the application host. It has been executed once, when `db` and `api` ran on one host. Set `RELEASE_SHA` as above.

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

When it was executed, `docker compose pull` also fetched a newer `postgres:16` image, because `compose.yaml` referenced the tag `postgres:16` rather than a digest at the time. `docker compose up -d` then recreated the `db` container. The `pgdata` volume was kept. `docker volume inspect` and `docker inspect` on the VM showed that the volume was created about two days before the recreated `db` container, so it was not recreated.

`compose.yaml` now pins the `db` image to a `postgres:16` digest. The digest is the OCI image index of the `postgres:16` image running in production (PostgreSQL 16.15) and covers `linux/amd64` and `linux/arm64/v8`. `docker compose pull` no longer changes the Postgres build; changing it means changing the digest in `compose.yaml`, `deploy/db/compose.yaml` and `.github/workflows/ci.yml` in a pull request.

`git pull --ff-only` updates the Compose files and the nginx config in the working copy. nginx reads a changed config only after a reload; see [nginx](#nginx).

With the application host's `COMPOSE_FILE`, `docker compose pull` fetches only the API image, and the migrator runs against the database host through `DATABASE_URL`.

`API_TAG` pins the API image to one commit SHA. No rollback has been exercised.

## Verification

Image architecture:

```bash
docker image inspect --format '{{.Architecture}}' "ghcr.io/henriquezsergio728-tech/chamba-link-api:${RELEASE_SHA}"
```

Expected output: `arm64`.

Container health, on each host:

```bash
docker compose ps
```

Expected: `api` on the application host and `db` on the database host, each showing `(healthy)` in `STATUS`.

Listening ports, on the application host and on the database host:

```bash
sudo ss -ltn '( sport = :3000 or sport = :5432 )'
```

Expected: `127.0.0.1:3000` on the application host, and the database host's private address on port 5432 on the database host, with no `0.0.0.0` or `[::]` entries.

Database constraints and extension, on the database host:

```bash
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d bookings" -c "\dx btree_gist"'
```

Expected: `bookings_no_provider_overlap` under `Indexes`, `bookings_during_bounded` under `Check constraints`, and `btree_gist` version `1.7`.

Health endpoint through nginx, on the application host:

```bash
curl -i http://127.0.0.1/healthz
```

Expected: `HTTP/1.1 200 OK` and the body `{"status":"ok"}`.

Health endpoint through Cloudflare, from outside the application host:

```bash
curl -sI http://chambalink.online/healthz
curl -si https://chambalink.online/healthz
```

Expected: the first returns `301` with `Location: https://chambalink.online/healthz`. The second returns `HTTP/2 200`, `server: cloudflare`, a `cf-ray` header, and the body `{"status":"ok"}`.

Visitor address: after the request above, on the application host:

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

The file is committed. nginx on the application host reads the copy in `/opt/chambalink` after `git pull --ff-only` and a reload.

## Firewall

The stock OCI Ubuntu image has an iptables `INPUT` chain that ends in a `REJECT` rule. A port stays blocked by it even when the VCN security list allows it, unless an `ACCEPT` rule above the `REJECT` matches.

The host firewall rules exist only on the application host. The repository does not contain them. See [ADR 0007](decisions/0007-host-firewall-cloudflare-ranges.md).

### Applied rules

The IPv4 `INPUT` chain on the application host, in order:

| # | Rule |
| --- | --- |
| 1 | `ACCEPT` state `RELATED,ESTABLISHED` |
| 2 | `ACCEPT` ICMP |
| 3 | `ACCEPT` on `lo` |
| 4 | `ACCEPT` TCP 22, state `NEW`, no source restriction |
| 5-19 | `ACCEPT` TCP 443, state `NEW`, one rule per Cloudflare IPv4 range (`-s <range>`), 15 rules |
| 20 | `REJECT` with `icmp-host-prohibited` |

- There is no `ACCEPT` rule for port 80. nginx still listens on 80, and `curl -si http://127.0.0.1/healthz` on the application host returns `HTTP/1.1 200 OK`, but port 80 is unreachable from outside the application host.
- The 15 ranges were copied from `https://www.cloudflare.com/ips-v4` on 2026-10-22 (UTC).
- No ipset is used; the `ipset-persistent` package is not installed.
- IPv6 rules were not changed. The application host has no IPv6 address.

### Persistence

The rules are persisted by editing `/etc/iptables/rules.v4`, not with `netfilter-persistent save`. The original stock rules were saved before Docker was installed, so Docker's chains are not part of the persisted rules. Running `sudo netfilter-persistent save` now that Docker is installed would also persist Docker's chains.

### Procedure as executed

This procedure has been executed once, starting from the earlier layout in which position 6 of the `INPUT` chain was the open 443 rule and a separate rule accepted port 80. The live rules were applied first and the file edited afterwards.

Fetch the ranges:

```bash
curl -fsS https://www.cloudflare.com/ips-v4 -o /tmp/cf4.txt && grep -c . /tmp/cf4.txt
```

Expected output: `15`.

Insert one rule per range at position 6, then delete the open 443 and 80 rules:

```bash
while read -r n; do sudo iptables -I INPUT 6 -s "$n" -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT; done < /tmp/cf4.txt
sudo iptables -D INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT
sudo iptables -D INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT
```

Rewrite `/etc/iptables/rules.v4` from a backup, replacing the two original `ACCEPT` lines for ports 80 and 443 with the 15 range lines:

```bash
sudo cp -a /etc/iptables/rules.v4 /etc/iptables/rules.v4.bak
sudo awk -v list=/tmp/cf4.txt '$0=="-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT"{next} $0=="-A INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT"{while((getline n<list)>0)print "-A INPUT -s " n " -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT";close(list);next} {print}' /etc/iptables/rules.v4.bak | sudo tee /etc/iptables/rules.v4 >/dev/null
sudo sh -c 'iptables-restore --test < /etc/iptables/rules.v4' && echo syntax-ok
sudo diff /etc/iptables/rules.v4.bak /etc/iptables/rules.v4 | grep -c '^[<>]'
```

Expected: `syntax-ok` and `17` (2 lines removed, 15 added). The backup file was removed afterwards.

No procedure for refreshing the ranges has been exercised.

### Firewall verification

On the application host, rule order and counts:

```bash
sudo iptables -S INPUT
sudo iptables -S INPUT | grep -c "dport 443"
sudo iptables -S INPUT | grep -c "dport 80"
```

Expected: the order in [Applied rules](#applied-rules), then `15` and `0`.

On the application host, compare the 443 rules with Cloudflare's current list:

```bash
diff <(curl -fsS https://www.cloudflare.com/ips-v4 | sort) <(sudo iptables -S INPUT | sed -n 's/^-A INPUT -s \([^ ]*\) .*--dport 443.*/\1/p' | sort) && echo in-sync
```

Expected: `in-sync`. This check compares the firewall rules only, not `deploy/nginx/cloudflare-real-ip.conf`.

On the application host, packet counters on the Cloudflare range rules:

```bash
sudo iptables -L INPUT -v -n | grep 'dpt:443'
```

Expected: the `pkts` counters increase after requests through Cloudflare.

From outside the application host, through Cloudflare:

```bash
curl -sI https://chambalink.online/healthz
curl -sI http://chambalink.online/healthz
```

Expected: `HTTP/2 200` for the first; `301` with `server: cloudflare` for the second.

From outside the application host, directly to the origin, with `<application host address>` replaced by the application host's public IPv4 address:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --resolve chambalink.online:443:<application host address> https://chambalink.online/healthz; echo "exit=$?"
```

Expected: `000` and `exit=7` (could not connect).

After a reboot, the chain had 15 rules matching `dport 443` and 0 matching `dport 80`, nginx was active, and `api` and `db` were healthy.

### Checks that no longer work from outside the application host

- Any request to the application host's address on port 80.
- Any request to the application host's address on port 443 from an address outside Cloudflare's ranges, including `curl --cacert ... --resolve chambalink.online:443:<application host address>`. Run the origin certificate check on the application host against `127.0.0.1`, as in [TLS](#tls).

The checks on the application host against `127.0.0.1` and the checks through `chambalink.online` are unaffected.

### Docker

Docker-published ports bypass `INPUT` rules. For this reason the `api` container publishes on `127.0.0.1` only, and only nginx is reachable from outside the application host. On the database host, `db` publishes 5432 on the private address only; see [Private network access](#private-network-access).

## Backups

Backups run on the database host. The application host has no backup timer.

`ops/backup.sh` dumps the database with `pg_dump -Fc`, checks the archive with `pg_restore --list`, uploads it to a private, versioned Object Storage bucket with the OCI CLI and the host's instance principal, and compares the uploaded object's size with the local file. Objects are named `postgres/YYYY/MM/chambalink-YYYYMMDDTHHMMSSZ.dump`. `ops/systemd/chambalink-backup.timer` starts `chambalink-backup.service`, which runs the script as root, at 00:15, 06:15, 12:15 and 18:15 UTC with up to 120 s of random delay. See [ADR 0011](decisions/0011-database-backups.md).

### Configuration

`/etc/chambalink/backup.env` is the unit's `EnvironmentFile`:

| Key | Value |
| --- | --- |
| `BACKUP_BUCKET` | Name of the Object Storage bucket |
| `OCI_CLI` | Absolute path of the `oci` executable; systemd does not search the login shell's `PATH` for it |
| `COMPOSE_FILE` | Optional. Compose file list for the script's `docker compose exec` calls. Unset, Compose takes `COMPOSE_FILE` from the clone's `.env` |

On the database host, `backup.env` sets `BACKUP_BUCKET` and `OCI_CLI`, and Compose takes `COMPOSE_FILE=deploy/db/compose.yaml` from the clone's `.env`; see [Database host](#database-host).

The script also reads `BACKUP_LOCK`, the lock file path, which defaults to `/run/lock/chambalink-backup.lock`.

### Install

Create the configuration file and set both keys:

```bash
sudo install -d -m 700 /etc/chambalink
sudo install -m 600 /dev/null /etc/chambalink/backup.env
sudoedit /etc/chambalink/backup.env
```

Link the units from the clone and start the timer:

```bash
sudo systemctl link /opt/chambalink/ops/systemd/chambalink-backup.service /opt/chambalink/ops/systemd/chambalink-backup.timer
sudo systemctl enable --now chambalink-backup.timer
systemctl list-timers chambalink-backup.timer
```

`list-timers` shows the next run. The units are symlinks into the clone, so `git pull` updates them; run `sudo systemctl daemon-reload` after a pull that changes a unit file.

### Run a backup now

```bash
sudo systemctl start chambalink-backup.service
```

The command returns when the backup has finished. A failed backup makes it exit non-zero.

### Logs

```bash
sudo journalctl -u chambalink-backup.service
systemctl status chambalink-backup.service
```

A successful run logs `backup ok: <object name> <bytes> bytes in <seconds>s`. A failed run logs a line starting with `backup:` and leaves the unit in the `failed` state.

### List backups

```bash
sudo sh -c '. /etc/chambalink/backup.env && "$OCI_CLI" os object list --auth instance_principal --bucket-name "$BACKUP_BUCKET" --prefix postgres/ --all'
```

## Database host

The database host runs [`deploy/db/compose.yaml`](../deploy/db/compose.yaml), which runs only Postgres, as the Compose project `chambalink-db`. Its `db` service uses the same pinned image as `compose.yaml`, the named volume `pgdata`, the same `pg_isready` healthcheck and `restart: unless-stopped`, and starts Postgres with `max_connections=50`, `shared_buffers=128MB` and `effective_cache_size=384MB`. It publishes port 5432 on `DB_BIND_ADDR` only.

The clone's `.env` on the database host defines:

| Variable | Purpose |
| --- | --- |
| `DB_BIND_ADDR` | Required. The host's private address; 5432 is published on it. Compose refuses to start the file when it is unset |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Database user, password and name; the `postgres:16` image creates the user and database from them when it initializes an empty volume |
| `COMPOSE_FILE` | `deploy/db/compose.yaml`, so `docker compose` commands in the clone use this file |

Docker Compose reads these from `.env` in the directory where `docker compose` runs, so the clone's `.env` serves `docker compose` commands and `ops/backup.sh` alike. The backup units and `/etc/chambalink/backup.env` are installed as in [Backups](#backups).

The application host runs only the `api` service and reaches the database over the private network. It uses `compose.prod.yaml` with [`deploy/app/compose.yaml`](../deploy/app/compose.yaml), which removes the api's `depends_on` on `db`, and sets `DATABASE_URL`; see [Production environment](#production-environment).

`compose.prod.yaml` uses `DATABASE_URL` when it is set and otherwise builds it from the `POSTGRES_*` variables for the `db` service. With this file list, `docker compose up -d --wait` starts only `api`, and `docker compose run --rm api node dist/migrate.js` runs the migrator against the database host. `deploy/app/compose.yaml` uses the `!reset` tag, which needs Docker Compose 2.24.0 or later.

## Restoring from a backup

This procedure has been executed on the database host, restoring a dump taken on the arm64 application host. It restores into an empty database: a scratch database created for a drill, or the `POSTGRES_DB` database of a freshly initialized volume. For a 17 KB dump it took about 15 seconds, including the download. Run it from `/opt/chambalink` on the host that restores.

Print the name of the newest backup. Object names contain a UTC timestamp and the listing is sorted by name, so the last entry is the newest:

```bash
sudo sh -c '. /etc/chambalink/backup.env && "$OCI_CLI" os object list --auth instance_principal --bucket-name "$BACKUP_BUCKET" --prefix postgres/ --all --query "data[-1].name" --raw-output'
```

Download it with the host's instance principal. `umask 077` makes the dump mode `600`:

```bash
OBJECT=<object name printed above>
sudo sh -c 'umask 077; . /etc/chambalink/backup.env && "$OCI_CLI" os object get --auth instance_principal --bucket-name "$BACKUP_BUCKET" --name "$1" --file /tmp/chambalink-restore.dump' sh "$OBJECT"
```

Restore into the empty database. `--exit-on-error` stops at the first failed statement instead of continuing past it:

```bash
TARGET_DB=<empty database>
sudo cat /tmp/chambalink-restore.dump | docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error' sh "$TARGET_DB"
```

Count the rows of every table exactly, in the restored database and in the database the dump came from, and compare the two outputs:

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$1" -At' sh "$TARGET_DB" <<'SQL'
SELECT table_schema || '.' || table_name,
       (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1;
SQL
```

Check the booking exclusion constraint and the audit trigger:

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$1" -At' sh "$TARGET_DB" <<'SQL'
SELECT conname FROM pg_constraint WHERE conname = 'bookings_no_provider_overlap';
SELECT tgname FROM pg_trigger WHERE tgname = 'audit_log_append_only';
SQL
```

Expected: identical row counts for every table, then `bookings_no_provider_overlap` and `audit_log_append_only`. Delete `/tmp/chambalink-restore.dump` afterwards.

## Moving the database to another host

This procedure has been executed once, to move the database from the application host to the database host. The source host ran `db` and `api` with `COMPOSE_FILE=compose.yaml:compose.prod.yaml` and the backup timer; the target host ran `deploy/db/compose.yaml` as in [Database host](#database-host), with the backup units and `backup.env` installed.

1. On the source host, which is also the application host, stop the API so that no writes arrive after the final dump:

   ```bash
   cd /opt/chambalink
   docker compose stop api
   ```

2. On the source host, take a final dump with the backup unit, and check its `backup ok:` line:

   ```bash
   sudo systemctl start chambalink-backup.service
   sudo journalctl -u chambalink-backup.service -n 5
   ```

3. On the target host, recreate the volume, so that the restore runs into an empty database:

   ```bash
   cd /opt/chambalink
   docker compose down --volumes
   docker compose up -d --wait
   ```

4. On the target host, restore the newest object into `POSTGRES_DB`, as in [Restoring from a backup](#restoring-from-a-backup). Check that the object name printed is the one from step 2.

5. Run the exact row count query from [Restoring from a backup](#restoring-from-a-backup) on the source host and on the target host, with `TARGET_DB` set to the database name, and diff the two outputs. Expected: no differences.

6. On the application host, append `DATABASE_URL` and switch `COMPOSE_FILE` to the application-node files:

   ```bash
   cd /opt/chambalink
   DB_ADDR=<target host private address>
   [ -z "$(tail -c1 .env)" ] || echo >> .env
   (. ./.env && printf 'DATABASE_URL=postgres://%s:%s@%s:5432/%s\n' "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$DB_ADDR" "$POSTGRES_DB") >> .env
   sed -i 's|^COMPOSE_FILE=.*|COMPOSE_FILE=compose.prod.yaml:deploy/app/compose.yaml|' .env
   grep -c '^DATABASE_URL=' .env
   docker compose up -d --wait
   ```

   The first command ends `.env` with a newline if it lacks one; otherwise the appended `DATABASE_URL` would be glued onto the last line. `.env` is sourced in a subshell. Sourced into the login shell with `set -a`, as in the README's quick start, it would export the old `COMPOSE_FILE`, and Docker Compose gives an exported variable precedence over `.env`, so the next `docker compose` command would still use the old file list. The URL is built from the `POSTGRES_*` values in the application host's `.env`, which must match the target host's.

7. From outside the VM, send a request through `https://chambalink.online` that writes, such as a registration, and check on the target host that the row is there:

   ```bash
   docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT event, at, request_id FROM audit_log ORDER BY id DESC LIMIT 1"'
   ```

8. On the source host, stop the backup timer, and on the target host, start it, as in [Install](#install):

   ```bash
   sudo systemctl disable --now chambalink-backup.timer
   sudo rm /etc/systemd/system/chambalink-backup.service && sudo systemctl daemon-reload
   ```

   `disable --now` removes only the timer's link. The link to the oneshot service in `/etc/systemd/system` remains, and starting that service would dump the stale database, so the link is removed as well. Both commands were run on the source host.

Keep the previous database container on the source host until the move is verified. Its data is no longer written to, but `docker compose exec` still reaches it after `COMPOSE_FILE` no longer defines `db`, because Compose finds the orphaned container by its project and service labels. A backup timer left enabled on the source host therefore keeps dumping the stale database and uploading it to the same bucket, where it can become the newest object.

## Logs

| Source | Command |
| --- | --- |
| API | `docker compose logs --tail 200 api` |
| Database | `docker compose logs --tail 200 db` |
| nginx access and errors | `sudo tail -n 200 /var/log/nginx/access.log /var/log/nginx/error.log` |
| nginx service | `sudo journalctl -u nginx --since today` |
| Backups | `sudo journalctl -u chambalink-backup.service` |

Run the `docker compose` commands from `/opt/chambalink`. Add `-f` to follow. The database and backup logs are on the database host; the others are on the application host.

`/etc/docker/daemon.json` sets the `json-file` log driver with `max-size` `10m` and `max-file` `3`, so each container keeps at most three 10 MB log files.

For requests from Cloudflare's ranges, nginx logs and forwards the visitor address from `CF-Connecting-IP`. The API logs the client address as seen by Fastify, which trusts `X-Forwarded-For` from loopback and private-network peers (`trustProxy: "loopback,uniquelocal"`).
