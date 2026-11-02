import { and, eq, ne, sql } from "drizzle-orm";
import type { Queryable } from "../audit.js";
import { availabilityRules, bookings, timeOff } from "../db/schema.js";
import { tstzrangeLiteral, parseClock } from "../time.js";
import type { Interval, Rule } from "./slots.js";

export async function loadRules(db: Queryable, providerId: string): Promise<Rule[]> {
  const rows = await db
    .select({ weekday: availabilityRules.weekday, start: availabilityRules.startTime, end: availabilityRules.endTime })
    .from(availabilityRules)
    .where(eq(availabilityRules.providerId, providerId));
  return rows.map((r) => ({ weekday: r.weekday, startMinute: parseClock(r.start), endMinute: parseClock(r.end) }));
}

const bounds = (during: typeof timeOff.during | typeof bookings.during) => ({
  start: sql`lower(${during})`.mapWith(timeOff.createdAt),
  end: sql`upper(${during})`.mapWith(timeOff.createdAt),
});

// The provider's time off that overlaps [from, to).
export async function loadTimeOff(db: Queryable, providerId: string, from: Date, to: Date): Promise<Interval[]> {
  return db
    .select(bounds(timeOff.during))
    .from(timeOff)
    .where(and(eq(timeOff.providerId, providerId), sql`${timeOff.during} && ${tstzrangeLiteral(from, to)}::tstzrange`));
}

// The provider's bookings that overlap [from, to) and hold their slot: every status but cancelled, the same rows
// that bookings_no_provider_overlap compares.
export async function loadBlockingBookings(db: Queryable, providerId: string, from: Date, to: Date): Promise<Interval[]> {
  return db
    .select(bounds(bookings.during))
    .from(bookings)
    .where(and(eq(bookings.providerId, providerId), ne(bookings.status, "cancelled"), sql`${bookings.during} && ${tstzrangeLiteral(from, to)}::tstzrange`));
}
