import { createHash } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { eq } from "drizzle-orm";
import { Type } from "typebox";
import { audit } from "../audit.js";
import { accountCredentials, accounts, sessions } from "../db/schema.js";
import { AppError } from "../errors.js";
import { dummyHash, hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from "./password.js";
import { type Account, clearSessionCookie, deleteExpiredSessions, hashToken, requireAccount, SESSION_COOKIE, startSession } from "./session.js";

// Printable ASCII without space or @ (\x21-\x3f, \x41-\x7e) on each side of exactly one @, and a dot in the domain.
// ASCII only, so that lowercasing in JavaScript and lower() in Postgres agree. Deliverability is not checked.
const EMAIL_CHAR = "[\\x21-\\x3f\\x41-\\x7e]";
const Email = Type.String({ maxLength: 254, pattern: `^${EMAIL_CHAR}+@${EMAIL_CHAR}+\\.${EMAIL_CHAR}+$` });
const Password = Type.String({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH });

const AccountBody = Type.Object({
  account: Type.Object({
    id: Type.String({ format: "uuid" }),
    role: Type.Union([Type.Literal("provider"), Type.Literal("client")]),
    displayName: Type.String(),
    email: Type.String(),
  }),
});

const invalidCredentials = () =>
  new AppError({ status: 401, code: "INVALID_CREDENTIALS", title: "Unauthorized", detail: "Invalid email or password" });

// node-postgres errors may arrive wrapped by Drizzle; the SQLSTATE and constraint are on the innermost cause.
function pgError(err: unknown): { code?: string; constraint?: string } {
  let current = err as { code?: string; constraint?: string; cause?: unknown } | undefined;
  while (current && current.code === undefined && current.cause) current = current.cause as typeof current;
  return current ?? {};
}

export const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Responses carry account data or set a session cookie, so no cache may keep them. Error responses included.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.post(
    "/auth/register",
    {
      schema: {
        body: Type.Object({
          email: Email,
          password: Password,
          displayName: Type.String({ minLength: 1, maxLength: 80 }),
          role: Type.Union([Type.Literal("provider"), Type.Literal("client")]),
        }),
        response: { 201: AccountBody },
      },
    },
    async (request, reply) => {
      const { password, displayName, role } = request.body;
      const email = request.body.email.toLowerCase();
      const passwordHash = await hashPassword(password);
      try {
        const account = await app.db.transaction(async (tx) => {
          const [created] = await tx.insert(accounts).values({ role, displayName }).returning({ id: accounts.id });
          const accountId = created!.id;
          await tx.insert(accountCredentials).values({ accountId, email, passwordHash });
          await startSession(tx, reply, accountId);
          await audit(tx, { event: "account.registered", actorAccountId: accountId, ip: request.ip, requestId: request.id, metadata: { role } });
          return { id: accountId, role, displayName, email } satisfies Account;
        });
        return reply.code(201).send({ account });
      } catch (err) {
        const { code, constraint } = pgError(err);
        if (code === "23505" && constraint === "account_credentials_email_key") {
          throw new AppError({ status: 409, code: "EMAIL_TAKEN", title: "Conflict", detail: "An account with this email already exists" });
        }
        throw err;
      }
    },
  );

  app.post(
    "/auth/login",
    {
      schema: {
        body: Type.Object({ email: Type.String({ maxLength: 254 }), password: Type.String({ maxLength: PASSWORD_MAX_LENGTH }) }),
        response: { 200: AccountBody },
      },
    },
    async (request, reply) => {
      const email = request.body.email.toLowerCase();
      const [row] = await app.db
        .select({
          id: accounts.id,
          role: accounts.role,
          displayName: accounts.displayName,
          email: accountCredentials.email,
          passwordHash: accountCredentials.passwordHash,
        })
        .from(accountCredentials)
        .innerJoin(accounts, eq(accounts.id, accountCredentials.accountId))
        .where(eq(accountCredentials.email, email));

      // An unknown email still costs one verification, so response time does not reveal whether the account exists.
      const ok = await verifyPassword(request.body.password, row?.passwordHash ?? (await dummyHash()));
      if (!row || !ok) {
        const emailSha256 = createHash("sha256").update(email).digest("hex");
        await audit(app.db, { event: "auth.login.failed", ip: request.ip, requestId: request.id, metadata: { emailSha256 } });
        throw invalidCredentials();
      }

      const { passwordHash: _, ...account } = row;
      await app.db.transaction(async (tx) => {
        await deleteExpiredSessions(tx, account.id);
        await startSession(tx, reply, account.id);
        await audit(tx, { event: "auth.login.succeeded", actorAccountId: account.id, ip: request.ip, requestId: request.id });
      });
      return { account };
    },
  );

  // Idempotent: answers 204 whether or not the cookie names a live session.
  app.post("/auth/logout", { schema: { response: { 204: Type.Null() } } }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const [deleted] = await app.db
        .delete(sessions)
        .where(eq(sessions.tokenHash, hashToken(token)))
        .returning({ accountId: sessions.accountId });
      if (deleted) {
        await audit(app.db, { event: "auth.logout", actorAccountId: deleted.accountId, ip: request.ip, requestId: request.id });
      }
    }
    clearSessionCookie(reply);
    return reply.code(204).send(null);
  });

  app.get(
    "/me",
    { preHandler: requireAccount, schema: { security: [{ cookieAuth: [] }], response: { 200: AccountBody } } },
    async (request) => ({ account: request.account! }),
  );
};
