import { isIP } from "node:net";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Queryable } from "./audit.js";
import { rateLimits } from "./db/schema.js";

export type Rule = { limit: number; windowSeconds: number };

export const RATE_LIMITS = {
  LOGIN_IP: { limit: 30, windowSeconds: 900 },
  LOGIN_EMAIL: { limit: 10, windowSeconds: 900 },
  REGISTER_IP: { limit: 10, windowSeconds: 3600 },
} as const satisfies Record<string, Rule>;

const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

// Fixed windows aligned to the epoch. Times come from the application clock, never from Postgres now().
function window(rule: Rule, now: Date) {
  const ms = rule.windowSeconds * 1000;
  const start = Math.floor(now.getTime() / ms) * ms;
  return { windowStart: new Date(start), retryAfterSeconds: Math.max(1, Math.ceil((start + ms - now.getTime()) / 1000)) };
}

// Counts one hit in the current window with a single upsert, so concurrent callers each get a distinct count.
export async function consume(db: Queryable, key: string, rule: Rule, now = new Date()) {
  const { windowStart, retryAfterSeconds } = window(rule, now);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  const count = row!.count;
  return { count, limit: rule.limit, allowed: count <= rule.limit, retryAfterSeconds, windowStart };
}

// Reads the current window's count without counting a hit.
export async function peek(db: Queryable, key: string, rule: Rule, now = new Date()) {
  const { windowStart, retryAfterSeconds } = window(rule, now);
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart)));
  const count = row?.count ?? 0;
  return { count, exceeded: count >= rule.limit, retryAfterSeconds };
}

export async function reset(db: Queryable, key: string, rule: Rule, now = new Date()) {
  const { windowStart } = window(rule, now);
  await db.delete(rateLimits).where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart)));
}

export async function prune(db: Queryable, now = new Date()) {
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, new Date(now.getTime() - PRUNE_AFTER_MS)));
}

// Expands an IPv6 address, including :: and an embedded IPv4 tail, into its eight 16-bit groups.
function ipv6Groups(ip: string) {
  let s = ip.split("%")[0]!.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.map((g) => parseInt(g, 16));
}

// The rate-limit identity of a client address. IPv6 hosts usually get a whole /64, so IPv6 is keyed by its first
// four groups, e.g. "2001:db8:0:1/64". An IPv4-mapped IPv6 address is keyed as the IPv4 address.
export function clientKey(ip: string) {
  if (isIP(ip) !== 6) return ip;
  const g = ipv6Groups(ip);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}/64`;
}
