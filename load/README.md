# Load scripts

k6 scripts that measure the API at increasing request rates. They are plain k6 JavaScript modules with no npm dependencies, and they are not part of the pnpm workspace, the TypeScript build or CI. They were validated with k6 v2.3.0.

Run them from the repository root, because the summary files are written to a path relative to the current directory, and create the results directory first, because k6 does not create it:

```bash
mkdir -p load/results
```

## Scripts

| Script | Requests | Expected status |
| --- | --- | --- |
| `s0a-app-tier.js` | `GET /healthz`, which answers from the API process without querying Postgres | `200` |
| `s0b-session.js` | `GET /v1/me` with a session cookie. Each request runs one `SELECT` joining `sessions`, `accounts` and `account_credentials`. Like every route under `/v1/auth` and `/v1/me`, about 1% of requests also start a `DELETE` of rate-limit rows older than 24 hours | `200` |
| `s0c-auth.js` | `POST /v1/auth/login` 35 times in a row from one VU with one account | `200` for the first 30, then `429` |

`s0a-app-tier.js` and `s0b-session.js` share `lib.js`, which turns `RATES` into one `constant-arrival-rate` scenario per rate, named `r<rate>` (for example `r250`). The scenarios run one after another, each for `STEP_SECONDS`, with a 5-second gap between them; requests still in flight at the end of a step get up to 5 seconds to finish. Response bodies are discarded.

Every step has its own thresholds, and two of them stop the whole run when they fail, with `delayAbortEval` set to 10 seconds so that a few early samples do not abort it:

- `http_req_failed{scenario:r<rate>}`: `rate<0.10`, so a step with 10% or more failed requests (any status of 400 or above, or no response) aborts the run.
- `http_req_duration{scenario:r<rate>}`: `p(95)<5000`, so a step whose 95th percentile reaches 5 seconds aborts the run.

An aborted run exits with code 99 and still prints the table and writes the summary.

Both scripts count two values on every response:

- `non_dynamic`: responses with a `cf-cache-status` header whose value is not `DYNAMIC`, that is, responses that Cloudflare's cache served or considered instead of passing them to the API.
- `no_cf_header`: responses without a `cf-cache-status` header. Every response from a local API counts here, because no Cloudflare proxy is in the path.

`s0c-auth.js` uses the `per-vu-iterations` executor with 1 VU and 35 iterations. It records the duration of `200` responses in the trend `login_ok_duration` and of `429` responses in `login_limited_duration`, and logs once, when the first `429` arrives, its iteration index (counted from 0) and its `Retry-After` value. k6 tags every request with its response status, and the summary includes the request counts for statuses `200`, `429` and `401`. The script does not call `POST /v1/auth/register` and creates no accounts.

## Environment variables

| Variable | Used by | Required | Default |
| --- | --- | --- | --- |
| `BASE_URL` | all | Yes, no default; the scripts exit before sending a request when it is unset | none |
| `RATES` | `s0a`, `s0b` | Yes; comma-separated positive integers, in requests per second | none |
| `STEP_SECONDS` | `s0a`, `s0b` | No; seconds per rate step | `45` |
| `PRE_ALLOCATED_VUS` | `s0a`, `s0b` | No; VUs started before each step | `100` |
| `MAX_VUS` | `s0a`, `s0b` | No; most VUs a step may use, raised to `PRE_ALLOCATED_VUS` if lower | `1000` |
| `SESSION_COOKIE` | `s0b` | Yes; the full `name=value` pair, `session=<token>` | none |
| `LOGIN_EMAIL` | `s0c` | Yes | none |
| `LOGIN_PASSWORD` | `s0c` | Yes | none |

The API's session cookie is named `session`. It is `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the API runs with `NODE_ENV=production`, and lasts 30 days from login. `POST /v1/auth/login` and `POST /v1/auth/register` set it.

## Example runs

The values in angle brackets are placeholders.

