import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Actor, errorPaths, harness, providerWithProfile, validProfile } from "./harness.js";

const h = harness();

beforeAll(async () => {
  await h.app.ready();
});

afterAll(async () => {
  await h.close();
});

const ANY_ID = "00000000-0000-4000-8000-000000000000";
const service = { title: "Destape de cañerías", description: "Con equipo propio.", category: "plumbing", priceFromCents: 1500, durationMinutes: 60 };

const routes: [method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object][] = [
  ["GET", "/v1/providers/me/profile"],
  ["PUT", "/v1/providers/me/profile", validProfile],
  ["GET", "/v1/providers/me/services"],
  ["POST", "/v1/providers/me/services", service],
  ["PATCH", `/v1/providers/me/services/${ANY_ID}`, { title: "x" }],
  ["DELETE", `/v1/providers/me/services/${ANY_ID}`],
  ["GET", "/v1/providers/me/availability"],
  ["PUT", "/v1/providers/me/availability", { rules: [] }],
  ["GET", "/v1/providers/me/time-off"],
  ["POST", "/v1/providers/me/time-off", { start: "2030-01-01T00:00:00Z", end: "2030-01-02T00:00:00Z" }],
  ["DELETE", `/v1/providers/me/time-off/${ANY_ID}`],
];

describe("authorization", () => {
  test.each(routes)("%s %s is 401 anonymous and 403 for a client, with Cache-Control: no-store", async (method, url, payload) => {
    const anonymous = await h.call(null, method, url, payload);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(anonymous.headers["cache-control"]).toBe("no-store");

    const client = await h.call(await h.actor("client"), method, url, payload);
    expect(client.statusCode).toBe(403);
    expect(client.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
    expect(client.json()).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(client.headers["cache-control"]).toBe("no-store");
  });

  test("another provider's service and time off are 404", async () => {
    const owner = await providerWithProfile(h);
    const other = await providerWithProfile(h);
    const created = (await h.call(owner, "POST", "/v1/providers/me/services", service)).json().service;
    const off = (await h.call(owner, "POST", "/v1/providers/me/time-off", { start: "2030-01-01T00:00:00Z", end: "2030-01-02T00:00:00Z" })).json().timeOff;

    for (const [method, url, payload] of [
      ["PATCH", `/v1/providers/me/services/${created.id}`, { title: "robado" }],
      ["DELETE", `/v1/providers/me/services/${created.id}`, undefined],
      ["DELETE", `/v1/providers/me/time-off/${off.id}`, undefined],
    ] as const) {
      const res = await h.call(other, method, url, payload);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    }
    const mine = (await h.call(owner, "GET", "/v1/providers/me/services")).json().services;
    expect(mine).toEqual([created]);
    expect((await h.call(other, "GET", "/v1/providers/me/services")).json().services).toEqual([]);
    expect((await h.call(owner, "GET", "/v1/providers/me/time-off")).json().timeOff).toEqual([off]);
  });

  test("successful responses carry Cache-Control: no-store too", async () => {
    const provider = await providerWithProfile(h);
    for (const url of ["/v1/providers/me/profile", "/v1/providers/me/services", "/v1/providers/me/availability", "/v1/providers/me/time-off"]) {
      const res = await h.call(provider, "GET", url);
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });
});

describe("profile", () => {
  test("GET is 404 before the first PUT; PUT creates and replaces the profile", async () => {
    const provider = await h.actor("provider", "Marta Pérez");
    const missing = await h.call(provider, "GET", "/v1/providers/me/profile");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "PROFILE_NOT_FOUND" });

    const created = await h.call(provider, "PUT", "/v1/providers/me/profile", { ...validProfile, whatsappE164: "+50370001234" });
    expect(created.statusCode).toBe(200);
    const profile = created.json().profile;
    expect(profile).toEqual({
      accountId: provider.id,
      displayName: "Marta Pérez",
      ...validProfile,
      whatsappE164: "+50370001234",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-06:00$/),
      updatedAt: expect.stringMatching(/-06:00$/),
    });
    expect((await h.call(provider, "GET", "/v1/providers/me/profile")).json()).toEqual({ profile });

    // PUT replaces: an omitted number is removed.
    const replaced = (await h.call(provider, "PUT", "/v1/providers/me/profile", { ...validProfile, headline: "Electricista" })).json().profile;
    expect(replaced).toMatchObject({ headline: "Electricista", whatsappE164: null, createdAt: profile.createdAt });
    const explicit = await h.call(provider, "PUT", "/v1/providers/me/profile", { ...validProfile, whatsappE164: null });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().profile.whatsappE164).toBeNull();
  });

  test.each([
    ["an unknown department", { department: "atlantis" }, "body/department"],
    ["an empty headline", { headline: "" }, "body/headline"],
    ["a headline over 120 characters", { headline: "a".repeat(121) }, "body/headline"],
    ["a bio over 2000 characters", { bio: "a".repeat(2001) }, "body/bio"],
    ["a number without +", { whatsappE164: "50370001234" }, "body/whatsappE164"],
    ["a number with spaces", { whatsappE164: "+503 7000 1234" }, "body/whatsappE164"],
    ["a number starting with 0", { whatsappE164: "+0370001234" }, "body/whatsappE164"],
    ["a missing municipality", { municipality: undefined }, "body/municipality"],
  ])("PUT rejects %s with 400", async (_, overrides, path) => {
    const res = await h.call(await h.actor("provider"), "PUT", "/v1/providers/me/profile", { ...validProfile, ...overrides });
    expect(res.statusCode).toBe(400);
    expect(errorPaths(res.json())).toContain(path);
  });

  test("services, availability and time off need a profile first: 409 PROFILE_REQUIRED", async () => {
    const provider = await h.actor("provider");
    for (const [method, url, payload] of [
      ["POST", "/v1/providers/me/services", service],
      ["PUT", "/v1/providers/me/availability", { rules: [] }],
      ["POST", "/v1/providers/me/time-off", { start: "2030-01-01T00:00:00Z", end: "2030-01-02T00:00:00Z" }],
    ] as const) {
      const res = await h.call(provider, method, url, payload);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "PROFILE_REQUIRED" });
    }
    expect(await h.auditRows(provider.ip)).toEqual([]);
  });

  test("the database accepts a profile only for a provider account", async () => {
    const client = await h.actor("client");
    const insert = (role: string) =>
      h.owner.query("INSERT INTO provider_profiles (account_id, role, headline, bio, department, municipality) VALUES ($1, $2, 'h', '', 'la-paz', 'm')", [
        client.id,
        role,
      ]);
    await expect(insert("provider")).rejects.toMatchObject({ code: "23503", constraint: "provider_profiles_account_fkey" });
    await expect(insert("client")).rejects.toMatchObject({ code: "23514", constraint: "provider_profiles_role_provider" });
  });
});

