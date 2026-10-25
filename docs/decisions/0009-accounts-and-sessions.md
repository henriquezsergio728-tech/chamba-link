# 0009. Accounts, password hashing, cookie sessions and audit log

## Context

The `accounts` table held a role and a display name but no way to sign in. Providers and clients need to register, sign in from a browser and stay signed in, and the API needs a record of sign-in activity that the application cannot rewrite. Node 24 ships Argon2 in `node:crypto` (`crypto.argon2`, since v24.7.0), in both the local toolchain and the `node:24-slim` image, so password hashing needs no native dependency.

## Decision

**Identity.** An account signs in with an email and a password. Emails are not verified. The email is lowercased by the API before it is stored or looked up, and `account_credentials` enforces that with a `CHECK (email = lower(email) AND char_length(email) <= 254)` and a `UNIQUE` constraint. The registration schema accepts an email of printable ASCII only, up to 254 characters: a local part and a domain of characters from `\x21` to `\x7e` other than `@`, separated by exactly one `@`, with a dot in the domain. Restricting emails to ASCII keeps JavaScript's `toLowerCase()` and Postgres `lower()` in agreement. The login schema checks only the length, so a login with any other email is answered `401 INVALID_CREDENTIALS`. Passwords are 10 to 128 characters, with no composition rules and no Unicode normalization.

**Separate credentials table.** The email and password hash live in `account_credentials`, keyed by `account_id`, not in `accounts`. A query that reads `accounts`, such as a join from `bookings`, cannot select a password hash by accident, and `accounts` is unchanged. Deleting an account cascades to its credentials and sessions.

**Password hashing.** `api/src/auth/password.ts` hashes with `crypto.argon2` (asynchronous, on the libuv thread pool):

| Parameter | Value |
| --- | --- |
| Algorithm | `argon2id`, version 19 |
| Memory | 19456 KiB (19 MiB) |
| Passes | 2 |
| Parallelism | 1 |
| Salt | 16 random bytes |
| Tag | 32 bytes |

The hash is stored as a PHC string, `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`, with salt and hash in base64 without padding. Verification reads the parameters from the stored string, recomputes the tag and compares it with `crypto.timingSafeEqual`, so a stored hash keeps verifying after the parameters change. A malformed stored string verifies as `false` instead of throwing.

**Sessions.** A session token is 32 random bytes, base64url-encoded, sent as the cookie `session`. The `sessions` table stores only the hex SHA-256 of the token in `token_hash`, so a copy of the table does not yield usable cookies. The cookie is unsigned, because its value is an unguessable random token looked up by hash, not a payload. A session lasts 30 days from creation and is never extended. The cookie has `HttpOnly`, `SameSite=Lax`, `Path=/` and `Max-Age=2592000`, and `Secure` when `NODE_ENV` is `production`, which the image sets. It has no `Domain` attribute, so the browser sends it only to the host that set it. Login deletes the account's expired sessions. Logout deletes the session row and clears the cookie, and answers `204` whether or not the cookie names a live session.

**CSRF.** `SameSite=Lax` is the CSRF defence: browsers do not send the cookie on cross-site `POST` requests or cross-site subresource requests, only on top-level navigations, which use `GET`. `GET` routes therefore do not change state. SameSite compares registrable domains, not origins, so a page on another subdomain of `chambalink.online` is same-site and its requests carry the cookie.

**Enumeration.** `POST /v1/auth/login` answers a wrong password and an unknown email identically: `401`, code `INVALID_CREDENTIALS`, detail `Invalid email or password`. For an unknown email it verifies the password against a dummy hash computed once per process, so both cases perform one Argon2 verification. `POST /v1/auth/register` answers a taken email with `409 EMAIL_TAKEN`, so registration reveals whether an email has an account.

**Audit log.** `audit_log` records `account.registered`, `auth.login.succeeded`, `auth.login.failed` and `auth.logout` with the time, the actor's account id, `request.ip` and the request id. `actor_account_id` has no foreign key, so rows outlive the account they name. A failed login records no actor and stores `{"emailSha256": ...}`, the SHA-256 of the lowercased email, instead of the email. Rows never hold passwords or tokens. A `BEFORE UPDATE OR DELETE` row trigger, `audit_log_append_only`, raises an exception, so the table is append-only for every writer that does not alter the trigger.

## Consequences

- Anyone can register with an email address they do not control.
- The database holds hashes of passwords and session tokens, never the values.
- Every registration and login request that passes schema validation, including a login for an unknown email, runs one Argon2 computation with 19 MiB of memory.
- These endpoints have no rate limit.
- A stolen cookie is valid until its session expires or is logged out. Other sessions of the same account stay valid after a logout.
- A request from a sibling subdomain of `chambalink.online` is not blocked by `SameSite=Lax`.
- `emailSha256` is unsalted, so anyone with read access to `audit_log` can confirm a guessed email.
- The trigger stops `UPDATE` and `DELETE` but not the table's owner. The API and the migrator both connect as `POSTGRES_USER` (`compose.prod.yaml`), which created and owns the table and can drop or disable the trigger or `TRUNCATE` the table, which row triggers do not fire on.
- The trigger exists only in the custom migration SQL, not in `schema.ts` or the drizzle-kit snapshots.
