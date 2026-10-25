import { DrizzleQueryError } from "drizzle-orm";
import { Type } from "typebox";
import { afterAll, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { AppError, describeError } from "../src/errors.js";

const app = buildApp();
app.get("/__app-error", async () => {
  throw new AppError({ status: 409, code: "SLOT_TAKEN", title: "Conflict", detail: "The slot is already booked", extensions: { slot: "a" } });
});
app.get("/__app-error-5xx", async () => {
  throw new AppError({ status: 503, code: "DOWN", title: "Unavailable", detail: "internal detail from an AppError" });
});
app.get("/__crash", async () => {
  throw new Error("connection to db-secret-host failed");
});
app.post("/__echo", { schema: { body: Type.Object({ name: Type.String(), age: Type.Integer() }) } }, async (request) => request.body);

afterAll(async () => {
  await app.close();
});

test("an AppError becomes problem+json with its status, title, detail and code", async () => {
  const res = await app.inject({ method: "GET", url: "/__app-error?x=1" });
  expect(res.statusCode).toBe(409);
  expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
  expect(res.json()).toEqual({
    type: "about:blank",
    title: "Conflict",
    status: 409,
    detail: "The slot is already booked",
    instance: "/__app-error?x=1",
    requestId: res.headers["x-request-id"],
    code: "SLOT_TAKEN",
    slot: "a",
  });
});

test("an unknown error is a generic 500 that leaks no message or stack", async () => {
  const res = await app.inject({ method: "GET", url: "/__crash" });
  expect(res.statusCode).toBe(500);
  expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
  expect(res.json()).toEqual({
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    detail: "Internal Server Error",
    instance: "/__crash",
    requestId: res.headers["x-request-id"],
  });
  expect(res.body).not.toContain("db-secret-host");
  expect(res.body).not.toContain("stack");
});

test("a 5xx AppError is also returned as a generic 500", async () => {
  const res = await app.inject({ method: "GET", url: "/__app-error-5xx" });
  expect(res.statusCode).toBe(500);
  expect(res.json().detail).toBe("Internal Server Error");
  expect(res.body).not.toContain("internal detail");
});

test("a validation error is a 400 with an errors array", async () => {
  const res = await app.inject({ method: "POST", url: "/__echo", payload: { age: "old" } });
  expect(res.statusCode).toBe(400);
  expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
  const body = res.json();
  expect(body).toMatchObject({ type: "about:blank", title: "Bad Request", status: 400, instance: "/__echo" });
  expect(body.errors.length).toBeGreaterThan(0);
  for (const error of body.errors) expect(error).toEqual({ path: expect.any(String), message: expect.any(String) });
  expect(body.errors.map((e: { path: string }) => e.path)).toContain("body/name");
});

test("a malformed JSON body is a 400 problem, not a 500", async () => {
  const res = await app.inject({ method: "POST", url: "/__echo", headers: { "content-type": "application/json" }, payload: "{" });
  expect(res.statusCode).toBe(400);
  expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
  expect(res.json()).toMatchObject({ status: 400, title: "Bad Request" });
});

test("an unknown route is a 404 problem", async () => {
  const res = await app.inject({ method: "GET", url: "/nope?q=1" });
  expect(res.statusCode).toBe(404);
  expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
  expect(res.json()).toEqual({
    type: "about:blank",
    title: "Not Found",
    status: 404,
    detail: "Route GET /nope not found",
    instance: "/nope?q=1",
    requestId: res.headers["x-request-id"],
  });
});

test("describeError keeps a database error's code and constraint and drops the query, params and detail", () => {
  const email = "probe@example.test";
  const hash = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
  const accountId = "00000000-0000-4000-8000-000000000000";
  const cause = Object.assign(new Error('insert or update on table "account_credentials" violates foreign key constraint "account_credentials_account_id_accounts_id_fkey"'), {
    code: "23503",
    constraint: "account_credentials_account_id_accounts_id_fkey",
    table: "account_credentials",
    schema: "public",
    detail: `Key (account_id)=(${accountId}) is not present in table "accounts".`,
  });
  const err = new DrizzleQueryError('insert into "account_credentials" ("account_id", "email", "password_hash") values ($1, $2, $3)', [accountId, email, hash], cause);

  const described = describeError(err);
  expect(described).toEqual({
    name: "DrizzleQueryError",
    cause: { code: "23503", constraint: "account_credentials_account_id_accounts_id_fkey", table: "account_credentials", schema: "public", message: cause.message },
  });
  const serialized = JSON.stringify(described);
  for (const value of [email, hash, accountId, "detail", "params", "query", "Failed query"]) expect(serialized).not.toContain(value);
});

test("describeError returns any other error unchanged", () => {
  const err = new Error("connection to db-secret-host failed");
  expect(describeError(err)).toBe(err);
  expect((describeError(err) as Error).message).toBe("connection to db-secret-host failed");
});
