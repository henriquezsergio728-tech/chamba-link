# 0016. Application node provisioning

## Context

The application host was built by hand. Its Docker, nginx, firewall and TLS setup exist only on that VM, partly as settings outside the repository ([ADR 0007](0007-host-firewall-cloudflare-ranges.md), [ADR 0015](0015-nginx-connection-reuse-and-limits.md)), so a second node or a replacement has no reproducible starting point.

Oracle's [Always Free documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) allows two Ampere A1 instances of 1 OCPU each, which the two nodes use.

## Decision

**Nodes are provisioned by a script.** [`ops/node/bootstrap.sh`](../../ops/node/bootstrap.sh) builds an application node from a fresh Ubuntu 24.04 image, and every step compares before it writes, so a second run changes nothing. [`ops/node/verify.sh`](../../ops/node/verify.sh) checks the result and changes nothing. The firewall's Cloudflare ranges come from the IPv4 lines of [`deploy/nginx/cloudflare-real-ip.conf`](../../deploy/nginx/cloudflare-real-ip.conf), with no network fetch.

**Secrets come from a root-only directory.** The script reads the TLS certificate and key and the API's `DATABASE_URL` only from `/etc/chambalink/secrets/`, and does not print them. The repository holds no secret, and the script takes none as an argument or environment variable.

**A provisioned node runs only the API.** Its `COMPOSE_FILE` leaves out `deploy/app/migrate.yaml` and its `.env` has no `MIGRATE_DATABASE_URL`, so the owner's URL does not reach it. The script refuses a host whose `.env` defines that variable.

See [Deployment](../deployment.md#provisioning-an-application-node).

## Consequences

- Copying the TLS private key to a second node puts it on more than the host that generated it.
- The firewall rules on a node follow the repository's copy of Cloudflare's ranges, so they are as current as that file. A change takes a new run of the script.
- A run without `/etc/chambalink/extra_443_sources` removes the rules for its sources and saves the result.
- A run after Docker is installed that changes the `INPUT` chain, or saves it because `/etc/iptables/rules.v4` differs, also persists Docker's chains ([Deployment](../deployment.md#persistence)).
- `/healthz` does not query Postgres, so a passing run does not show that the node reaches the database.
- The parsing and rule list are repeated in `verify.sh`, so that each script stands alone.
- The script does not create the VM, join it to the `app-nodes` network security group, or change DNS or Cloudflare.
- The original application host ([Deployment](../deployment.md#hosts)) is hand-built. The script refuses to run there, because that host's `.env` defines `MIGRATE_DATABASE_URL`. That host holds the extra 443 sources file only so that `verify.sh` accounts for the load balancer's probe rule ([ADR 0017](0017-network-load-balancer.md)). Only the script builds rules from that file, so the file does not build that host's rule.
