import { DrizzleQueryError } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";
import { fromLocal, toLocal } from "../src/time.js";
import { type Actor, errorPaths, harness, providerWithProfile } from "./harness.js";

// While limiterStore.broken is set, every rate-limiter call fails as it would if the rate_limits table were missing.
const limiterStore = vi.hoisted(() => ({ broken: false }));
vi.mock("../src/rate-limit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rate-limit.js")>();
  const fail = () =>
    Promise.reject(new DrizzleQueryError('insert into "rate_limits"', [], Object.assign(new Error('relation "rate_limits" does not exist'), { code: "42P01" })));
  return { ...actual, consume: (...args: Parameters<typeof actual.consume>) => (limiterStore.broken ? fail() : actual.consume(...args)) } as typeof actual;
});

const h = harness();

beforeAll(async () => {
  await h.app.ready();
});

afterAll(async () => {
  await h.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NUMBER = "+50370001234";

// The instant of a local time `days` local days from today, e.g. at(3, 9 * 60) is 09:00 three days from now.
const at = (days: number, minute: number) => fromLocal(new Date(toLocal(new Date()).day.getTime() + days * DAY), minute);

// A provider available all day every day, with one 60-minute service.
async function setup(opts: { whatsapp?: boolean; rules?: { weekday: number; start: string; end: string }[] } = {}) {
  const provider = await providerWithProfile(h, opts.whatsapp === false ? {} : { whatsappE164: NUMBER });
  const rules = opts.rules ?? [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "24:00" }));
  expect((await h.call(provider, "PUT", "/v1/providers/me/availability", { rules })).statusCode).toBe(200);
  const service = (await h.call(provider, "POST", "/v1/providers/me/services", { title: "Revisión eléctrica", category: "electrical", durationMinutes: 60 })).json().service;
  return { provider, service };
}

const book = (client: Actor, serviceId: string, start: Date, extra: Record<string, unknown> = {}) =>
  h.call(client, "POST", "/v1/bookings", { serviceId, start: start.toISOString(), ...extra });

async function booked(client: Actor, serviceId: string, start: Date) {
  const res = await book(client, serviceId, start);
  expect(res.statusCode).toBe(201);
  return res.json().booking;
}

const act = (who: Actor | null, id: string, verb: string) => h.call(who, "POST", `/v1/bookings/${id}/${verb}`);

// Moves a booking so that it started an hour ago, as the owner; the API has no route that changes a booking's time.
const startInPast = (id: string) =>
  h.owner.query("UPDATE bookings SET during = tstzrange(now() - interval '1 hour', now()), expires_at = now() - interval '1 hour' WHERE id = $1", [id]);

