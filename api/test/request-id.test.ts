import { afterAll, expect, test } from "vitest";
import { buildApp } from "../src/app.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const app = buildApp();
app.get("/__id", async (request) => ({ id: request.id }));

afterAll(async () => {
  await app.close();
});

test("a valid incoming x-request-id is used and echoed", async () => {
  const res = await app.inject({ method: "GET", url: "/__id", headers: { "x-request-id": "edge-abc.123_XYZ" } });
  expect(res.headers["x-request-id"]).toBe("edge-abc.123_XYZ");
  expect(res.json().id).toBe("edge-abc.123_XYZ");
});

test("a request without x-request-id gets a UUID", async () => {
  const res = await app.inject({ method: "GET", url: "/__id" });
  expect(res.headers["x-request-id"]).toMatch(UUID);
  expect(res.json().id).toBe(res.headers["x-request-id"]);
});

test.each([
  ["too short", "abc1234"],
  ["too long", "a".repeat(65)],
  ["with spaces", "abc def ghi"],
  ["with a newline", "abcdefgh\nINFO forged"],
  ["with other characters", "abcdefgh;rm"],
])("an incoming id %s is replaced by a UUID", async (_, id) => {
  const res = await app.inject({ method: "GET", url: "/__id", headers: { "x-request-id": id } });
  expect(res.headers["x-request-id"]).toMatch(UUID);
});

test("the header is present on error responses", async () => {
  const res = await app.inject({ method: "GET", url: "/missing", headers: { "x-request-id": "trace-0001" } });
  expect(res.statusCode).toBe(404);
  expect(res.headers["x-request-id"]).toBe("trace-0001");
  expect(res.json().requestId).toBe("trace-0001");
});
