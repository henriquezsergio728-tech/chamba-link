# 0017. Network load balancer in front of the application nodes

## Context

Until 2026-11-04 the domain's `A` record pointed at the original application host, so one VM served every request. Always Free allows two A1 instances, and production runs the original application host and the second application node ([Deployment](../deployment.md#hosts), [ADR 0016](0016-application-node-provisioning.md)).

nginx terminates TLS on each node ([ADR 0006](0006-cloudflare-origin-ca-certificate.md)), and the host firewall admits port 443 by source address ([ADR 0007](0007-host-firewall-cloudflare-ranges.md)), so the hop in front of nginx affects both.

## Decision

Since 2026-11-04 the domain's record points at an OCI network load balancer. Traffic goes from Cloudflare to the load balancer, and from there to nginx on both application nodes.

| Item | Setting |
| --- | --- |
| Listener | TCP 443 passthrough, proxy protocol off |
| Backend set | The original application host and the second application node, source IP preserved, hash on the 5-tuple |
| Health check | HTTPS on 443, path `/healthz`, expects `200`; does not validate the Origin CA certificate (verified) |
| Health probes | Come from the load balancer's private address |
| Fail-open | Off |
| Instant failover | On; configured, and not tested |
| TCP idle timeout | 120 s |
| Network security group | Allows 443 from anywhere to the load balancer |
| Host firewall | Each node admits Cloudflare's ranges, plus the load balancer's private address for probes |

## Consequences

- TLS still terminates in nginx, and Cloudflare still validates the origin certificate on each node.
- Client traffic keeps its Cloudflare source address, so the host firewall's Cloudflare range rules and nginx's `CF-Connecting-IP` handling apply as they did before the load balancer.
- The network security group admits any source, so the host firewall is what keeps other clients away from nginx.
- Each host firewall needs the probe rule. Without it, probes from the load balancer's private address do not reach nginx on that node.
- With no healthy backend, the load balancer resets connections, because fail-open is off.
- The health check does not validate the Origin CA certificate, so a healthy status says nothing about the certificate that Cloudflare validates.
- `/healthz` does not query Postgres, so a healthy status does not show that a node reaches the database.
- Both application nodes are in the same availability domain, so one domain failure takes both. Always Free allows two A1 instances.
- The load balancer closes TCP connections after 120 s idle. nginx's 30 s `keepalive_timeout` is set in the `chambalink_api` upstream, so it applies from nginx to the API and not to connections that cross the load balancer. The repository sets no `keepalive_timeout` for those connections.
- The load balancer hashes on the 5-tuple, so one client's connections can land on different nodes and the split need not be even. Sessions and rate-limit counters are in Postgres, so they do not depend on which node answers.
- The load balancer, its health check and the network security group are configured in OCI and are not in the repository.

## Evidence

- (a) Rebooting one node moved the backend-set status from OK to WARNING for about 35 to 60 s, in samples about 12 s apart, and back to OK about 65 s after boot start. It never reached CRITICAL, and no manual step was needed.
- (b) A direct request to the load balancer from a non-Cloudflare client was refused.
- (c) 20 requests through the domain split 5 and 15 across the nodes.
- (d) Established 443 peers were Cloudflare edge addresses.

### Not tested

- Instant failover under traffic.
- Request-level continuity during a node loss. Item (a) records the backend-set status, not the outcome of requests sent during the reboot.