describe("services", () => {
  let provider: Actor;
  beforeAll(async () => {
    provider = await providerWithProfile(h);
  });

  test("POST creates, GET lists, PATCH edits and DELETE deactivates", async () => {
    const res = await h.call(provider, "POST", "/v1/providers/me/services", service);
    expect(res.statusCode).toBe(201);
    const created = res.json().service;
    expect(created).toEqual({ id: expect.any(String), ...service, currency: "USD", active: true, createdAt: expect.stringMatching(/-06:00$/) });

    const patched = await h.call(provider, "PATCH", `/v1/providers/me/services/${created.id}`, { priceFromCents: null, durationMinutes: 90 });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().service).toEqual({ ...created, priceFromCents: null, durationMinutes: 90 });

    const deleted = await h.call(provider, "DELETE", `/v1/providers/me/services/${created.id}`);
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect((await h.call(provider, "DELETE", `/v1/providers/me/services/${created.id}`)).statusCode).toBe(204);
    const listed = (await h.call(provider, "GET", "/v1/providers/me/services")).json().services;
    expect(listed.find((s: { id: string }) => s.id === created.id)).toMatchObject({ active: false, durationMinutes: 90 });
  });

  test("description and price are optional", async () => {
    const res = await h.call(provider, "POST", "/v1/providers/me/services", { title: "Corte", category: "beauty", durationMinutes: 30 });
    expect(res.statusCode).toBe(201);
    expect(res.json().service).toMatchObject({ description: "", priceFromCents: null });
  });

  // Fastify's Ajv coerces types; a nullable integer must keep 0 as 0 and null as null.
  test("a price of 0 stays 0 and an explicit null stays null", async () => {
    const zero = await h.call(provider, "POST", "/v1/providers/me/services", { ...service, priceFromCents: 0 });
    expect(zero.json().service.priceFromCents).toBe(0);
    const none = await h.call(provider, "POST", "/v1/providers/me/services", { ...service, priceFromCents: null });
    expect(none.json().service.priceFromCents).toBeNull();
    const patched = await h.call(provider, "PATCH", `/v1/providers/me/services/${none.json().service.id}`, { priceFromCents: 0 });
    expect(patched.json().service.priceFromCents).toBe(0);
  });

  test.each([
    ["a duration that is not a multiple of 30", { durationMinutes: 45 }, "body/durationMinutes"],
    ["a duration under 30", { durationMinutes: 0 }, "body/durationMinutes"],
    ["a duration over 480", { durationMinutes: 510 }, "body/durationMinutes"],
    ["a negative price", { priceFromCents: -1 }, "body/priceFromCents"],
    ["a fractional price", { priceFromCents: 10.5 }, "body/priceFromCents"],
    ["an unknown category", { category: "astrology" }, "body/category"],
    ["an empty title", { title: "" }, "body/title"],
  ])("POST rejects %s with 400", async (_, overrides, path) => {
    const res = await h.call(provider, "POST", "/v1/providers/me/services", { ...service, ...overrides });
    expect(res.statusCode).toBe(400);
    expect(errorPaths(res.json())).toContain(path);
  });

  test("PATCH rejects an empty body, and an id that is not a uuid", async () => {
    const created = (await h.call(provider, "POST", "/v1/providers/me/services", service)).json().service;
    expect((await h.call(provider, "PATCH", `/v1/providers/me/services/${created.id}`, {})).statusCode).toBe(400);
    const bad = await h.call(provider, "PATCH", "/v1/providers/me/services/not-a-uuid", { title: "x" });
    expect(bad.statusCode).toBe(400);
    expect(errorPaths(bad.json())).toContain("params/id");
  });
});