```bash
BASE_URL=<base-url> RATES=100,250,500,1000,2000 k6 run load/s0a-app-tier.js

BASE_URL=<base-url> RATES=100,250,500 SESSION_COOKIE='session=<token>' k6 run load/s0b-session.js

BASE_URL=<base-url> LOGIN_EMAIL=<email> LOGIN_PASSWORD=<password> k6 run load/s0c-auth.js
```

Add `--quiet` to hide the progress bar.

## Results

Each run prints a compact report to standard output and writes k6's full JSON summary to `load/results/<script>-<timestamp>.json`, where the timestamp is UTC in ISO 8601 basic format, for example `s0a-app-tier-20261102T172859Z.json`. `load/results/` is ignored by git.

The report starts with a run line that records when the run finished and what it targeted:

```text
finished 2026-11-02T17:28:59.123Z base=<base-url> rates=100,250,500 step=45s
```

`step` is `STEP_SECONDS`, including its default. For `s0c-auth.js` the line has `finished` and `base` only. The JSON summary carries the same values in a top-level `run` object, for example `{"finished": "...", "base": "...", "rates": "100,250,500", "step": 45}`. Neither contains `SESSION_COOKIE`, `LOGIN_EMAIL` or `LOGIN_PASSWORD`.

For `s0a-app-tier.js` and `s0b-session.js` the report has one row per rate step:

| Column | Meaning |
| --- | --- |
| `step` | The scenario name, `r<rate>`, where the rate is the target in requests per second |
| `achieved rps` | Requests sent in the step divided by `STEP_SECONDS`. Below the target, the client could not keep up. `partial` for a step that was cut short, for which no rate is computed; see below |
| `requests` | Requests sent in the step |
| `p50`, `p95`, `p99` | Percentiles of `http_req_duration`, the time from sending the request to receiving the whole response |
| `failed` | Share of requests that failed |
| `errors` | Every status other than `200` that occurred in the step, as `<status>:<count>` separated by spaces, for example `0:12 502:3`. Statuses `0`, `401`, `403`, `404`, `408`, `429`, `499`, `500`, `502`, `503`, `504`, `520` to `526` and `530` are counted by name; any other status adds up to `other:<count>`. `-` when every response was `200` |
| `dropped` | Iterations k6 skipped because every VU up to `MAX_VUS` was busy |

A step that did not run, with no request sent and no iteration dropped, shows `-` in every column except `step`, `requests` and `dropped`.

A step is partial when `requests + dropped < 0.98 × (rate × STEP_SECONDS + 1)`. A `constant-arrival-rate` step that runs its whole duration starts `rate × STEP_SECONDS + 1` iterations, and each is either sent as a request or dropped, so a partial step stopped early, usually because a threshold aborted the run. Its `achieved rps` shows `partial`, and a footnote under the table gives the seconds it ran, estimated as `(requests + dropped) / rate`, for example:

```text
r1000: partial, ran about 11.1s ((requests + dropped) / 1000)
```

The counters `non_dynamic` and `no_cf_header` follow the table and the footnotes.

The JSON summary of `s0a-app-tier.js` and `s0b-session.js` also has a top-level `steps` array with one object per step:

| Member | Meaning |
| --- | --- |
| `step`, `rate` | The scenario name and its target rate |
| `ran` | `false` for a step that sent no request and dropped no iteration |
| `partial` | `true` for a partial step |
| `achievedRps` | `requests / STEP_SECONDS`, or `null` for a partial step or one that did not run |
| `estimatedSeconds` | `(requests + dropped) / rate` for a partial step, otherwise `null` |
| `requests`, `dropped` | As in the table |
| `p50`, `p95`, `p99` | `http_req_duration` percentiles in milliseconds, or `null` without requests |
| `failedRate` | Share of failed requests from 0 to 1, or `null` without requests |
| `errors` | The `errors` column's text, or `null` without requests |

What a status in `errors` usually indicates in this setup:

