import { createHash, randomBytes, randomInt } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { dbPlugin } from "../src/db.js";
import { asAppRole } from "./app-role.js";

config({ path: "../.env" });

// One signed-in account and the client address its requests come from, so audit rows can be selected by address.
export type Actor = { id: string; role: "provider" | "client"; displayName: string; ip: string; cookie: string };

// The API under test runs as the restricted role, as in production; setup, cleanup and checks go through `owner`,
// as in auth.test.ts. Accounts are created directly with a session row, so tests do not spend the registration
// rate limit or an Argon2 computation per account.
export function harness() {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 25 });
  const app = buildApp();
  app.register(dbPlugin, { connectionString: asAppRole(process.env.DATABASE_URL!), poolMax: 20 });
  const accountIds: string[] = [];

  async function actor(role: Actor["role"], displayName = role === "provider" ? "Proveedora" : "Cliente"): Promise<Actor> {
    const { rows } = await owner.query("INSERT INTO accounts (role, display_name) VALUES ($1, $2) RETURNING id", [role, displayName]);
    const id: string = rows[0].id;
    accountIds.push(id);
    const token = randomBytes(32).toString("base64url");
    await owner.query("INSERT INTO account_credentials (account_id, email, password_hash) VALUES ($1, $2, 'not-a-hash')", [
      id,
      `test-${randomBytes(6).toString("hex")}@example.test`,
    ]);
    await owner.query("INSERT INTO sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')", [
      id,
      createHash("sha256").update(token).digest("hex"),
    ]);
    return { id, role, displayName, ip: `198.18.${randomInt(256)}.${randomInt(1, 255)}`, cookie: `session=${token}` };
  }

  // A request as an actor, or anonymous with null.
  function call(who: Actor | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) {
    return app.inject({
      method,
      url,
      payload,
      remoteAddress: who?.ip ?? `198.18.${randomInt(256)}.${randomInt(1, 255)}`,
      headers: { ...(who ? { cookie: who.cookie } : {}), ...headers },
    });
  }

  async function auditRows(ip: string) {
    const { rows } = await owner.query("SELECT event, actor_account_id, metadata FROM audit_log WHERE ip = $1 ORDER BY id", [ip]);
    return rows as { event: string; actor_account_id: string | null; metadata: Record<string, unknown> }[];
  }

  // Bookings reference accounts and services without cascading, so they go first; deleting an account cascades to
  // its credentials, sessions, profile, services, availability and time off. Audit rows remain by design.
  async function close() {
    await owner.query("DELETE FROM bookings WHERE provider_id = ANY($1) OR client_id = ANY($1)", [accountIds]);
    await owner.query("DELETE FROM accounts WHERE id = ANY($1)", [accountIds]);
    await app.close();
    await owner.end();
  }

  return { app, owner, actor, call, auditRows, close };
}

export const validProfile = {
  headline: "Fontanería a domicilio",
  bio: "Reparaciones y conexiones.",
  department: "san-salvador",
  municipality: "San Salvador Centro",
};

// A provider with a profile, ready to add services, availability and time off.
export async function providerWithProfile(h: ReturnType<typeof harness>, profile: Record<string, unknown> = {}) {
  const provider = await h.actor("provider");
  const res = await h.call(provider, "PUT", "/v1/providers/me/profile", { ...validProfile, ...profile });
  if (res.statusCode !== 200) throw new Error(`profile setup failed: ${res.statusCode} ${res.body}`);
  return provider;
}

export const errorPaths = (body: { errors?: { path: string }[] }) => (body.errors ?? []).map((e) => e.path);