describe("availability", () => {
  test("PUT replaces the weekly rules atomically and GET returns them sorted", async () => {
    const provider = await providerWithProfile(h);
    const first = await h.call(provider, "PUT", "/v1/providers/me/availability", {
      rules: [
        { weekday: 3, start: "14:00", end: "18:00" },
        { weekday: 1, start: "08:00", end: "12:00" },
        { weekday: 1, start: "12:00", end: "24:00" },
      ],
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      timezone: "America/El_Salvador",
      rules: [
        { weekday: 1, start: "08:00", end: "12:00" },
        { weekday: 1, start: "12:00", end: "24:00" },
        { weekday: 3, start: "14:00", end: "18:00" },
      ],
    });
    const second = await h.call(provider, "PUT", "/v1/providers/me/availability", { rules: [{ weekday: 0, start: "09:30", end: "10:00" }] });
    expect(second.json().rules).toEqual([{ weekday: 0, start: "09:30", end: "10:00" }]);
    expect((await h.call(provider, "GET", "/v1/providers/me/availability")).json()).toEqual(second.json());

    // A rejected replace leaves the previous rules in place.
    const rejected = await h.call(provider, "PUT", "/v1/providers/me/availability", {
      rules: [
        { weekday: 2, start: "09:00", end: "11:00" },
        { weekday: 2, start: "10:00", end: "12:00" },
      ],
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ code: "OVERLAPPING_RULES" });
    expect((await h.call(provider, "GET", "/v1/providers/me/availability")).json()).toEqual(second.json());

    expect((await h.call(provider, "PUT", "/v1/providers/me/availability", { rules: [] })).json().rules).toEqual([]);
  });

  test.each([
    ["an end before the start", [{ weekday: 1, start: "12:00", end: "09:00" }], 422, "INVALID_RULE"],
    ["an empty rule", [{ weekday: 1, start: "12:00", end: "12:00" }], 422, "INVALID_RULE"],
    ["the same start twice", [{ weekday: 1, start: "09:00", end: "10:00" }, { weekday: 1, start: "09:00", end: "11:00" }], 422, "OVERLAPPING_RULES"],
    ["a time off the half-hour grid", [{ weekday: 1, start: "09:15", end: "10:00" }], 400, undefined],
    ["a start of 24:00", [{ weekday: 1, start: "24:00", end: "24:00" }], 400, undefined],
    ["weekday 7", [{ weekday: 7, start: "09:00", end: "10:00" }], 400, undefined],
  ])("PUT rejects %s", async (_, rules, status, code) => {
    const res = await h.call(await providerWithProfile(h), "PUT", "/v1/providers/me/availability", { rules });
    expect(res.statusCode).toBe(status);
    if (code) expect(res.json()).toMatchObject({ code });
  });

  test("the database rejects overlapping rules for one provider and weekday", async () => {
    const provider = await providerWithProfile(h);
    const insert = (weekday: number, start: string, end: string) =>
      h.owner.query("INSERT INTO availability_rules (provider_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)", [provider.id, weekday, start, end]);
    await insert(1, "09:00", "12:00");
    await insert(1, "12:00", "13:00");
    await insert(2, "10:00", "11:00");
    await expect(insert(1, "11:30", "14:00")).rejects.toMatchObject({ code: "23P01", constraint: "availability_rules_no_overlap" });
    await expect(insert(1, "15:00", "14:00")).rejects.toMatchObject({ code: "23514", constraint: "availability_rules_end_after_start" });
  });
});

