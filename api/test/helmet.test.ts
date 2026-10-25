import { expect, test } from "vitest";
import { buildApp } from "../src/app.js";

test("security headers are set without HSTS or CSP", async () => {
  const app = buildApp();
  for (const url of ["/healthz", "/missing"]) {
    const res = await app.inject({ method: "GET", url });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeUndefined();
  }
  await app.close();
});
