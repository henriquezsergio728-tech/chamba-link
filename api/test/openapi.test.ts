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
