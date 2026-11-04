# 0015. nginx connection reuse and connection limits

## Context

nginx on the application host proxied every request to `http://127.0.0.1:3000` with a new TCP connection to the API. The port is published by Docker, so Docker's userland proxy (`docker-proxy`) accepted each of those connections and copied it to the `api` container. Each nginx worker had the distribution default of `worker_connections 768`.

The S0a load test ([`load/s0a-app-tier.js`](../../load/s0a-app-tier.js), `GET /healthz`) measured the application host, one 1-OCPU Arm VM, with load sent through Cloudflare; see [Performance](../performance.md) for the method and the figures per run. Steps up to 700 requests per second had no failed requests. At 800 to 1000 requests per second the CPU reached 100% busy, with 9 to 10% steal, and nginx answered `500` and logged `worker_connections are not enough while connecting to upstream`: 1294 such alerts in the first saturated step, equal to the 1294 requests logged with status `500`.

At 700 requests per second the processes on the path used this share of the CPU, and the CPU was 94.4% busy:

| Process | CPU |
| --- | --- |
| `node` (the API) | ~33% |
| `nginx` | ~24% |
| `docker-proxy` | ~24% |
| `dockerd` and `containerd` | ~8% |

## Decision

**Reuse connections to the API.** [`deploy/nginx/chambalink.conf`](../../deploy/nginx/chambalink.conf) defines the upstream `chambalink_api` with `server 127.0.0.1:3000`, `keepalive 64` and `keepalive_timeout 30s`, and the `location /` proxies to `http://chambalink_api` with `proxy_http_version 1.1` and `proxy_set_header Connection ""`. Each worker keeps up to 64 idle connections to the API and sends later requests on them instead of opening a new connection through `docker-proxy`. `keepalive_timeout 30s` is shorter than Fastify's default idle timeout of 72 seconds, so nginx closes an idle connection before the API does.

**Raise the connection and descriptor limits.** The distribution's `/etc/nginx/nginx.conf` sets `worker_connections 4096` in the `events` block and `worker_rlimit_nofile 8192` in the main context. A proxied request holds two connection slots, one for the client and one for the upstream, and every slot is a file descriptor, so the descriptor limit is raised above the slots; without it, workers keep the open-files soft limit of 1024. This file is outside the repository; [Deployment](../deployment.md#settings-outside-the-repository) records the settings and how to check them.

**Result.** With both changes, at 700 requests per second the CPU was 63.4% busy:

| Process | CPU before | CPU after |
| --- | --- | --- |
| `node` | ~33% | ~24% |
| `nginx` | ~24% | ~17% |
| `docker-proxy` | ~24% | ~7% |
| `dockerd` and `containerd` | ~8% | ~10% |

Every step through 1300 requests per second had 0% failed requests and 0 dropped iterations. At 1300 requests per second the 95th percentile was 209 ms, the CPU 92.8% busy and steal 11.2%. Rates above 1300 requests per second were not measured.

## Alternatives

- **Raise only the limits.** More `worker_connections` and descriptors change how overload fails, but add no capacity, because the CPU was saturated.
- **Disable Docker's userland proxy** (`"userland-proxy": false` in `/etc/docker/daemon.json`). It is a daemon-wide setting, and applying it restarts the Docker daemon. With connections reused, `docker-proxy` still uses ~11% of the CPU at 1300 requests per second.
- **Host networking or a unix socket for the API.** Either would take `docker-proxy` out of the path. Neither is adopted.

## Consequences

- No step through 1300 requests per second produced a `500` from nginx. Behavior at higher rates was not measured.
- The upstream `keepalive_timeout` must stay below the API's idle timeout. If the API's `keepAliveTimeout` is lowered below 30 seconds, nginx can reuse a connection that the API has just closed.
- `worker_connections` and `worker_rlimit_nofile` live in `/etc/nginx/nginx.conf`, outside the repository. [`ops/node/bootstrap.sh`](../../ops/node/bootstrap.sh) sets them on every node it provisions ([ADR 0016](0016-application-node-provisioning.md)).
