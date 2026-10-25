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
