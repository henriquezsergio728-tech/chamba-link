import { BOOKING_HORIZON_DAYS, BOOKING_MIN_LEAD_MINUTES, SLOT_STEP_MINUTES } from "../domain.js";
import { addMinutes, fromLocal, nextDay, toLocal } from "../time.js";

// A weekly rule in local minutes since midnight, [startMinute, endMinute).
export type Rule = { weekday: number; startMinute: number; endMinute: number };
export type Interval = { start: Date; end: Date };

// The earliest and latest start a booking made at `now` may have.
export function horizon(now: Date) {
  return { earliest: addMinutes(now, BOOKING_MIN_LEAD_MINUTES), latest: addMinutes(now, BOOKING_HORIZON_DAYS * 24 * 60) };
}

// Rules of one weekday sorted and merged where they touch, so that a service may span two adjacent rules.
function dayIntervals(rules: Rule[], weekday: number) {
  const sorted = rules.filter((r) => r.weekday === weekday).sort((a, b) => a.startMinute - b.startMinute);
  const merged: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && r.startMinute <= last.end) last.end = Math.max(last.end, r.endMinute);
    else merged.push({ start: r.startMinute, end: r.endMinute });
  }
  return merged;
}

// Free slots whose start lies in [from, to): every start on the step grid inside a day's availability where the whole
// service fits before the availability ends, that overlaps no blocked interval, and that lies inside the booking
// horizon. Availability ends at local midnight; it does not run into the next day's rules.
export function computeSlots(opts: { rules: Rule[]; blocked: Interval[]; durationMinutes: number; from: Date; to: Date; now: Date }) {
  const { earliest, latest } = horizon(opts.now);
  const lo = Math.max(opts.from.getTime(), earliest.getTime());
  const hi = Math.min(opts.to.getTime(), latest.getTime() + 1);
  const slots: Interval[] = [];
  if (lo >= hi) return slots;

  const lastDay = toLocal(new Date(hi - 1)).day.getTime();
  for (let day = toLocal(new Date(lo)).day; day.getTime() <= lastDay; day = nextDay(day)) {
    for (const interval of dayIntervals(opts.rules, day.getUTCDay())) {
      for (let minute = interval.start; minute + opts.durationMinutes <= interval.end; minute += SLOT_STEP_MINUTES) {
        const start = fromLocal(day, minute);
        if (start.getTime() < lo || start.getTime() >= hi) continue;
        const end = addMinutes(start, opts.durationMinutes);
        if (opts.blocked.some((b) => b.start < end && start < b.end)) continue;
        slots.push({ start, end });
      }
    }
  }
  return slots;
}
