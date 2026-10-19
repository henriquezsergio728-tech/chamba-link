import { customType, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => accounts.id),
  clientId: uuid('client_id').notNull().references(() => accounts.id),
  during: tstzrange('during').notNull(),
  status: bookingStatus('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
