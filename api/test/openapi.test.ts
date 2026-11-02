import { expect, test } from "vitest";
import { buildApp } from "../src/app.js";

test("GET /v1/openapi.json returns the generated document", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
  expect(res.statusCode).toBe(200);
  const doc = res.json();
  expect(doc.openapi).toMatch(/^3\./);
  expect(doc.paths).toHaveProperty("/healthz");
  expect(doc.paths["/healthz"].get.responses).toHaveProperty("200");
  expect(doc.paths).not.toHaveProperty("/v1/openapi.json");
  await app.close();
});

test("the auth routes appear in the document, and /v1/me requires the session cookie", async () => {
  const app = buildApp();
  const doc = (await app.inject({ method: "GET", url: "/v1/openapi.json" })).json();
  for (const path of ["/v1/auth/register", "/v1/auth/login", "/v1/auth/logout"]) expect(doc.paths[path]).toHaveProperty("post");
  expect(doc.paths["/v1/me"]).toHaveProperty("get");
  expect(doc.paths["/v1/me"].get.security).toEqual([{ cookieAuth: [] }]);
  expect(doc.components.securitySchemes.cookieAuth).toEqual({ type: "apiKey", in: "cookie", name: "session" });
  await app.close();
});

test("register and login document the 429 response", async () => {
  const app = buildApp();
  const doc = (await app.inject({ method: "GET", url: "/v1/openapi.json" })).json();
  for (const path of ["/v1/auth/register", "/v1/auth/login"]) {
    const schema = doc.paths[path].post.responses["429"].content["application/problem+json"].schema;
    expect(schema.properties.code).toMatchObject({ enum: ["RATE_LIMITED"] });
    expect(schema.required).toContain("retryAfterSeconds");
  }
  await app.close();
});

test("the provider routes require the session cookie and the catalog routes do not", async () => {
  const app = buildApp();
  const doc = (await app.inject({ method: "GET", url: "/v1/openapi.json" })).json();
  const own = {
    "/v1/providers/me/profile": ["get", "put"],
    "/v1/providers/me/services": ["get", "post"],
    "/v1/providers/me/services/{id}": ["patch", "delete"],
    "/v1/providers/me/availability": ["get", "put"],
    "/v1/providers/me/time-off": ["get", "post"],
    "/v1/providers/me/time-off/{id}": ["delete"],
  };
  for (const [path, methods] of Object.entries(own)) {
    for (const method of methods) expect(doc.paths[path][method].security).toEqual([{ cookieAuth: [] }]);
  }
  for (const path of ["/v1/services", "/v1/providers/{id}", "/v1/providers/{id}/slots"]) {
    expect(doc.paths[path].get).toBeDefined();
    expect(doc.paths[path].get.security).toBeUndefined();
  }
  // Nullable fields are type arrays, so Ajv's type coercion cannot turn a null into 0.
  const price = doc.paths["/v1/providers/me/services"].post.requestBody.content["application/json"].schema.properties.priceFromCents;
  expect(price.type).toEqual(["integer", "null"]);
  await app.close();
});

test("the booking routes require the session cookie, and POST /v1/bookings documents the 429 response", async () => {
  const app = buildApp();
  const doc = (await app.inject({ method: "GET", url: "/v1/openapi.json" })).json();
  const routes = {
    "/v1/bookings": ["get", "post"],
    "/v1/bookings/{id}": ["get"],
    "/v1/bookings/{id}/confirm": ["post"],
    "/v1/bookings/{id}/decline": ["post"],
    "/v1/bookings/{id}/cancel": ["post"],
    "/v1/bookings/{id}/complete": ["post"],
  };
  for (const [path, methods] of Object.entries(routes)) {
    for (const method of methods) expect(doc.paths[path][method].security).toEqual([{ cookieAuth: [] }]);
  }
  const schema = doc.paths["/v1/bookings"].post.responses["429"].content["application/problem+json"].schema;
  expect(schema.properties.code).toMatchObject({ enum: ["RATE_LIMITED"] });
  expect(schema.required).toContain("retryAfterSeconds");
  await app.close();
});