describe("time off", () => {
  test("POST creates, GET lists entries that have not ended, DELETE removes", async () => {
    const provider = await providerWithProfile(h);
    const res = await h.call(provider, "POST", "/v1/providers/me/time-off", { start: "2030-01-01T08:00:00-06:00", end: "2030-01-01T20:00:00Z" });
    expect(res.statusCode).toBe(201);
    const off = res.json().timeOff;
    expect(off).toEqual({ id: expect.any(String), start: "2030-01-01T08:00:00-06:00", end: "2030-01-01T14:00:00-06:00", createdAt: expect.stringMatching(/-06:00$/) });

    await h.owner.query("INSERT INTO time_off (provider_id, during) VALUES ($1, '[2020-01-01 00:00+00,2020-01-02 00:00+00)')", [provider.id]);
    expect((await h.call(provider, "GET", "/v1/providers/me/time-off")).json().timeOff).toEqual([off]);

    expect((await h.call(provider, "DELETE", `/v1/providers/me/time-off/${off.id}`)).statusCode).toBe(204);
    expect((await h.call(provider, "GET", "/v1/providers/me/time-off")).json().timeOff).toEqual([]);
    expect((await h.call(provider, "DELETE", `/v1/providers/me/time-off/${off.id}`)).statusCode).toBe(404);
  });

  test.each([
    ["an end before the start", { start: "2030-01-02T00:00:00Z", end: "2030-01-01T00:00:00Z" }, 422],
    ["an empty range", { start: "2030-01-01T00:00:00Z", end: "2030-01-01T00:00:00Z" }, 422],
    ["a timestamp without an offset", { start: "2030-01-01T00:00:00", end: "2030-01-02T00:00:00Z" }, 400],
    ["a missing end", { start: "2030-01-01T00:00:00Z" }, 400],
  ])("POST rejects %s", async (_, payload, status) => {
    const res = await h.call(await providerWithProfile(h), "POST", "/v1/providers/me/time-off", payload);
    expect(res.statusCode).toBe(status);
    if (status === 422) expect(res.json()).toMatchObject({ code: "INVALID_RANGE" });
  });
});

test("every change writes one audit event with ids only, never the provider's text", async () => {
  const provider = await h.actor("provider");
  const secretText = "texto-libre-que-no-debe-auditarse";
  await h.call(provider, "PUT", "/v1/providers/me/profile", { ...validProfile, headline: secretText, whatsappE164: "+50370009999" });
  const created = (await h.call(provider, "POST", "/v1/providers/me/services", { ...service, title: secretText })).json().service;
  await h.call(provider, "PATCH", `/v1/providers/me/services/${created.id}`, { description: secretText });
  await h.call(provider, "DELETE", `/v1/providers/me/services/${created.id}`);
  await h.call(provider, "DELETE", `/v1/providers/me/services/${created.id}`);
  await h.call(provider, "PUT", "/v1/providers/me/availability", { rules: [{ weekday: 1, start: "09:00", end: "10:00" }] });
  const off = (await h.call(provider, "POST", "/v1/providers/me/time-off", { start: "2030-01-01T00:00:00Z", end: "2030-01-02T00:00:00Z" })).json().timeOff;
  await h.call(provider, "DELETE", `/v1/providers/me/time-off/${off.id}`);

  const rows = await h.auditRows(provider.ip);
  expect(rows).toEqual([
    { event: "provider.profile.updated", actor_account_id: provider.id, metadata: {} },
    { event: "provider.service.created", actor_account_id: provider.id, metadata: { serviceId: created.id } },
    { event: "provider.service.updated", actor_account_id: provider.id, metadata: { serviceId: created.id } },
    { event: "provider.service.deactivated", actor_account_id: provider.id, metadata: { serviceId: created.id } },
    { event: "provider.availability.replaced", actor_account_id: provider.id, metadata: {} },
    { event: "provider.time_off.created", actor_account_id: provider.id, metadata: { timeOffId: off.id } },
    { event: "provider.time_off.deleted", actor_account_id: provider.id, metadata: { timeOffId: off.id } },
  ]);
  expect(JSON.stringify(rows)).not.toContain(secretText);
  expect(JSON.stringify(rows)).not.toContain("70009999");
});
