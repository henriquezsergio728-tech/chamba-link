import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { clientKey, consume, peek, prune, reset, type Rule } from "../src/rate-limit.js";

config({ path: "../.env" });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 25 });
const db = drizzle({ client: pool });
const keys: string[] = [];

const newKey = () => {
  const key = `test:${randomBytes(8).toString("hex")}`;
  keys.push(key);
  return key;
};

// 2026-11-02 09:00:00 UTC is a multiple of 900 s, so it starts a 15-minute window.
const WINDOW_START = new Date("2026-11-02T09:00:00Z");
const at = (seconds: number) => new Date(WINDOW_START.getTime() + seconds * 1000);
const rule: Rule = { limit: 3, windowSeconds: 900 };

afterAll(async () => {
  await pool.query("DELETE FROM rate_limits WHERE key = ANY($1)", [keys]);
  await pool.end();
});

test("consume counts up, allows up to the limit and reports the window", async () => {
  const key = newKey();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await consume(db, key, rule, at(100)));
  expect(results.map((r) => [r.count, r.allowed])).toEqual([
    [1, true],
    [2, true],
    [3, true],
    [4, false],
    [5, false],
  ]);
  for (const r of results) {
    expect(r).toMatchObject({ limit: 3, retryAfterSeconds: 800 });
    expect(r.windowStart).toEqual(WINDOW_START);
  }
});

test.each([
  [0, 900],
  [899.2, 1],
  [899.999, 1],
  [450.5, 450],
])("retryAfterSeconds at %s s into the window is %s", async (offset, expected) => {
  const r = await consume(db, newKey(), rule, at(offset));
  expect(r.retryAfterSeconds).toBe(expected);
  expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  expect(r.retryAfterSeconds).toBeLessThanOrEqual(rule.windowSeconds);
});

test("the next window starts again at 1", async () => {
  const key = newKey();
  for (let i = 0; i < 4; i++) await consume(db, key, rule, at(899));
  const next = await consume(db, key, rule, at(900));
  expect(next).toMatchObject({ count: 1, allowed: true, windowStart: at(900) });
});

test("keys are independent", async () => {
  const a = newKey();
  const b = newKey();
  for (let i = 0; i < 4; i++) await consume(db, a, rule, at(10));
  expect(await consume(db, b, rule, at(10))).toMatchObject({ count: 1, allowed: true });
});

test("20 concurrent calls on one key with limit 5 allow exactly 5", async () => {
  const key = newKey();
  const results = await Promise.all(Array.from({ length: 20 }, () => consume(db, key, { limit: 5, windowSeconds: 900 }, at(10))));
  expect(results.filter((r) => r.allowed)).toHaveLength(5);
  expect(results.map((r) => r.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});

test("peek reads the count without incrementing it", async () => {
  const key = newKey();
  expect(await peek(db, key, rule, at(10))).toEqual({ count: 0, exceeded: false, retryAfterSeconds: 890 });
  await consume(db, key, rule, at(10));
  await consume(db, key, rule, at(10));
  expect(await peek(db, key, rule, at(10))).toMatchObject({ count: 2, exceeded: false });
  expect(await peek(db, key, rule, at(10))).toMatchObject({ count: 2 });
  await consume(db, key, rule, at(10));
  expect(await peek(db, key, rule, at(10))).toMatchObject({ count: 3, exceeded: true });
  expect(await peek(db, key, rule, at(900))).toMatchObject({ count: 0, exceeded: false });
});

test("reset clears the current window", async () => {
  const key = newKey();
  for (let i = 0; i < 4; i++) await consume(db, key, rule, at(10));
  await reset(db, key, rule, at(20));
  expect(await peek(db, key, rule, at(20))).toMatchObject({ count: 0 });
  expect(await consume(db, key, rule, at(20))).toMatchObject({ count: 1, allowed: true });
});

test("prune removes windows older than 24 hours and keeps newer ones", async () => {
  const now = new Date();
  const old = newKey();
  const recent = newKey();
  const hour = 3_600_000;
  await pool.query("INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1), ($3, $4, 1)", [
    old,
    new Date(now.getTime() - 25 * hour),
    recent,
    new Date(now.getTime() - 23 * hour),
  ]);
  await prune(db, now);
  const { rows } = await pool.query("SELECT key FROM rate_limits WHERE key = ANY($1)", [[old, recent]]);
  expect(rows.map((r) => r.key)).toEqual([recent]);
});

test("clientKey keeps IPv4 and keys IPv4-mapped IPv6 as IPv4", () => {
  expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
  expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  expect(clientKey("::FFFF:CB00:7107")).toBe("203.0.113.7");
  expect(clientKey("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
});

test("clientKey keys IPv6 by its /64", () => {
  expect(clientKey("2001:db8:0:1::1")).toBe("2001:db8:0:1/64");
  expect(clientKey("2001:DB8:0:1:ffff:aaaa:bbbb:cccc")).toBe("2001:db8:0:1/64");
  expect(clientKey("2001:0db8:0000:0001:0000:0000:0000:0002")).toBe("2001:db8:0:1/64");
  expect(clientKey("2001:db8:0:2::1")).toBe("2001:db8:0:2/64");
  expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0/64");
  expect(clientKey("2001:db8::1:0:0:1")).toBe("2001:db8:0:0/64");
  expect(clientKey("::1")).toBe("0:0:0:0/64");
  expect(clientKey("::")).toBe("0:0:0:0/64");
  expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0/64");
});

test.each(["garbage", "", "1.2.3", "2001:db8:::1", "203.0.113.7:3000"])("clientKey returns %j unchanged", (value) => {
  expect(clientKey(value)).toBe(value);
});