| Status | Usual source |
| --- | --- |
| `0` | No response reached k6: a connection error, such as a refused or reset connection, or k6's request timeout of 60 seconds |
| `404` | No route matched: `BASE_URL` points at the wrong host or path. Both `GET /healthz` and `GET /v1/me` exist in the API |
| `408` | nginx did not receive the request's headers or body within its client timeouts, 60 seconds by default; the nginx config does not change them |
| `401` | The API rejected the session: `SESSION_COOKIE` is missing, malformed, expired or logged out. `GET /healthz` does not return it |
| `403`, `429` | The Cloudflare layer, which can block or rate limit a client sending many requests. Neither `GET /healthz` nor `GET /v1/me` returns them from the API |
| `500` | The API could not get a Postgres connection within 5 seconds, the pool's `connectionTimeoutMillis`, because all `DB_POOL_MAX` connections were in use or the database was unreachable, or another unhandled error |
| `502` | nginx could not reach the API container or lost the connection to it |
| `503` | Neither the API nor the nginx config in this repository produces it |
| `499` | nginx records `499` in its access log when the client closes the connection before the response, and sends no response; a `499` that reaches k6 comes from another layer of the path |
| `504` | nginx waited longer than its default `proxy_read_timeout` of 60 seconds for the API; the nginx config does not change it |
| `520` to `526`, `530` | Cloudflare could not get a valid answer from the origin, for example `521` when the origin refused the connection, `522` when connecting to it timed out, `524` when it accepted the connection but did not answer in time, and `525` or `526` when the TLS handshake or the origin certificate failed |
| `other` | Any status not listed above |

For `s0c-auth.js` the report has the count, `p50`, `p95`, `p99` and maximum of `login_ok_duration` and `login_limited_duration`, followed by the request counts per status.

## Validity checks

A run measures the API only when all of these hold:

- `dropped` is `0` in every step. Otherwise k6 sent fewer requests than the target; raise `PRE_ALLOCATED_VUS` or `MAX_VUS`.
- `non_dynamic` is `0`. Otherwise some responses came from Cloudflare's cache, not from the API.
- `no_cf_header` is `0` against the public hostname. Otherwise some requests did not pass through the Cloudflare proxy. Against a local API it equals the number of requests.
- `s0a-app-tier.js` and `s0b-session.js` receive no `429` responses. Neither route is rate limited by the API, so a `429` comes from somewhere else in the path.

## Effects of `s0c-auth.js`

- It consumes the login rate limit for the client address. The API allows 30 login attempts per client address in a fixed 15-minute window aligned to the clock, so after the run, logins from that address, by anyone, get `429` for up to 15 minutes. The `Retry-After` header, and the `retryAfterSeconds` member of the body, give the seconds until the window ends. If the address already made login attempts in the current window, the first `429` arrives earlier than iteration 30; if a window ends during the run, it arrives later or not at all. Get the `SESSION_COOKIE` for `s0b-session.js` before running it.
- Behind the Cloudflare proxy, the client address is the visitor address from `CF-Connecting-IP`. IPv6 clients are limited per /64.
- Each `200` response is a real login: it creates a new 30-day session for the account and writes an `auth.login.succeeded` row to the append-only audit log. The run therefore leaves up to 30 live sessions. The script does not keep their cookies, and `POST /v1/auth/logout` ends only the session whose cookie it receives, so they stay valid until they expire. The first rejection for the client address in a window also writes one `auth.rate_limited` audit row.
- With a wrong password the responses are `401`, and after 10 failures the email is locked for the rest of its 15-minute window, so the remaining responses are `429`.

## Credentials

The JSON summaries and the printed report contain no credentials: the scripts send `SESSION_COOKIE`, `LOGIN_EMAIL` and `LOGIN_PASSWORD` only in request headers and bodies, and never put them in tags, logs or the summary. `SESSION_COOKIE` is a credential for its account for 30 days. After the run, end that session with `POST /v1/auth/logout` and the same cookie. Do not run the scripts with `--http-debug`, which prints request headers and bodies.
