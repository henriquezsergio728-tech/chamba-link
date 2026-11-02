import { expect, test } from "vitest";
import { computeSlots, type Interval, type Rule } from "../src/catalog/slots.js";
import { formatLocal, fromLocal, toLocal } from "../src/time.js";

// Monday 2026-11-02, 06:00 local (12:00 UTC). Monday 2026-11-09 is a week later.
const NOW = new Date("2026-11-02T12:00:00Z");
const at = (local: string) => new Date(`${local}-06:00`);
const starts = (slots: Interval[]) => slots.map((s) => formatLocal(s.start).slice(0, 16));

const monday = (startMinute: number, endMinute: number): Rule => ({ weekday: 1, startMinute, endMinute });
const H = 60;

function slots(opts: Partial<Parameters<typeof computeSlots>[0]> = {}) {
  return computeSlots({
    rules: [monday(9 * H, 12 * H)],
    blocked: [],
    durationMinutes: 60,
    from: at("2026-11-09T00:00:00"),
    to: at("2026-11-10T00:00:00"),
    now: NOW,
    ...opts,
  });
}

test("local time conversion uses the fixed UTC-6 offset", () => {
  expect(formatLocal(new Date("2026-11-09T15:00:00Z"))).toBe("2026-11-09T09:00:00-06:00");
  expect(toLocal(new Date("2026-11-10T05:59:00Z"))).toMatchObject({ weekday: 1, minute: 23 * H + 59 });
  expect(fromLocal(toLocal(at("2026-11-09T13:30:00")).day, 24 * H).toISOString()).toBe("2026-11-10T06:00:00.000Z");
});

test("a rule yields every half-hour start where the whole service fits", () => {
  expect(starts(slots())).toEqual(["2026-11-09T09:00", "2026-11-09T09:30", "2026-11-09T10:00", "2026-11-09T10:30", "2026-11-09T11:00"]);
  const [first] = slots();
  expect(first!.end.getTime() - first!.start.getTime()).toBe(60 * 60_000);
});

test("a service longer than the rule yields no slot", () => {
  expect(slots({ durationMinutes: 240 })).toEqual([]);
});

test("touching rules are merged so a service can span both; rules on other weekdays are ignored", () => {
  const rules = [monday(9 * H, 10 * H), monday(10 * H, 11 * H), { weekday: 2, startMinute: 0, endMinute: 24 * H }];
  expect(starts(slots({ rules, durationMinutes: 120 }))).toEqual(["2026-11-09T09:00"]);
});

test("a rule ending at 24:00 offers its last slot ending at midnight, without running into the next day", () => {
  const rules = [monday(23 * H, 24 * H), { weekday: 2, startMinute: 0, endMinute: H }];
  expect(starts(slots({ rules, durationMinutes: 60, to: at("2026-11-11T00:00:00") }))).toEqual(["2026-11-09T23:00", "2026-11-10T00:00"]);
  expect(starts(slots({ rules, durationMinutes: 90, to: at("2026-11-11T00:00:00") }))).toEqual([]);
});

test("a blocked interval removes every overlapping start; touching ones are kept (half-open ranges)", () => {
  const blocked = [{ start: at("2026-11-09T10:00:00"), end: at("2026-11-09T10:30:00") }];
  expect(starts(slots({ blocked }))).toEqual(["2026-11-09T09:00", "2026-11-09T10:30", "2026-11-09T11:00"]);
});

test("starts lie in [from, to)", () => {
  expect(starts(slots({ from: at("2026-11-09T09:30:00"), to: at("2026-11-09T10:30:00") }))).toEqual(["2026-11-09T09:30", "2026-11-09T10:00"]);
});

test("no start is earlier than one hour from now", () => {
  const now = at("2026-11-09T08:30:00");
  expect(starts(slots({ now }))).toEqual(["2026-11-09T09:30", "2026-11-09T10:00", "2026-11-09T10:30", "2026-11-09T11:00"]);
  expect(slots({ now: at("2026-11-09T11:30:00") })).toEqual([]);
});

test("no start is later than 60 days from now", () => {
  // 60 days after 2026-11-09 09:00 local is 2027-01-08 09:00 local, a Friday.
  const friday: Rule = { weekday: 5, startMinute: 8 * H, endMinute: 12 * H };
  const now = at("2026-11-09T09:00:00");
  const res = slots({ rules: [friday], now, from: at("2027-01-08T00:00:00"), to: at("2027-01-09T00:00:00") });
  expect(starts(res)).toEqual(["2027-01-08T08:00", "2027-01-08T08:30", "2027-01-08T09:00"]);
});

test("every start is on the local half-hour grid", () => {
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 6 * H + 30, endMinute: 20 * H }));
  const res = slots({ rules, durationMinutes: 90, from: NOW, to: at("2026-11-16T00:00:00") });
  expect(res.length).toBeGreaterThan(100);
  for (const s of res) expect(toLocal(s.start).minute % 30).toBe(0);
  expect(res.every((s, i) => i === 0 || s.start > res[i - 1]!.start)).toBe(true);
});
