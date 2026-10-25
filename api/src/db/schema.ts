import { sql } from 'drizzle-orm';
import { bigint, check, customType, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// A Postgres tstzrange, passed through in its text form, e.g. '[2026-11-02 09:00+00,2026-11-02 10:00+00)'.
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
});

export const accountRole = pgEnum('account_role', ['provider', 'client']);
export const bookingStatus = pgEnum('booking_status', ['pending', 'confirmed', 'cancelled']);

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: accountRole('role').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Kept apart from accounts so that a query on accounts never selects a password hash.
export const accountCredentials = pgTable(
  'account_credentials',
  {
    accountId: uuid('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('account_credentials_email_normalized', sql`${t.email} = lower(${t.email}) AND char_length(${t.email}) <= 254`)],
);

// token_hash is the hex SHA-256 of the cookie token; the token itself is never stored.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_account_id_idx').on(t.accountId)],
);

// actor_account_id has no foreign key so that rows outlive the account. A trigger makes the table append-only.
export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actorAccountId: uuid('actor_account_id'),
  event: text('event').notNull(),
  ip: text('ip'),
  requestId: text('request_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
});

// One fixed-window counter per key and window. Rows older than 24 hours are pruned by the API.
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index('rate_limits_window_start_idx').on(t.windowStart)],
);

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => accounts.id),
  clientId: uuid('client_id').notNull().references(() => accounts.id),
  during: tstzrange('during').notNull(),
  status: bookingStatus('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
