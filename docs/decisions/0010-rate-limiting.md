# 0010. Rate limiting in Postgres

## Context

`POST /v1/auth/login` and `POST /v1/auth/register` run one Argon2 computation per request ([ADR 0009](0009-accounts-and-sessions.md)), so unthrottled requests allow online password guessing against an account and let one client spend the server's CPU and memory. The limiter needs a store that every API process shares and that survives a restart. The API already depends on Postgres and the repository adds no new dependency for this, so the store is a table there.

## Decision

**Store.** The table `rate_limits` holds one counter per key and window, with primary key `(key, window_start)` ([Data model](../data-model.md#rate_limits)). [`api/src/rate-limit.ts`](../../api/src/rate-limit.ts) counts a hit with one statement:

```sql
INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
RETURNING count
```

Concurrent requests on one key each receive a distinct count, so exactly `limit` of them are allowed.

**Fixed windows.** A window starts at `floor(now / window) * window`, aligned to the Unix epoch. A client can send up to the limit at the end of one window and up to the limit again at the start of the next, so up to twice the limit can pass within a short span across a boundary. `retryAfterSeconds` is the time until the current window ends, at least 1.

**Clock.** Window boundaries and `Retry-After` are computed from the application clock and passed to Postgres as parameters; Postgres `now()` is not used.

**Rules.**

| Rule | Key | Limit | Window | Counts |
| --- | --- | --- | --- | --- |
| `LOGIN_IP` | `login:ip:<client>` | 30 | 15 minutes | Every login request that passes schema validation |
| `LOGIN_EMAIL` | `login:email:<sha256 of the lowercased email>` | 10 | 15 minutes | Failed logins: wrong password or unknown email |
| `REGISTER_IP` | `register:ip:<client>` | 10 | 1 hour | Every registration request that passes schema validation, including ones answered `409` |

Requests rejected by schema validation (`400`) are not counted, because the handler does not run. Keys never contain a raw email.

**Order in a login.** The handler consumes `LOGIN_IP` first. It then reads the `LOGIN_EMAIL` count without incrementing it and answers `429` if it has reached 10, before any password work. After a failed verification it increments `LOGIN_EMAIL`. A successful login deletes that email's current bucket. Registration consumes `REGISTER_IP` before hashing the password.

**Shared addresses.** Many clients can share one public IPv4 address behind carrier-grade NAT or an office gateway. The per-address limits are therefore set above the per-email limit and bound the work one address can cause. They do not stop guessing against one account, which the per-email bucket does.

**IPv6.** An IPv6 client is keyed by its /64, for example `2001:db8:0:1/64`, because a single host usually controls a whole /64 and can rotate addresses inside it. An IPv4-mapped IPv6 address is keyed as the IPv4 address.

**Per-email lockout.** The email bucket counts failures for unknown emails as well, so a `429` does not reveal whether an account exists. Anyone who sends 10 wrong passwords for an email blocks logins for it until the window ends, including with the right password. A successful login resets the bucket, so a user's own earlier typos do not carry over after they sign in.

**Response.** A rejected request receives `429` problem details with code `RATE_LIMITED`, detail `Too many attempts. Try again later.`, the extension `retryAfterSeconds`, and a `Retry-After` header with the same number of seconds.

**Audit.** The event `auth.rate_limited`, with metadata `{"scope": "login-ip" | "login-email" | "register-ip"}`, is written once per key per window: when a consume returns `limit + 1` for an address rule, and when the failure that reaches 10 is counted for an email. Later rejections write nothing. Audit rows cannot be deleted ([ADR 0009](0009-accounts-and-sessions.md)), so a row per rejection would let a client grow the table without bound.

**Fail open.** If a limiter call throws, the error is logged as `rate limiter failed` through `describeError` ([ADR 0008](0008-api-conventions.md)) and the request continues as if it were allowed. An unavailable or broken `rate_limits` table must not stop users from registering or signing in, so a limiter failure costs protection instead of availability.

**Pruning.** Each request to the account and session routes, with probability 0.01, deletes rows whose `window_start` is more than 24 hours old. The deletion runs without being awaited; an error is logged and does not affect the response.

## Consequences

- A registration runs one limiter query and a login three: the address consume, the email read, and either the failure consume or the reset.
- Up to twice a rule's limit can pass across a window boundary.
- Clients behind one shared IPv4 address share the address limits.
- An attacker who knows an email can keep that account from signing in by sending 10 wrong passwords per 15 minutes.
- The email check and the failure count are separate statements, so concurrent failed logins for one email can pass the check together and run more than 10 verifications in a window. The address limit still applies to each of them.
- After a successful login resets an email's bucket, the bucket can reach the limit again in the same window and write a second `auth.rate_limited` row.
- If the limiter's queries fail, the endpoints run without rate limits until they succeed again, and each failure is logged.
- Expired rows remain until a sampled request prunes them.
- API processes with skewed clocks compute different window boundaries for the same key.
