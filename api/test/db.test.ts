import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { dbPlugin } from "../src/db.js";

config({ path: "../.env" });

test("app.db runs queries and app.close() ends the pool", async () => {
  const app = buildApp();
  app.register(dbPlugin, { connectionString: process.env.DATABASE_URL! });
  await app.ready();

  const result = await app.db.execute(sql`SELECT 1 AS one`);
  expect(result.rows).toEqual([{ one: 1 }]);
  expect(app.pg.ended).toBe(false);

  await app.close();
  expect(app.pg.ended).toBe(true);
});

test("a route registered before dbPlugin can query app.db, as in server.ts", async () => {
  const app = buildApp();
  app.register(async (routes) => {
    routes.get("/__db", async () => {
      const result = await app.db.execute(sql`SELECT 1 AS one`);
      return result.rows[0];
    });
  });
  app.register(dbPlugin, { connectionString: process.env.DATABASE_URL! });
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/__db" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ one: 1 });
  await app.close();
});

test("an idle client error on the pool is handled instead of thrown", async () => {
  const app = buildApp();
  app.register(dbPlugin, { connectionString: "postgres://nobody:nothing@127.0.0.1:1/none" });
  await app.ready();
  expect(app.pg.listenerCount("error")).toBeGreaterThan(0);
  expect(() => app.pg.emit("error", new Error("boom"))).not.toThrow();
  await app.close();
});

test("registering the plugin does not connect until a query runs", async () => {
  const app = buildApp();
  app.register(dbPlugin, { connectionString: "postgres://nobody:nothing@127.0.0.1:1/none" });
  await app.ready();
  expect(app.pg.totalCount).toBe(0);
  const res = await app.inject({ method: "GET", url: "/healthz" });
  expect(res.statusCode).toBe(200);
  await app.close();
});
