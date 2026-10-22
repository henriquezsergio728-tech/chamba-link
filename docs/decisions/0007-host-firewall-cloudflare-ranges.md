# 0007. Host firewall restricted to Cloudflare's IPv4 ranges

## Context

nginx runs on the production VM's host, so the host iptables `INPUT` chain applies to it. The origin accepted connections on ports 80 and 443 from any address, although clients reach the site through the Cloudflare proxy. Two alternatives were considered:

- An ipset of Cloudflare's ranges, which needs `ipset-persistent` to survive a reboot. That package is not installed.
- OCI security list rules, which apply to every VNIC in a subnet.

## Decision

Replace the open `ACCEPT` rules for ports 80 and 443 with 15 plain iptables rules that accept TCP 443 from each Cloudflare IPv4 range, and persist them by editing `/etc/iptables/rules.v4`. Port 80 has no `ACCEPT` rule. See [Deployment](../deployment.md#firewall).

## Consequences

- The ranges are a static copy of `https://www.cloudflare.com/ips-v4` dated 2026-10-22.
- Nothing refreshes them.
- Connections from Cloudflare addresses outside those ranges are rejected until the rules are updated.
- The rules live on the VM, not in the repository.
- The rules cover IPv4 only.
- Port 22 has no source restriction in the host rules.
- The drift check in [Deployment](../deployment.md#firewall-verification) compares the firewall rules with Cloudflare's list and does not cover `deploy/nginx/cloudflare-real-ip.conf`.
