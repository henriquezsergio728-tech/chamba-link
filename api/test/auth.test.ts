import { createHash, randomBytes, randomInt } from "node:crypto";
import { config } from "dotenv";
import { DrizzleQueryError } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { dbPlugin } from "../src/db.js";

config({ path: "../.env" });

// While limiterStore.broken is set, every rate-limiter call fails as it would if the rate_limits table were missing.
const limiterStore = vi.hoisted(() => ({ broken: false }));
vi.mock("../src/rate-limit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rate-limit.js")>();
  const fail = () =>
    Promise.reject(new DrizzleQueryError('select "count" from "rate_limits"', [], Object.assign(new Error('relation "rate_limits" does not exist'), { code: "42P01" })));
  const breakable =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A) =>
      limiterStore.broken ? (fail() as Promise<R>) : fn(...args);
  return { ...actual, consume: breakable(actual.consume), peek: breakable(actual.peek), reset: breakable(actual.reset), prune: breakable(actual.prune) };
});

// Counts password verifications, so a test can show that a request did no password work.
const verifications = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/auth/password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/password.js")>();
  return {
    ...actual,
    verifyPassword: (...args: Parameters<typeof actual.verifyPassword>) => {
      verifications.count++;
      return actual.verifyPassword(...args);
    },
  };
});

const PASSWORD = "correct horse battery";
const accountIds: string[] = [];

function makeApp() {
  const app = buildApp();
  app.register(dbPlugin, { connectionString: process.env.DATABASE_URL! });
  return app;
}

const app = makeApp();

