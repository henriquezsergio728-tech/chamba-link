# Performance

Load measurements of the production application host, taken with the k6 scripts in [`load/`](../load/README.md). The result files are written to `load/results/`, which is not in git; this page records the figures from them.

## Method

- k6 ran on a workstation and sent requests to the public hostname, through Cloudflare, to the one application host: a 1-OCPU Arm VM that runs nginx and the `api` container ([Deployment](deployment.md#hosts)).
- Each run is a sequence of `constant-arrival-rate` steps of 45 seconds, one per target rate, named `r<rate>`, with a 5-second gap between steps ([Load scripts](../load/README.md#scripts)).
- A step is valid when `dropped` is `0` and the run's `non_dynamic` and `no_cf_header` counters are `0` ([Validity checks](../load/README.md#validity-checks)).
- A run aborts when a step reaches 10% failed requests or a 95th percentile of 5 seconds. For an aborted step, the time it ran is estimated as `(requests + dropped) / rate`.
- During each run, `top` on the application host sampled the CPU every 2 seconds. Busy is 100% minus top's idle share, so it includes steal; the figures below are means over the samples inside each step, leaving out its first and last 2 seconds.

## S0a: application tier

[`load/s0a-app-tier.js`](../load/s0a-app-tier.js) requests `GET /healthz`, which the API answers without querying Postgres, so the runs measure Cloudflare, nginx, `docker-proxy` and the Node process.

### Before: default nginx connection handling

nginx opened a new connection to the API for every request, through `docker-proxy`, with `worker_connections 768`.

Run A, started 22:33 UTC on 2026-11-02 (`s0a-app-tier-20261102T223612Z.json`):

| Step | p95 | Failed | Dropped |
| --- | --- | --- | --- |
| `r100` | 175 ms | 0% | 0 |
| `r250` | 155 ms | 0% | 0 |
| `r500` | 163 ms | 0% | 0 |
| `r1000` | Aborted after about 11 s | 12.9% | 1037 |

Run B, started 23:40 UTC (`s0a-app-tier-20261102T234252Z.json`):

| Step | p95 | Failed | Dropped |
| --- | --- | --- | --- |
| `r600` | 585 ms, p99 3.85 s | 0% | 16 |
| `r700` | 349 ms | 0% | 0 |
| `r800` | 2.02 s | 2.67% | 249 |
| `r900` | Aborted after about 13 s | 11.25% | 240 |

Run C, started 00:28 UTC on 2026-11-03 (`s0a-app-tier-20261103T003039Z.json`):

| Step | p95 | Failed | Dropped |
| --- | --- | --- | --- |
| `r300` | 176 ms | 0% | 0 |
| `r700` | 388 ms | 0% | 0 |
| `r900` | Aborted after about 11 s | 10.4% | 0 |

- The failed requests in these runs were `500` responses from nginx, which logged `worker_connections are not enough while connecting to upstream` ([ADR 0015](decisions/0015-nginx-connection-reuse-and-limits.md)).
- `non_dynamic` was `0` in all three runs. `no_cf_header` was 38, 34 and 20 in runs A, B and C, equal to the responses k6 counted with a status outside its list in the failing steps (38; 30 and 4; 20). This indicates that the responses without a `cf-cache-status` header were failed responses; the run summaries do not give the counts per step.
- At `r700` in run C the CPU was 94.4% busy: `node` ~33%, `nginx` ~24%, `docker-proxy` ~24%, `dockerd` and `containerd` ~8%.

### After: upstream keepalive and raised limits

The configuration recorded in [ADR 0015](decisions/0015-nginx-connection-reuse-and-limits.md): an upstream with `keepalive 64`, `worker_connections 4096` and `worker_rlimit_nofile 8192`.

Run D, started 00:34 UTC on 2026-11-03 (`s0a-app-tier-20261103T003818Z.json`):

| Step | p95 | Failed | Dropped | CPU busy | Steal |
| --- | --- | --- | --- | --- | --- |
| `r300` | 182 ms | 0% | 0 | 33.9% | 2.5% |
| `r700` | 190 ms | 0% | 0 | 63.4% | 5.9% |
| `r900` | 184 ms | 0% | 0 | 76.0% | 8.0% |
| `r1100` | 316 ms | 0% | 0 | 85.3% | 9.7% |
| `r1300` | 209 ms | 0% | 0 | 92.8% | 11.2% |

- `non_dynamic` and `no_cf_header` were `0`, so the run is valid.
- Rates above 1300 requests per second were not measured.
