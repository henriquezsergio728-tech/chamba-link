import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditLog } from "./db/schema.js";

// app.db or a transaction opened from it.
export type Queryable = Pick<NodePgDatabase, "select" | "insert" | "update" | "delete">;

export type AuditEvent =
  | "account.registered"
  | "auth.login.succeeded"
  | "auth.login.failed"
  | "auth.logout"
  | "auth.rate_limited"
  | "provider.profile.updated"
  | "provider.service.created"
  | "provider.service.updated"
  | "provider.service.deactivated"
  | "provider.availability.replaced"
  | "provider.time_off.created"
  | "provider.time_off.deleted";

// Appends one row to audit_log. Callers must not pass passwords, tokens or the raw email of an unknown account.
// Provider events carry ids only in metadata, never text the provider wrote.
export async function audit(
  db: Queryable,
  entry: { event: AuditEvent; actorAccountId?: string | null; ip?: string | null; requestId?: string | null; metadata?: Record<string, unknown> },
) {
  await db.insert(auditLog).values({
    event: entry.event,
    actorAccountId: entry.actorAccountId ?? null,
    ip: entry.ip ?? null,
    requestId: entry.requestId ?? null,
    metadata: entry.metadata ?? {},
  });
}