describe("authorization", () => {
  test("POST /v1/bookings is 401 anonymous and 403 for a provider", async () => {
    const { provider, service } = await setup();
    const anonymous = await book(null as unknown as Actor, service.id, at(3, 600));
    expect(anonymous.statusCode).toBe(401);
    const asProvider = await book(provider, service.id, at(3, 600));
    expect(asProvider.statusCode).toBe(403);
    expect(asProvider.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(asProvider.headers["cache-control"]).toBe("no-store");
  });

  test("a booking is visible to its two parties only; anyone else gets 404", async () => {
    const { provider, service } = await setup();
    const client = await h.actor("client");
    const booking = await booked(client, service.id, at(3, 600));
    for (const party of [client, provider]) expect((await h.call(party, "GET", `/v1/bookings/${booking.id}`)).json().booking).toEqual(booking);
    for (const stranger of [await h.actor("client"), (await setup()).provider]) {
      expect((await h.call(stranger, "GET", `/v1/bookings/${booking.id}`)).statusCode).toBe(404);
      for (const verb of ["confirm", "decline", "cancel", "complete"]) expect((await act(stranger, booking.id, verb)).statusCode).toBe(404);
    }
    expect((await h.call(null, "GET", `/v1/bookings/${booking.id}`)).statusCode).toBe(401);
    expect((await h.call(null, "GET", "/v1/bookings")).statusCode).toBe(401);
    for (const verb of ["confirm", "decline", "cancel", "complete"]) expect((await act(null, booking.id, verb)).statusCode).toBe(401);
    expect((await h.call(client, "GET", "/v1/bookings/00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });

  test("the client cannot confirm, decline or complete: 403", async () => {
    const { service } = await setup();
    const client = await h.actor("client");
    const booking = await booked(client, service.id, at(3, 600));
    for (const verb of ["confirm", "decline", "complete"]) {
      const res = await act(client, booking.id, verb);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

describe("POST /v1/bookings", () => {
  test("creates a pending booking with a 24-hour hold and returns a wa.me link with the reference", async () => {
    const { provider, service } = await setup();
    const client = await h.actor("client");
    const start = at(3, 9 * 60);
    const before = Date.now();
    const res = await book(client, service.id, start, { clientNote: "Tengo perro" });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { booking, whatsappLink } = res.json();
    expect(booking).toEqual({
      id: expect.any(String),
      reference: `CL-${booking.id.slice(0, 8).toUpperCase()}`,
      status: "pending",
      serviceId: service.id,
      serviceTitle: "Revisión eléctrica",
      providerId: provider.id,
      clientId: client.id,
      start: expect.stringMatching(/T09:00:00-06:00$/),
      end: expect.stringMatching(/T10:00:00-06:00$/),
      expiresAt: expect.stringMatching(/-06:00$/),
      clientNote: "Tengo perro",
      createdAt: expect.stringMatching(/-06:00$/),
      updatedAt: expect.stringMatching(/-06:00$/),
    });
    expect(Date.parse(booking.start)).toBe(start.getTime());
    const hold = Date.parse(booking.expiresAt) - before;
    expect(hold).toBeGreaterThan(DAY - 5_000);
    expect(hold).toBeLessThanOrEqual(DAY + 5_000);

    const message = `Hola ${provider.displayName}, reservé "Revisión eléctrica" para el ${booking.start.slice(0, 16).replace("T", " ")} (hora de El Salvador). Referencia: ${booking.reference}.`;
    expect(whatsappLink).toBe(`https://wa.me/50370001234?text=${encodeURIComponent(message)}`);
  });

  test("a hold never outlasts the start time, and the link is null without a number", async () => {
    // 10:00 local on a Tuesday. The start is two hours from now, and from 21:00 to 21:30 local that is 23:30, where the service cannot end by midnight.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-03T16:00:00Z") });
    onTestFinished(() => void vi.useRealTimers());
    const { service } = await setup({ whatsapp: false });
    const start = new Date(Math.ceil((Date.now() + 2 * HOUR) / (30 * 60_000)) * 30 * 60_000);
    const res = await book(await h.actor("client"), service.id, start);
    expect(res.statusCode).toBe(201);
    expect(Date.parse(res.json().booking.expiresAt)).toBe(start.getTime());
    expect(res.json().whatsappLink).toBeNull();
  });

  test.each([
    ["a start off the half-hour", (s: Date) => new Date(s.getTime() + 15 * 60_000), "START_MISALIGNED"],
    ["a start with seconds", (s: Date) => new Date(s.getTime() + 1_000), "START_MISALIGNED"],
    ["a start less than an hour away", () => new Date(Math.ceil(Date.now() / (30 * 60_000)) * 30 * 60_000), "OUTSIDE_HORIZON"],
    ["a start more than 60 days away", () => at(62, 600), "OUTSIDE_HORIZON"],
  ])("rejects %s with 422", async (_, start, code) => {
    const { service } = await setup();
    const res = await book(await h.actor("client"), service.id, start(at(3, 600)));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code });
  });

  test("rejects a start outside the availability rules, or a service that runs past them, with 422 OUTSIDE_AVAILABILITY", async () => {
    const day = at(3, 0);
    const weekday = toLocal(day).weekday;
    const { service } = await setup({ rules: [{ weekday, start: "09:00", end: "12:00" }] });
    const client = await h.actor("client");
    expect((await book(client, service.id, at(3, 8 * 60))).json()).toMatchObject({ code: "OUTSIDE_AVAILABILITY" });
    expect((await book(client, service.id, at(3, 11 * 60 + 30))).json()).toMatchObject({ code: "OUTSIDE_AVAILABILITY" });
    expect((await book(client, service.id, at(4, 9 * 60))).json()).toMatchObject({ code: "OUTSIDE_AVAILABILITY" });
    expect((await book(client, service.id, at(3, 11 * 60))).statusCode).toBe(201);
  });

  test("rejects a slot that overlaps time off with 422 TIME_OFF", async () => {
    const { provider, service } = await setup();
    await h.call(provider, "POST", "/v1/providers/me/time-off", { start: at(3, 9 * 60 + 30).toISOString(), end: at(3, 10 * 60).toISOString() });
    const client = await h.actor("client");
    expect((await book(client, service.id, at(3, 9 * 60))).json()).toMatchObject({ code: "TIME_OFF" });
    expect((await book(client, service.id, at(3, 10 * 60))).statusCode).toBe(201);
  });

  test("an unknown or inactive service is 404", async () => {
    const { provider, service } = await setup();
    const client = await h.actor("client");
    expect((await book(client, "00000000-0000-4000-8000-000000000000", at(3, 600))).statusCode).toBe(404);
    await h.call(provider, "DELETE", `/v1/providers/me/services/${service.id}`);
    expect((await book(client, service.id, at(3, 600))).statusCode).toBe(404);
  });

  test.each([
    ["a note over 500 characters", { clientNote: "a".repeat(501) }, "body/clientNote"],
    ["a start without an offset", { start: "2030-01-01T09:00:00" }, "body/start"],
    ["a serviceId that is not a uuid", { serviceId: "x" }, "body/serviceId"],
  ])("rejects %s with 400", async (_, overrides, path) => {
    const { service } = await setup();
    const res = await h.call(await h.actor("client"), "POST", "/v1/bookings", { serviceId: service.id, start: at(3, 600).toISOString(), ...overrides });
    expect(res.statusCode).toBe(400);
    expect(errorPaths(res.json())).toContain(path);
  });

  test("an overlapping booking is 409 SLOT_TAKEN; a declined or cancelled one frees the slot", async () => {
    const { provider, service } = await setup();
    const first = await booked(await h.actor("client"), service.id, at(3, 600));
    const second = await book(await h.actor("client"), service.id, at(3, 630));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "SLOT_TAKEN" });
    expect((await book(await h.actor("client"), service.id, at(3, 660))).statusCode).toBe(201);

    await act(provider, first.id, "decline");
    const third = await booked(await h.actor("client"), service.id, at(3, 600));
    await act(provider, third.id, "cancel");
    expect((await book(await h.actor("client"), service.id, at(3, 570))).statusCode).toBe(201);
  });

  test("20 concurrent bookings of one slot give exactly one 201 and nineteen 409 SLOT_TAKEN", { timeout: 60_000 }, async () => {
    const { provider, service } = await setup();
    const clients = await Promise.all(Array.from({ length: 20 }, () => h.actor("client")));
    const results = await Promise.all(clients.map((c) => book(c, service.id, at(5, 600))));
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, ...Array(19).fill(409)]);
    for (const r of results.filter((x) => x.statusCode === 409)) expect(r.json()).toMatchObject({ code: "SLOT_TAKEN" });
    const { rows } = await h.owner.query("SELECT count(*)::int AS n FROM bookings WHERE provider_id = $1", [provider.id]);
    expect(rows[0].n).toBe(1);
  });
});

describe("lazy expiry", () => {
  test("a lapsed hold frees the slot: slots agree, and the next booking marks it expired in the same transaction", async () => {
    const { provider, service } = await setup();
    const first = await booked(await h.actor("client"), service.id, at(3, 600));
    const slotsUrl = `/v1/providers/${provider.id}/slots?serviceId=${service.id}&from=${encodeURIComponent(at(3, 600).toISOString())}&to=${encodeURIComponent(at(3, 601).toISOString())}`;
    expect((await h.call(null, "GET", slotsUrl)).json().slots).toEqual([]);

    await h.owner.query("UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1", [first.id]);
    // The row is still pending in the table, but it is reported as expired and no longer blocks the slot.
    expect((await h.owner.query("SELECT status FROM bookings WHERE id = $1", [first.id])).rows[0].status).toBe("pending");
    expect((await h.call(provider, "GET", `/v1/bookings/${first.id}`)).json().booking.status).toBe("expired");
    expect((await h.call(null, "GET", slotsUrl)).json().slots).toHaveLength(1);
    expect((await act(provider, first.id, "confirm")).statusCode).toBe(409);

    const next = await h.actor("client");
    const second = await book(next, service.id, at(3, 630));
    expect(second.statusCode).toBe(201);
    expect((await h.owner.query("SELECT status FROM bookings WHERE id = $1", [first.id])).rows[0].status).toBe("expired");
    expect((await h.auditRows(next.ip)).map((r) => [r.event, r.metadata])).toEqual([
      ["booking.expired", { bookingId: first.id }],
      ["booking.created", { bookingId: second.json().booking.id, serviceId: service.id, providerId: provider.id }],
    ]);
  });

  test("without the sweep the exclusion constraint still counts a lapsed pending row", async () => {
    const { provider, service } = await setup();
    const client = await h.actor("client");
    const first = await booked(client, service.id, at(3, 600));
    await h.owner.query("UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1", [first.id]);
    const insert = h.owner.query(
      "INSERT INTO bookings (provider_id, client_id, service_id, during, expires_at) VALUES ($1, $2, $3, tstzrange($4, $5), now() + interval '1 day')",
      [provider.id, client.id, service.id, at(3, 600), at(3, 660)],
    );
    await expect(insert).rejects.toMatchObject({ code: "23P01" });
  });
});

describe("transitions", () => {
  async function fresh(minute = 600) {
    const { provider, service } = await setup();
    const client = await h.actor("client");
    const booking = await booked(client, service.id, at(3, minute));
    return { provider, client, booking };
  }

  const expectStatus = async (res: Awaited<ReturnType<typeof act>>, status: number, bookingStatus?: string) => {
    expect(res.statusCode).toBe(status);
    if (status === 200) expect(res.json().booking.status).toBe(bookingStatus);
    if (status === 409) expect(res.json()).toMatchObject({ code: "INVALID_TRANSITION" });
  };

  test("confirm: provider, from pending only", async () => {
    const { provider, booking } = await fresh();
    await expectStatus(await act(provider, booking.id, "confirm"), 200, "confirmed");
    await expectStatus(await act(provider, booking.id, "confirm"), 409);
    await expectStatus(await act(provider, booking.id, "decline"), 409);
  });

  test("decline: provider, from pending only; a declined booking cannot be cancelled, confirmed or completed", async () => {
    const { provider, client, booking } = await fresh();
    await expectStatus(await act(provider, booking.id, "decline"), 200, "declined");
    for (const verb of ["confirm", "decline", "complete"]) await expectStatus(await act(provider, booking.id, verb), 409);
    await expectStatus(await act(client, booking.id, "cancel"), 409);
  });

  test("cancel: either party, from pending or confirmed", async () => {
    const a = await fresh();
    await expectStatus(await act(a.client, a.booking.id, "cancel"), 200, "cancelled");
    await expectStatus(await act(a.client, a.booking.id, "cancel"), 409);
    await expectStatus(await act(a.provider, a.booking.id, "confirm"), 409);

    const b = await fresh();
    await act(b.provider, b.booking.id, "confirm");
    await expectStatus(await act(b.provider, b.booking.id, "cancel"), 200, "cancelled");

    const c = await fresh();
    await act(c.provider, c.booking.id, "confirm");
    await expectStatus(await act(c.client, c.booking.id, "cancel"), 200, "cancelled");
  });

  test("a client can cancel only before the start time; the provider also after it", async () => {
    const { provider, client, booking } = await fresh();
    await act(provider, booking.id, "confirm");
    await startInPast(booking.id);
    await expectStatus(await act(client, booking.id, "cancel"), 409);
    await expectStatus(await act(provider, booking.id, "cancel"), 200, "cancelled");
  });

  test("complete: provider, from confirmed, only after the start time; completed is final", async () => {
    const { provider, client, booking } = await fresh();
    await expectStatus(await act(provider, booking.id, "complete"), 409);
    await act(provider, booking.id, "confirm");
    await expectStatus(await act(provider, booking.id, "complete"), 409);
    await startInPast(booking.id);
    await expectStatus(await act(provider, booking.id, "complete"), 200, "completed");
    for (const verb of ["confirm", "decline", "cancel", "complete"]) await expectStatus(await act(provider, booking.id, verb), 409);
    await expectStatus(await act(client, booking.id, "cancel"), 409);
  });

  test("a pending booking that started without confirmation has lapsed and cannot be completed or confirmed", async () => {
    const { provider, booking } = await fresh();
    await startInPast(booking.id);
    for (const verb of ["confirm", "decline", "complete", "cancel"]) await expectStatus(await act(provider, booking.id, verb), 409);
  });

  test("every transition writes booking.<verb> with ids only", async () => {
    const { provider, client, booking } = await fresh();
    const note = "nota-privada-del-cliente";
    const other = await booked(client, booking.serviceId, at(4, 600));
    await h.owner.query("UPDATE bookings SET client_note = $2 WHERE id = $1", [other.id, note]);
    await act(provider, booking.id, "confirm");
    await startInPast(booking.id);
    await act(provider, booking.id, "complete");
    await act(provider, other.id, "decline");
    const rows = [...(await h.auditRows(client.ip)), ...(await h.auditRows(provider.ip))].filter((r) => r.event.startsWith("booking."));
    expect(rows.map((r) => [r.event, r.actor_account_id, r.metadata])).toEqual([
      ["booking.created", client.id, { bookingId: booking.id, serviceId: booking.serviceId, providerId: provider.id }],
      ["booking.created", client.id, { bookingId: other.id, serviceId: booking.serviceId, providerId: provider.id }],
      ["booking.confirmed", provider.id, { bookingId: booking.id }],
      ["booking.completed", provider.id, { bookingId: booking.id }],
      ["booking.declined", provider.id, { bookingId: other.id }],
    ]);
    expect(JSON.stringify(rows)).not.toContain(note);
  });

  test("a transition on a non-uuid id is 400", async () => {
    const res = await act(await h.actor("client"), "nope", "cancel");
    expect(res.statusCode).toBe(400);
    expect(errorPaths(res.json())).toContain("params/id");
  });
});

describe("GET /v1/bookings", () => {
  test("lists the caller's own bookings, newest first, as client or as provider, with keyset pages", async () => {
    const { provider, service } = await setup();
    const client = await h.actor("client");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await booked(client, service.id, at(3, 600 + i * 60))).id);
    // Two rows share one created_at, so their order comes from id alone.
    await h.owner.query("UPDATE bookings SET created_at = '2026-01-01 00:00:00.654321+00' WHERE id = ANY($1)", [ids.slice(1, 3)]);
    await booked(await h.actor("client"), service.id, at(4, 600));

    const pages = async (who: Actor, query = "") => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await h.call(who, "GET", `/v1/bookings?limit=2${query}${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        seen.push(...res.json().bookings.map((b: { id: string }) => b.id));
        cursor = res.json().nextCursor;
      } while (cursor);
      return seen;
    };
    const mine = await pages(client);
    expect(new Set(mine).size).toBe(5);
    expect([...mine].sort()).toEqual([...ids].sort());
    expect(mine).toEqual((await h.call(client, "GET", "/v1/bookings?limit=50")).json().bookings.map((b: { id: string }) => b.id));
    expect(await pages(provider)).toHaveLength(6);
    expect(await pages(await h.actor("client"))).toEqual([]);
  });

  test("filters by status, with lapsed pending bookings counted as expired", async () => {
    const { provider, service } = await setup();
    const client = await h.actor("client");
    const pending = await booked(client, service.id, at(3, 600));
    const confirmed = await booked(client, service.id, at(3, 720));
    const lapsed = await booked(client, service.id, at(3, 840));
    await act(provider, confirmed.id, "confirm");
    await h.owner.query("UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1", [lapsed.id]);
    const ids = async (status: string) => (await h.call(client, "GET", `/v1/bookings?status=${status}`)).json().bookings.map((b: { id: string }) => b.id);
    expect(await ids("pending")).toEqual([pending.id]);
    expect(await ids("confirmed")).toEqual([confirmed.id]);
    expect(await ids("expired")).toEqual([lapsed.id]);
    expect(await ids("cancelled")).toEqual([]);
    expect((await h.call(client, "GET", "/v1/bookings?status=lost")).statusCode).toBe(400);
    expect((await h.call(client, "GET", "/v1/bookings?cursor=bad")).json()).toMatchObject({ code: "INVALID_CURSOR" });
  });
});

describe("rate limit", () => {
  test("the 21st booking request from one client in the hour is 429 with Retry-After, audited once", async () => {
    const { service } = await setup();
    const client = await h.actor("client");
    // Requests that pass schema validation count, including ones answered 422.
    const misaligned = new Date(at(3, 600).getTime() + 60_000);
    for (let i = 0; i < 20; i++) expect((await book(client, service.id, misaligned)).statusCode).toBe(422);
    for (let i = 0; i < 3; i++) {
      const res = await book(client, service.id, at(3, 600));
      expect(res.statusCode).toBe(429);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = res.json();
      expect(body).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfterSeconds: expect.any(Number) });
      expect(res.headers["retry-after"]).toBe(String(body.retryAfterSeconds));
      expect(body.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
    const limited = (await h.auditRows(client.ip)).filter((r) => r.event === "booking.rate_limited");
    expect(limited).toEqual([{ event: "booking.rate_limited", actor_account_id: client.id, metadata: { scope: "booking-client" } }]);
    expect((await book(await h.actor("client"), service.id, at(3, 600))).statusCode).toBe(201);
  });

  test("requests rejected by schema validation are not counted", async () => {
    const { service } = await setup();
    const client = await h.actor("client");
    for (let i = 0; i < 21; i++) expect((await h.call(client, "POST", "/v1/bookings", { serviceId: service.id })).statusCode).toBe(400);
    expect((await book(client, service.id, at(3, 600))).statusCode).toBe(201);
  });

  test("when the limiter store fails, bookings proceed as without a limiter", async () => {
    const { service } = await setup();
    limiterStore.broken = true;
    try {
      expect((await book(await h.actor("client"), service.id, at(3, 600))).statusCode).toBe(201);
    } finally {
      limiterStore.broken = false;
    }
  });
});
