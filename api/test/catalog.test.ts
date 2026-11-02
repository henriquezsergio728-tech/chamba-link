import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { formatLocal, fromLocal, toLocal } from "../src/time.js";
import { type Actor, errorPaths, harness, providerWithProfile } from "./harness.js";

const h = harness();

beforeAll(async () => {
  await h.app.ready();
});

afterAll(async () => {
  await h.close();
});

// A word no other test's titles contain, so catalog queries see only this test's services.
const marker = () => `zq${randomBytes(5).toString("hex")}`;

async function addService(provider: Actor, overrides: Record<string, unknown> = {}) {
  const res = await h.call(provider, "POST", "/v1/providers/me/services", { title: "Servicio", category: "cleaning", durationMinutes: 60, ...overrides });
  expect(res.statusCode).toBe(201);
  return res.json().service;
}

const catalog = (query: string, headers: Record<string, string> = {}) => h.call(null, "GET", `/v1/services?${query}`, undefined, headers);

describe("GET /v1/services", () => {
  test("lists active services of providers with a profile, newest first, with the provider's public fields", async () => {
    const m = marker();
    const provider = await providerWithProfile(h, { department: "la-paz", municipality: "Zacatecoluca" });
    const older = await addService(provider, { title: `${m} uno`, priceFromCents: 2500 });
    const newer = await addService(provider, { title: `${m} dos` });
    const inactive = await addService(provider, { title: `${m} tres` });
    await h.call(provider, "DELETE", `/v1/providers/me/services/${inactive.id}`);

    const res = await catalog(`q=${m}`);
    expect(res.statusCode).toBe(200);
    const { active: _, ...olderPublic } = older;
    const { active: __, ...newerPublic } = newer;
    const providerFields = { id: provider.id, displayName: provider.displayName, department: "la-paz", municipality: "Zacatecoluca" };
    expect(res.json()).toEqual({
      services: [
        { ...newerPublic, provider: providerFields },
        { ...olderPublic, provider: providerFields },
      ],
      nextCursor: null,
    });
  });

  test("filters by category and department", async () => {
    const m = marker();
    const east = await providerWithProfile(h, { department: "san-miguel" });
    const west = await providerWithProfile(h, { department: "sonsonate" });
    const a = await addService(east, { title: `${m} a`, category: "plumbing" });
    const b = await addService(east, { title: `${m} b`, category: "electrical" });
    const c = await addService(west, { title: `${m} c`, category: "plumbing" });
    const ids = async (query: string) => (await catalog(`q=${m}&${query}`)).json().services.map((s: { id: string }) => s.id);
    expect(await ids("category=plumbing")).toEqual([c.id, a.id]);
    expect(await ids("department=san-miguel")).toEqual([b.id, a.id]);
    expect(await ids("category=plumbing&department=sonsonate")).toEqual([c.id]);
    expect(await ids("category=tutoring")).toEqual([]);
  });

  test("q is a case-insensitive substring of the title, and % _ \\ match only themselves", async () => {
    const m = marker();
    const provider = await providerWithProfile(h);
    const percent = await addService(provider, { title: `${m} 100% Garantizado` });
    const underscore = await addService(provider, { title: `${m} a_b` });
    const backslash = await addService(provider, { title: `${m} c\\d` });
    const plain = await addService(provider, { title: `${m} axb 1000 Garantizado` });
    const ids = async (q: string) => (await catalog(`q=${encodeURIComponent(q)}`)).json().services.map((s: { id: string }) => s.id);
    expect(await ids(`${m.toUpperCase()} 100%`)).toEqual([percent.id]);
    expect(await ids(`${m} a_b`)).toEqual([underscore.id]);
    expect(await ids(`c\\d`)).toEqual([backslash.id]);
    expect(await ids(`${m} garantizado`)).toEqual([]);
    expect((await ids(m)).sort()).toEqual([percent.id, underscore.id, backslash.id, plain.id].sort());
  });

  test("keyset pagination returns every row once, including rows with the same created_at", async () => {
    const m = marker();
    const provider = await providerWithProfile(h);
    const created = [];
    for (let i = 0; i < 7; i++) created.push(await addService(provider, { title: `${m} ${i}` }));
    // Three rows share one timestamp, so the order between them comes from id alone.
    await h.owner.query("UPDATE services SET created_at = '2026-01-01 00:00:00.123456+00' WHERE id = ANY($1)", [created.slice(2, 5).map((s) => s.id)]);

    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const res = await catalog(`q=${m}&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      sizes.push(body.services.length);
      seen.push(...body.services.map((s: { id: string }) => s.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([3, 3, 1]);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual(created.map((s) => s.id).sort());

    const all = (await catalog(`q=${m}&limit=50`)).json().services.map((s: { id: string }) => s.id);
    expect(seen).toEqual(all);
  });

  test.each([
    ["limit=51", "querystring/limit"],
    ["limit=0", "querystring/limit"],
    ["category=astrology", "querystring/category"],
    ["department=atlantis", "querystring/department"],
    ["q=", "querystring/q"],
  ])("rejects %s with 400", async (query, path) => {
    const res = await catalog(query);
    expect(res.statusCode).toBe(400);
    expect(errorPaths(res.json())).toContain(path);
  });

  test.each(["nope", Buffer.from('["x","y"]').toString("base64url"), Buffer.from('["2026-13-01 00:00:00+00","00000000-0000-4000-8000-000000000000"]').toString("base64url")])(
    "rejects the cursor %s with 400 INVALID_CURSOR",
    async (cursor) => {
      const res = await catalog(`cursor=${cursor}`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_CURSOR" });
      expect(res.headers["cache-control"]).toBeUndefined();
    },
  );

  test("sends public caching headers and a strong ETag, and answers a matching If-None-Match with 304", async () => {
    const m = marker();
    const provider = await providerWithProfile(h);
    await addService(provider, { title: `${m} uno` });
    const res = await catalog(`q=${m}`);
    expect(res.headers["cache-control"]).toBe("public, max-age=30, stale-while-revalidate=60");
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect((await catalog(`q=${m}`)).headers.etag).toBe(etag);

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const cached = await catalog(`q=${m}`, { "if-none-match": header });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe("");
      expect(cached.headers.etag).toBe(etag);
      expect(cached.headers["cache-control"]).toBe("public, max-age=30, stale-while-revalidate=60");
    }
    expect((await catalog(`q=${m}`, { "if-none-match": '"other"' })).statusCode).toBe(200);

    await addService(provider, { title: `${m} dos` });
    const changed = await catalog(`q=${m}`, { "if-none-match": etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });
});

describe("GET /v1/providers/:id", () => {
  test("returns the profile, active services and a wa.me link with a prefilled message", async () => {
    const provider = await providerWithProfile(h, { whatsappE164: "+50370001234" });
    const kept = await addService(provider, { title: "Limpieza" });
    const dropped = await addService(provider, { title: "Retirado" });
    await h.call(provider, "DELETE", `/v1/providers/me/services/${dropped.id}`);

    const res = await h.call(null, "GET", `/v1/providers/${provider.id}`);
    expect(res.statusCode).toBe(200);
    const { active: _, ...keptPublic } = kept;
    expect(res.json().provider).toEqual({
      id: provider.id,
      displayName: provider.displayName,
      headline: "Fontanería a domicilio",
      bio: "Reparaciones y conexiones.",
      department: "san-salvador",
      municipality: "San Salvador Centro",
      whatsappLink: `https://wa.me/50370001234?text=${encodeURIComponent(`Hola ${provider.displayName}, vi su perfil en ChambaLink.`)}`,
      services: [keptPublic],
    });
    expect(res.headers["cache-control"]).toBe("public, max-age=30, stale-while-revalidate=60");
    expect((await h.call(null, "GET", `/v1/providers/${provider.id}`, undefined, { "if-none-match": res.headers.etag as string })).statusCode).toBe(304);
  });

  test("the link is null without a number, and the route needs no session", async () => {
    const provider = await providerWithProfile(h);
    expect((await h.call(null, "GET", `/v1/providers/${provider.id}`)).json().provider.whatsappLink).toBeNull();
    expect((await h.call(await h.actor("client"), "GET", `/v1/providers/${provider.id}`)).statusCode).toBe(200);
  });

  test("is 404 for an unknown id, a provider without a profile and a client, and 400 for a non-uuid", async () => {
    for (const id of ["00000000-0000-4000-8000-000000000000", (await h.actor("provider")).id, (await h.actor("client")).id]) {
      const res = await h.call(null, "GET", `/v1/providers/${id}`);
      expect(res.statusCode).toBe(404);
      expect(res.headers["cache-control"]).toBeUndefined();
    }
    expect((await h.call(null, "GET", "/v1/providers/abc")).statusCode).toBe(400);
  });
});