beforeAll(async () => {
  await app.ready();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const usedEmails = new Set<string>();
const usedIps = new Set<string>();

// Audit rows cannot be deleted; accounts cascade to their credentials and sessions. Rate-limit rows are deleted by key.
afterAll(async () => {
  await app.pg.query("DELETE FROM accounts WHERE id = ANY($1)", [accountIds]);
  const keys = [...usedIps].flatMap((ip) => [`login:ip:${ip}`, `register:ip:${ip}`]);
  for (const email of usedEmails) keys.push(`login:email:${sha256(email)}`);
  await app.pg.query("DELETE FROM rate_limits WHERE key = ANY($1)", [keys]);
  await app.close();
});

const remember = <T extends string>(set: Set<string>, value: T) => (set.add(value), value);
const randomEmail = () => remember(usedEmails, `user-${randomBytes(6).toString("hex")}@example.test`);
// A public address per test, so that request.ip and the audit rows it writes belong to this test only.
const randomIp = () => remember(usedIps, `198.18.${randomInt(256)}.${randomInt(1, 255)}`);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type Client = { ip: string; cookie?: string };

function client(): Client {
  return { ip: randomIp() };
}

async function call(c: Client, method: "GET" | "POST", url: string, payload?: object, target = app) {
  const res = await target.inject({ method, url, payload, remoteAddress: c.ip, headers: c.cookie ? { cookie: c.cookie } : {} });
  const session = res.cookies.find((cookie) => cookie.name === "session");
  if (session) c.cookie = session.value ? `session=${session.value}` : undefined;
  return res;
}

async function register(c: Client, overrides: Record<string, unknown> = {}, target = app) {
  const res = await call(c, "POST", "/v1/auth/register", { email: randomEmail(), password: PASSWORD, displayName: "Ana", role: "provider", ...overrides }, target);
  if (res.statusCode === 201) accountIds.push(res.json().account.id);
  return res;
}

const token = (c: Client) => c.cookie!.slice("session=".length);

test("register, me, logout and me again", async () => {
  const c = client();
  const email = randomEmail();
  const reg = await register(c, { email, displayName: "Ana López", role: "client" });
  expect(reg.statusCode).toBe(201);
  const account = reg.json().account;
  expect(account).toEqual({ id: expect.any(String), role: "client", displayName: "Ana López", email });
  expect(c.cookie).toBeDefined();

  const me = await call(c, "GET", "/v1/me");
  expect(me.statusCode).toBe(200);
  expect(me.json()).toEqual({ account });

  const out = await call(c, "POST", "/v1/auth/logout");
  expect(out.statusCode).toBe(204);
  expect(out.body).toBe("");
  expect(c.cookie).toBeUndefined();
});

test("login with the registered password starts a new session", async () => {
  const c = client();
  const email = randomEmail();
  const account = (await register(c, { email })).json().account;
  const fresh = client();
  const login = await call(fresh, "POST", "/v1/auth/login", { email: email.toUpperCase(), password: PASSWORD });
  expect(login.statusCode).toBe(200);
  expect(login.json()).toEqual({ account });
  expect(fresh.cookie).not.toBe(c.cookie);
  expect((await call(fresh, "GET", "/v1/me")).json()).toEqual({ account });
});

test("the email is stored lowercased", async () => {
  const c = client();
  const email = randomEmail();
  const res = await register(c, { email: email.replace("user", "USER") });
  expect(res.json().account.email).toBe(email);
});

test("the session cookie is HttpOnly, SameSite=Lax, Path=/ and lasts 30 days, without Secure outside production", async () => {
  const c = client();
  const res = await register(c);
  const cookie = res.cookies.find((x) => x.name === "session")!;
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/", maxAge: 2592000 });
  expect(cookie.secure).toBeUndefined();
  expect(token(c)).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("the session cookie is Secure when NODE_ENV is production", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const prod = makeApp();
  prod.log.level = "silent";
  try {
    const c = client();
    const res = await register(c, {}, prod);
    expect(res.statusCode).toBe(201);
    expect(res.cookies.find((x) => x.name === "session")).toMatchObject({ secure: true, httpOnly: true });
    expect(res.headers["set-cookie"]).toMatch(/; Secure/);
  } finally {
    await prod.close();
  }
});

test("the database holds the SHA-256 of the token and a hash that does not contain the password", async () => {
  const c = client();
  const account = (await register(c)).json().account;
  const sessions = await app.pg.query("SELECT token_hash, expires_at FROM sessions WHERE account_id = $1", [account.id]);
  expect(sessions.rows).toHaveLength(1);
  expect(sessions.rows[0].token_hash).toBe(sha256(token(c)));
  expect(sessions.rows[0].token_hash).not.toContain(token(c));
  const days = (sessions.rows[0].expires_at.getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(29.99);
  expect(days).toBeLessThanOrEqual(30);

  const creds = await app.pg.query("SELECT password_hash FROM account_credentials WHERE account_id = $1", [account.id]);
  expect(creds.rows[0].password_hash).not.toBe(PASSWORD);
  expect(creds.rows[0].password_hash).not.toContain(PASSWORD);
  expect(creds.rows[0].password_hash).toMatch(/^\$argon2id\$/);
});

test("a wrong password and an unknown email get the same response", async () => {
  const email = randomEmail();
  await register(client(), { email });
  const wrong = await call(client(), "POST", "/v1/auth/login", { email, password: "not the password" });
  const unknown = await call(client(), "POST", "/v1/auth/login", { email: randomEmail(), password: PASSWORD });
  for (const res of [wrong, unknown]) {
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
    expect(res.headers["set-cookie"]).toBeUndefined();
  }
  const strip = (body: Record<string, unknown>) => ({ ...body, requestId: undefined });
  expect(strip(wrong.json())).toEqual(strip(unknown.json()));
  expect(wrong.json()).toMatchObject({ status: 401, code: "INVALID_CREDENTIALS", detail: "Invalid email or password" });
});

test("registering a taken email, in any case, is 409 EMAIL_TAKEN", async () => {
  const email = randomEmail();
  expect((await register(client(), { email })).statusCode).toBe(201);
  const again = await register(client(), { email: email.toUpperCase() });
  expect(again.statusCode).toBe(409);
  expect(again.json()).toMatchObject({ status: 409, code: "EMAIL_TAKEN" });
  expect(again.headers["set-cookie"]).toBeUndefined();
});

test("a failed registration leaves no account behind", async () => {
  const email = randomEmail();
  await register(client(), { email });
  const before = await app.pg.query("SELECT count(*)::int AS n FROM accounts WHERE display_name = $1", [email]);
  await register(client(), { email, displayName: email });
  const after = await app.pg.query("SELECT count(*)::int AS n FROM accounts WHERE display_name = $1", [email]);
  expect(after.rows[0].n).toBe(before.rows[0].n);
});

test("an expired session is rejected", async () => {
  const c = client();
  await register(c);
  await app.pg.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [sha256(token(c))]);
  const me = await call(c, "GET", "/v1/me");
  expect(me.statusCode).toBe(401);
  expect(me.json()).toMatchObject({ code: "UNAUTHENTICATED" });
});

test("login deletes the account's expired sessions", async () => {
  const c = client();
  const email = randomEmail();
  const account = (await register(c, { email })).json().account;
  await app.pg.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE account_id = $1", [account.id]);
  await call(client(), "POST", "/v1/auth/login", { email, password: PASSWORD });
  const { rows } = await app.pg.query("SELECT token_hash FROM sessions WHERE account_id = $1", [account.id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].token_hash).not.toBe(sha256(token(c)));
});

test("after logout the session row is gone and the old cookie is rejected", async () => {
  const c = client();
  await register(c);
  const old = c.cookie!;
  await call(c, "POST", "/v1/auth/logout");
  const { rows } = await app.pg.query("SELECT 1 FROM sessions WHERE token_hash = $1", [sha256(old.slice("session=".length))]);
  expect(rows).toHaveLength(0);
  const me = await call({ ip: c.ip, cookie: old }, "GET", "/v1/me");
  expect(me.statusCode).toBe(401);
});

test("logout is 204 without a cookie and with an unknown one, and clears the cookie", async () => {
  for (const c of [client(), { ip: randomIp(), cookie: "session=not-a-session" }]) {
    const res = await call(c, "POST", "/v1/auth/logout");
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((x) => x.name === "session")).toMatchObject({ value: "", path: "/" });
  }
});

test("me without a cookie is 401 UNAUTHENTICATED", async () => {
  const res = await call(client(), "GET", "/v1/me");
  expect(res.statusCode).toBe(401);
  expect(res.json()).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
});

test.each([
  ["a short password", { password: "123456789" }, "body/password"],
  ["a long password", { password: "x".repeat(129) }, "body/password"],
  ["an email without @", { email: "nobody.example.test" }, "body/email"],
  ["an email with a space", { email: "no body@example.test" }, "body/email"],
  ["an email without a dot in the domain", { email: "nobody@localhost" }, "body/email"],
  ["an email with two @", { email: "a@b@example.test" }, "body/email"],
  ["an email over 254 characters", { email: `${"a".repeat(250)}@x.io` }, "body/email"],
  ["an email with a non-ASCII local part", { email: "ÁNA@example.test" }, "body/email"],
  ["an email with a non-ASCII domain", { email: "ana@exámple.test" }, "body/email"],
  ["an email with a dotted capital I", { email: "İ@example.test" }, "body/email"],
  ["an email with a tab", { email: "a\tb@example.test" }, "body/email"],
  ["an empty display name", { displayName: "" }, "body/displayName"],
  ["a display name over 80 characters", { displayName: "a".repeat(81) }, "body/displayName"],
  ["an unknown role", { role: "admin" }, "body/role"],
])("register rejects %s with a 400 problem", async (_, overrides, path) => {
  const res = await register(client(), overrides);
  expect(res.statusCode).toBe(400);
  expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
  const body = res.json();
  expect(body).toMatchObject({ status: 400, title: "Bad Request" });
  expect(body.errors.map((e: { path: string }) => e.path)).toContain(path);
});

test("auth responses, including errors, carry Cache-Control: no-store", async () => {
  const c = client();
  const email = randomEmail();
  const responses = [
    await register(c, { email }),
    await register(client(), { email }),
    await register(client(), { role: "admin" }),
    await call(c, "GET", "/v1/me"),
    await call(client(), "GET", "/v1/me"),
    await call(client(), "POST", "/v1/auth/login", { email, password: PASSWORD }),
    await call(client(), "POST", "/v1/auth/login", { email, password: "wrong password" }),
    await call(c, "POST", "/v1/auth/logout"),
  ];
  expect(responses.map((r) => r.statusCode)).toEqual([201, 409, 400, 200, 401, 200, 401, 204]);
  for (const res of responses) expect(res.headers["cache-control"]).toBe("no-store");
});

// Audit rows for one test are selected by its client address.
async function auditRows(ip: string) {
  const { rows } = await app.pg.query("SELECT id, event, actor_account_id, ip, request_id, metadata FROM audit_log WHERE ip = $1 ORDER BY id", [ip]);
  return rows;
}

test("the flow writes audit events with the right actor, and none holds the password or token", async () => {
  const c = client();
  const email = randomEmail();
  const unknownEmail = randomEmail();
  const reg = await register(c, { email, role: "client" });
  const id = reg.json().account.id;
  const firstToken = token(c);
  await call(c, "POST", "/v1/auth/login", { email, password: "wrong password" });
  await call(c, "POST", "/v1/auth/login", { email: unknownEmail, password: PASSWORD });
  await call(c, "POST", "/v1/auth/login", { email, password: PASSWORD });
  await call(c, "POST", "/v1/auth/logout");

  const rows = await auditRows(c.ip);
  expect(rows.map((r) => [r.event, r.actor_account_id])).toEqual([
    ["account.registered", id],
    ["auth.login.failed", null],
    ["auth.login.failed", null],
    ["auth.login.succeeded", id],
    ["auth.logout", id],
  ]);
  expect(rows[0].request_id).toBe(reg.headers["x-request-id"]);
  expect(rows[0].metadata).toEqual({ role: "client" });
  expect(rows[1].metadata).toEqual({ emailSha256: sha256(email) });
  expect(rows[2].metadata).toEqual({ emailSha256: sha256(unknownEmail) });

  const serialized = JSON.stringify(rows);
  for (const secret of [PASSWORD, "wrong password", firstToken, unknownEmail]) expect(serialized).not.toContain(secret);
});

test("audit_log rejects UPDATE and DELETE", async () => {
  const c = client();
  await register(c);
  const [row] = await auditRows(c.ip);
  await expect(app.pg.query("UPDATE audit_log SET event = 'tampered' WHERE id = $1", [row.id])).rejects.toThrow(/append-only/);
  await expect(app.pg.query("DELETE FROM audit_log WHERE id = $1", [row.id])).rejects.toThrow(/append-only/);
  expect((await auditRows(c.ip))[0]).toEqual(row);
});

const login = (c: Client, email: string, password: string) => call(c, "POST", "/v1/auth/login", { email, password });

async function rateLimitedRows(ips: string[]) {
  const { rows } = await app.pg.query("SELECT ip, metadata FROM audit_log WHERE event = 'auth.rate_limited' AND ip = ANY($1) ORDER BY id", [ips]);
  return rows;
}

function expectRateLimited(res: Awaited<ReturnType<typeof call>>, url: string) {
  expect(res.statusCode).toBe(429);
  expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
  expect(res.headers["cache-control"]).toBe("no-store");
  const body = res.json();
  expect(body).toEqual({
    type: "about:blank",
    title: "Too Many Requests",
    status: 429,
    detail: "Too many attempts. Try again later.",
    instance: url,
    requestId: res.headers["x-request-id"],
    code: "RATE_LIMITED",
    retryAfterSeconds: expect.any(Number),
  });
  expect(res.headers["retry-after"]).toBe(String(body.retryAfterSeconds));
  expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
}

test("the 31st login attempt from one address in the window is 429, audited once", async () => {
  const c = client();
  const attempts = await Promise.all(Array.from({ length: 30 }, () => login(c, randomEmail(), PASSWORD)));
  expect(attempts.map((r) => r.statusCode)).toEqual(Array(30).fill(401));

  const rejected = await login(c, randomEmail(), PASSWORD);
  expectRateLimited(rejected, "/v1/auth/login");
  expect(rejected.json().retryAfterSeconds).toBeLessThanOrEqual(900);
  for (let i = 0; i < 3; i++) expect((await login(c, randomEmail(), PASSWORD)).statusCode).toBe(429);

  const rows = await rateLimitedRows([c.ip]);
  expect(rows).toEqual([{ ip: c.ip, metadata: { scope: "login-ip" } }]);
});

test("after 10 failed logins for one email, the next attempt is 429 even with the right password and runs no password work", async () => {
  const email = randomEmail();
  await register(client(), { email });
  const failers = Array.from({ length: 10 }, () => client());
  for (const c of failers) expect((await login(c, email, "wrong password")).statusCode).toBe(401);

  const late = Array.from({ length: 3 }, () => client());
  for (const c of late) {
    const before = verifications.count;
    expectRateLimited(await login(c, email, PASSWORD), "/v1/auth/login");
    expect(verifications.count).toBe(before);
  }
  expect(late.every((c) => c.cookie === undefined)).toBe(true);

  // A login that reached password verification writes auth.login.failed or auth.login.succeeded; these wrote neither.
  const { rows } = await app.pg.query("SELECT event FROM audit_log WHERE ip = ANY($1)", [late.map((c) => c.ip)]);
  expect(rows).toEqual([]);

  // The 10th failure wrote the only auth.rate_limited row, without the email or its hash.
  const limited = await rateLimitedRows([...failers, ...late].map((c) => c.ip));
  expect(limited).toEqual([{ ip: failers[9]!.ip, metadata: { scope: "login-email" } }]);
  expect(JSON.stringify(limited)).not.toContain(email);
  expect(JSON.stringify(limited)).not.toContain(sha256(email));
});

test("a successful login resets the email's failure count", async () => {
  const c = client();
  const email = randomEmail();
  await register(client(), { email });
  for (let i = 0; i < 9; i++) await login(c, email, "wrong password");
  expect((await login(c, email, PASSWORD)).statusCode).toBe(200);
  const { rows } = await app.pg.query("SELECT 1 FROM rate_limits WHERE key = $1", [`login:email:${sha256(email)}`]);
  expect(rows).toEqual([]);
  for (let i = 0; i < 9; i++) expect((await login(c, email, "wrong password")).statusCode).toBe(401);
  expect((await login(c, email, PASSWORD)).statusCode).toBe(200);
});

test("a locked email does not block another email from the same address", async () => {
  const c = client();
  const locked = randomEmail();
  const other = randomEmail();
  await register(client(), { email: locked });
  await register(client(), { email: other });
  for (let i = 0; i < 10; i++) await login(c, locked, "wrong password");
  expect((await login(c, locked, PASSWORD)).statusCode).toBe(429);
  expect((await login(c, other, PASSWORD)).statusCode).toBe(200);
});

test("the 11th registration from one address in the window is 429, audited once", async () => {
  const c = client();
  const ok = await Promise.all(Array.from({ length: 10 }, () => register({ ip: c.ip })));
  expect(ok.map((r) => r.statusCode)).toEqual(Array(10).fill(201));
  for (let i = 0; i < 4; i++) {
    const res = await register({ ip: c.ip });
    expectRateLimited(res, "/v1/auth/register");
    expect(res.json().retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(res.headers["set-cookie"]).toBeUndefined();
  }
  expect(await rateLimitedRows([c.ip])).toEqual([{ ip: c.ip, metadata: { scope: "register-ip" } }]);
});

test("requests rejected by schema validation are not counted", async () => {
  const ip = randomIp();
  for (let i = 0; i < 12; i++) expect((await register({ ip }, { role: "admin" })).statusCode).toBe(400);
  for (let i = 0; i < 31; i++) expect((await call({ ip }, "POST", "/v1/auth/login", { email: randomEmail() })).statusCode).toBe(400);
  expect((await register({ ip })).statusCode).toBe(201);
  const { rows } = await app.pg.query("SELECT key, count FROM rate_limits WHERE key = ANY($1) ORDER BY key", [[`login:ip:${ip}`, `register:ip:${ip}`]]);
  expect(rows).toEqual([{ key: `register:ip:${ip}`, count: 1 }]);
});

test("IPv6 clients in one /64 share a bucket", async () => {
  const prefix = `2001:db8:${randomInt(0x10000).toString(16)}:${randomInt(0x10000).toString(16)}`;
  usedIps.add(`${prefix}/64`);
  for (let i = 1; i <= 10; i++) expect((await register({ ip: `${prefix}::${i.toString(16)}` })).statusCode).toBe(201);
  expect((await register({ ip: `${prefix}:ffff:1:2:3` })).statusCode).toBe(429);
});

test("when the limiter store fails, register, login and logout behave as without a limiter", async () => {
  limiterStore.broken = true;
  try {
    const c = client();
    const email = randomEmail();
    const reg = await register(c, { email });
    expect(reg.statusCode).toBe(201);
    expect((await login(client(), email, "wrong password")).statusCode).toBe(401);
    const ok = await login(c, email, PASSWORD);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(reg.json());
    expect((await call(c, "GET", "/v1/me")).statusCode).toBe(200);
    expect((await call(c, "POST", "/v1/auth/logout")).statusCode).toBe(204);
    expect((await register(client(), { email })).statusCode).toBe(409);
  } finally {
    limiterStore.broken = false;
  }
});
