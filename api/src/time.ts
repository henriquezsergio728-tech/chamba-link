import { UTC_OFFSET_MINUTES } from "./domain.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const OFFSET_MS = UTC_OFFSET_MINUTES * MINUTE_MS;

export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE_MS);

// A local calendar day, as the UTC midnight that carries its date. Only its UTC fields are meaningful.
export type LocalDay = Date;

// The local day an instant falls on, and the minutes since local midnight.
export function toLocal(instant: Date): { day: LocalDay; weekday: number; minute: number } {
  const shifted = instant.getTime() + OFFSET_MS;
  const day = new Date(Math.floor(shifted / DAY_MS) * DAY_MS);
  return { day, weekday: day.getUTCDay(), minute: (shifted - day.getTime()) / MINUTE_MS };
}

// The instant of a local day and minute of that day. minute may be 1440, the following midnight.
export const fromLocal = (day: LocalDay, minute: number) => new Date(day.getTime() + minute * MINUTE_MS - OFFSET_MS);

export const nextDay = (day: LocalDay) => new Date(day.getTime() + DAY_MS);

// ISO 8601 in local time with the fixed offset, e.g. 2026-11-03T09:00:00-06:00.
export function formatLocal(instant: Date) {
  const sign = UTC_OFFSET_MINUTES < 0 ? "-" : "+";
  const abs = Math.abs(UTC_OFFSET_MINUTES);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const local = new Date(instant.getTime() + OFFSET_MS).toISOString();
  return `${local.slice(0, 19)}${offset}`;
}

// "HH:MM" or Postgres "HH:MM:SS" to minutes since midnight; "24:00" is 1440.
export function parseClock(value: string) {
  const [h, m] = value.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export const formatClock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

// A half-open tstzrange literal for an insert, e.g. [2026-11-03T15:00:00.000Z,2026-11-03T16:00:00.000Z).
export const tstzrangeLiteral = (start: Date, end: Date) => `[${start.toISOString()},${end.toISOString()})`;