describe("GET /v1/providers/:id/slots", () => {
  // Every weekday 08:00-12:00 local, and a 60-minute service.
  async function bookableProvider() {
    const provider = await providerWithProfile(h);
    const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "08:00", end: "12:00" }));
    expect((await h.call(provider, "PUT", "/v1/providers/me/availability", { rules })).statusCode).toBe(200);
    const service = await addService(provider, { durationMinutes: 60 });
    return { provider, service };
  }

  // The local day three days from now, and an instant on it.
  const day = toLocal(new Date(Date.now() + 3 * 86_400_000)).day;
  const local = (minute: number, d = day) => fromLocal(d, minute);
  const slotsUrl = (providerId: string, serviceId: string, from: Date, to: Date) =>
    `/v1/providers/${providerId}/slots?serviceId=${serviceId}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  const getStarts = async (url: string) => (await h.call(null, "GET", url)).json().slots.map((s: { start: string }) => s.start);
  const hhmm = (minute: number) => formatLocal(local(minute));

  test("availability minus time off minus blocking bookings, in 30-minute steps", async () => {
    const { provider, service } = await bookableProvider();
    const url = slotsUrl(provider.id, service.id, local(0), local(24 * 60));
    const res = await h.call(null, "GET", url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=15");
    expect(res.json()).toEqual({
      providerId: provider.id,
      serviceId: service.id,
      durationMinutes: 60,
      timezone: "America/El_Salvador",
      slots: [480, 510, 540, 570, 600, 630, 660].map((m) => ({ start: hhmm(m), end: hhmm(m + 60) })),
    });

    await h.call(provider, "POST", "/v1/providers/me/time-off", { start: local(540).toISOString(), end: local(600).toISOString() });
    const client = await h.actor("client");
    const insertBooking = (start: number, status: string) =>
      h.owner.query("INSERT INTO bookings (provider_id, client_id, during, status) VALUES ($1, $2, tstzrange($3, $4), $5)", [
        provider.id,
        client.id,
        local(start),
        local(start + 60),
        status,
      ]);
    // 11:00-12:00 removes 10:30 and 11:00; 10:00-11:00 only touches it and stays.
    await insertBooking(660, "pending");
    await insertBooking(480, "cancelled");
    expect(await getStarts(url)).toEqual([hhmm(480), hhmm(600)]);
  });

  test("never offers a start within the next hour or beyond 60 days", async () => {
    const { provider, service } = await bookableProvider();
    const now = Date.now();
    const soon = await getStarts(slotsUrl(provider.id, service.id, new Date(now - 86_400_000), new Date(now + 2 * 86_400_000)));
    expect(soon.length).toBeGreaterThan(0);
    for (const s of soon) expect(Date.parse(s)).toBeGreaterThanOrEqual(now + 60 * 60_000);

    const far = await getStarts(slotsUrl(provider.id, service.id, new Date(now + 58 * 86_400_000), new Date(now + 62 * 86_400_000)));
    expect(far.length).toBeGreaterThan(0);
    for (const s of far) expect(Date.parse(s)).toBeLessThanOrEqual(Date.now() + 60 * 86_400_000);
    expect(Math.max(...far.map(Date.parse))).toBeGreaterThan(now + 59 * 86_400_000 - 86_400_000);
  });

  test("rejects a range over 14 days or ending before it starts with 422 INVALID_RANGE", async () => {
    const { provider, service } = await bookableProvider();
    for (const [from, to] of [
      [local(0), local(0, new Date(day.getTime() + 15 * 86_400_000))],
      [local(600), local(540)],
      [local(600), local(600)],
    ] as const) {
      const res = await h.call(null, "GET", slotsUrl(provider.id, service.id, from, to));
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: "INVALID_RANGE" });
      expect(res.headers["cache-control"]).toBeUndefined();
    }
    expect((await h.call(null, "GET", slotsUrl(provider.id, service.id, local(0), local(0, new Date(day.getTime() + 14 * 86_400_000))))).statusCode).toBe(200);
  });

  test("is 404 for an inactive service or another provider's service, and 400 without serviceId", async () => {
    const { provider, service } = await bookableProvider();
    const other = await bookableProvider();
    expect((await h.call(null, "GET", slotsUrl(other.provider.id, service.id, local(0), local(1440)))).statusCode).toBe(404);
    await h.call(provider, "DELETE", `/v1/providers/me/services/${service.id}`);
    expect((await h.call(null, "GET", slotsUrl(provider.id, service.id, local(0), local(1440)))).statusCode).toBe(404);
    const missing = await h.call(null, "GET", `/v1/providers/${provider.id}/slots?from=${local(0).toISOString()}&to=${local(1440).toISOString()}`);
    expect(missing.statusCode).toBe(400);
    expect(errorPaths(missing.json())).toContain("querystring/serviceId");
  });
});
