import { expect, test } from "vitest";
import { poolOptions } from "../src/db.js";

test("the pool is capped at DB_POOL_MAX and connection attempts time out after 5 s", () => {
  expect(poolOptions("postgres://app@db.internal:5432/app", 7)).toEqual({
    connectionString: "postgres://app@db.internal:5432/app",
    max: 7,
    connectionTimeoutMillis: 5000,
  });
});
