# 0018. Autoscaling by load-driven activation of a standby backend

## Context

Two application nodes sit behind the network load balancer ([ADR 0017](0017-network-load-balancer.md)). Always Free caps A1 at two instances ([ADR 0016](0016-application-node-provisioning.md)), so instance-pool autoscaling has no instance to add.

The load balancer has a per-backend backup flag. The SDK documents that a backend with `is_backup` set receives no ingress traffic unless all backends without the flag fail the health check.

## Decision

The second application node is a backup backend, and a controller on the original application host activates it by load. This is activation of a standby, not instance-pool autoscaling: no instance is created or destroyed, and the second node runs whether it is active or not.

[`ops/controller/controller.py`](../../ops/controller/controller.py) samples CPU from `/proc/stat` and changes only the second node's `is_backup`. Utilization is `1 - (idle + iowait) / total`, from deltas of the aggregate `cpu` line.

| Item | Default |
| --- | --- |
| Sample interval | 5 s |
| Scale out, clearing the flag | Mean over the last 30 s is at least 0.70 |
| Scale in, setting the flag | Mean over the last 300 s is at most 0.30 |
| After a change | No further change for 120 s, and both windows are cleared |
| Demo profile | Scale-in window of 60 s, nothing else |

**No decision on a partial window.** A window is full when it holds its whole set of samples taken since the last change or start, so a restart does not act on partial data. When both windows trigger, scale out wins.

**The scale-in threshold must be strictly below half of the scale-out threshold.** When the standby activates, this node's share of the load roughly halves. With a higher scale-in threshold, the load that triggered a scale out would land at or below the scale-in threshold, and the controller would flap. The controller refuses to start otherwise.

**Each update changes one field.** The controller reads the backend and its health immediately before acting, and sends `is_backup` with `weight`, `is_drain` and `is_offline` as just read. It makes no call when the flag already has the target value. A change counts as done when the work request has succeeded and a read shows the target; a timeout is logged as an error and is not assumed to be a success.

**The controller fails static.** A metric or API error is logged and ignored for that tick, API errors back off exponentially up to a cap, and the flag stays as it is. `SIGTERM` exits cleanly and leaves the flag alone.

See [Deployment](../deployment.md#standby-activation-controller).

## Consequences

- There is one signal from one node. The controller sees only the original application host's CPU, so load on the second node, memory pressure and slow database queries do not reach it.
- The controller shares that node's CPU. Under saturation it competes with the load it measures; the unit raises its CPU weight and lowers its OOM score to reduce that.
- The load balancer balances only new connections, and Cloudflare reuses origin connections, so traffic shifts gradually after a scale out. The CPU signal lags behind the flag for the same reason.
- `is_drain` is documented to keep existing connections and `is_backup` is documented only for ingress traffic. The controller does not drain, and what a scale in does to connections established on the second node has not been measured.
- Both instances are in one availability domain ([ADR 0017](0017-network-load-balancer.md)), so activating the standby adds capacity and not domain redundancy.
- Two instances is the cap. There is no step beyond both nodes active, so load above that capacity is not handled.
- The flapping rule limits the scale-in threshold, and it depends on the load splitting roughly in half. The 5-tuple hash need not split evenly ([ADR 0017](0017-network-load-balancer.md)).
- While the flag is set, the original application host serves all traffic, and the second node receives traffic only if the original host fails the health check.
- If the original application host fails, the controller stops with it and the flag stays as it was. Traffic moving to a backup is then the load balancer's behavior, not the controller's.
- A first start with the flag clear needs no manual step: a full scale-in window of low load sets it.
- The controller holds cooldown and windows in memory, so a restart forgets a recent change and starts with empty windows.
- The dynamic group and the policy that authorize the controller are configured in OCI and are not in the repository.
