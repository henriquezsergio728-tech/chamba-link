import { createHash, randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import { and, eq, gt, lte } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Queryable } from "../audit.js";
import { accountCredentials, accounts, sessions } from "../db/schema.js";
import { AppError } from "../errors.js";

export type Account = { id: string; role: "provider" | "client"; displayName: string; email: string };

declare module "fastify" {
  interface FastifyRequest {
    account: Account | null;
  }
}

export const SESSION_COOKIE = "session";
// Absolute lifetime: a session is never extended.
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function cookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, path: "/", secure: process.env.NODE_ENV === "production" };
}

// Stores a new session for the account and sets its cookie. Only the SHA-256 of the token reaches the database.
export async function startSession(db: Queryable, reply: FastifyReply, accountId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    accountId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
  reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_SECONDS });
}

export async function deleteExpiredSessions(db: Queryable, accountId: string) {
  await db.delete(sessions).where(and(eq(sessions.accountId, accountId), lte(sessions.expiresAt, new Date())));
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, cookieOptions());
}

// Unsigned cookies: the value is a random token whose hash is looked up, so a signature would add nothing.
export const authPlugin = fp(
  async (app) => {
    await app.register(cookie);
    app.decorateRequest("account", null);
  },
  { name: "auth", fastify: "5.x" },
);

// preHandler that loads the account for a live session cookie, or rejects the request with 401.
export async function requireAccount(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (token) {
    const [row] = await request.server.db
      .select({ id: accounts.id, role: accounts.role, displayName: accounts.displayName, email: accountCredentials.email })
      .from(sessions)
      .innerJoin(accounts, eq(accounts.id, sessions.accountId))
      .innerJoin(accountCredentials, eq(accountCredentials.accountId, sessions.accountId))
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
    if (row) {
      request.account = row;
      return;
    }
  }
  throw new AppError({ status: 401, code: "UNAUTHENTICATED", title: "Unauthorized", detail: "A valid session is required" });
}
