import { expect, test } from "vitest";
import { buildApp } from "../src/app.js";

// Returns request.ip for a request that arrives from nginx on loopback with the given X-Forwarded-For.
async function ipFor(forwardedFor: string) {
  const app = buildApp();
  app.get("/__ip", async (request) => ({ ip: request.ip }));
  const res = await app.inject({
    method: "GET",
    url: "/__ip",
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-for": forwardedFor },
  });
  await app.close();
  return res.json().ip;
}

test("request.ip is the address nginx forwards", async () => {
  expect(await ipFor("203.0.113.7")).toBe("203.0.113.7");
});

test("a client-supplied X-Forwarded-For entry is ignored", async () => {
  expect(await ipFor("1.2.3.4, 203.0.113.7")).toBe("203.0.113.7");
});
