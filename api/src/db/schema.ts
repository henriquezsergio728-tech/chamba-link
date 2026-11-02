import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// A Postgres tstzrange, passed through in its text form, e.g. '[2026-11-02 09:00+00,2026-11-02 10:00+00)'.
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
});

export const accountRole = pgEnum('account_role', ['provider', 'client']);
export const bookingStatus = pgEnum('booking_status', ['pending', 'confirmed', 'cancelled']);

// accounts_id_role_key is the target of provider_profiles' composite foreign key, which limits profiles to providers.
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: accountRole('role').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('accounts_id_role_key').on(t.id, t.role)],
);

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

// role is always 'provider': with the composite foreign key to accounts (id, role), only a provider account can have a profile.
export const providerProfiles = pgTable(
  'provider_profiles',
  {
    accountId: uuid('account_id').primaryKey(),
    role: accountRole('role').notNull().default('provider'),
    headline: text('headline').notNull(),
    bio: text('bio').notNull(),
    department: text('department').notNull(),
    municipality: text('municipality').notNull(),
    whatsappE164: text('whatsapp_e164'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'provider_profiles_account_fkey', columns: [t.accountId, t.role], foreignColumns: [accounts.id, accounts.role] }).onDelete('cascade'),
    check('provider_profiles_role_provider', sql`${t.role} = 'provider'`),
    check('provider_profiles_whatsapp_e164', sql`${t.whatsappE164} ~ '^\\+[1-9][0-9]{7,14}$'`),
  ],
);

// Deactivated services keep their row, so bookings can keep referencing them.
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    priceFromCents: integer('price_from_cents'),
    durationMinutes: integer('duration_minutes').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'services_provider_id_fkey', columns: [t.providerId], foreignColumns: [providerProfiles.accountId] }).onDelete('cascade'),
    check('services_price_from_cents_nonnegative', sql`${t.priceFromCents} >= 0`),
    check('services_duration_minutes_steps', sql`${t.durationMinutes} BETWEEN 30 AND 480 AND ${t.durationMinutes} % 30 = 0`),
    index('services_provider_id_idx').on(t.providerId),
    index('services_created_at_id_idx').on(t.createdAt, t.id),
  ],
);

// Weekly rules in local wall-clock time. availability_rules_no_overlap (custom SQL in the migration) rejects
// overlapping rules for one provider and weekday.
export const availabilityRules = pgTable(
  'availability_rules',
  {
    providerId: uuid('provider_id').notNull(),
    weekday: smallint('weekday').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.weekday, t.startTime] }),
    foreignKey({ name: 'availability_rules_provider_id_fkey', columns: [t.providerId], foreignColumns: [providerProfiles.accountId] }).onDelete('cascade'),
    check('availability_rules_weekday', sql`${t.weekday} BETWEEN 0 AND 6`),
    check('availability_rules_end_after_start', sql`${t.endTime} > ${t.startTime}`),
  ],
);

export const timeOff = pgTable(
  'time_off',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id').notNull(),
    during: tstzrange('during').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'time_off_provider_id_fkey', columns: [t.providerId], foreignColumns: [providerProfiles.accountId] }).onDelete('cascade'),
    check('time_off_during_bounded', sql`NOT isempty(${t.during}) AND NOT lower_inf(${t.during}) AND NOT upper_inf(${t.during})`),
    index('time_off_provider_id_during_idx').using('gist', t.providerId, t.during),
  ],
);
