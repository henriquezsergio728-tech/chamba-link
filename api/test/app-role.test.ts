import { config } from "dotenv";
import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { APP_ROLE } from "./app-role.js";

config({ path: "../.env" });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

// Runs fn as APP_ROLE inside a transaction that is always rolled back, so no check leaves rows or objects behind.
async function asApp<T>(fn: (db: pg.PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`SET LOCAL ROLE ${APP_ROLE}`);
    return await fn(db);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
}

const rejects = (sql: string, message: RegExp) => expect(asApp((db) => db.query(sql))).rejects.toThrow(message);

test("the role can insert and read accounts", async () => {
  await asApp(async (db) => {
    const { rows } = await db.query("INSERT INTO accounts (role, display_name) VALUES ('client', 'role check') RETURNING id");
    const read = await db.query("SELECT display_name FROM accounts WHERE id = $1", [rows[0].id]);
    expect(read.rows).toEqual([{ display_name: "role check" }]);
  });
});

test("the role can append to audit_log", async () => {
  await asApp(async (db) => {
    const { rowCount } = await db.query("INSERT INTO audit_log (event) VALUES ('role.check')");
    expect(rowCount).toBe(1);
  });
});

test("the role cannot change or remove audit rows", async () => {
  await rejects("UPDATE audit_log SET event = 'tampered'", /permission denied for table audit_log/);
  await rejects("DELETE FROM audit_log", /permission denied for table audit_log/);
});

test("the role cannot disable the audit trigger or drop the table", async () => {
  await rejects("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only", /must be owner of table audit_log/);
  await rejects("DROP TABLE audit_log", /must be owner of table audit_log/);
});

test("the role cannot read bookings, which the API does not use", async () => {
  await rejects("SELECT * FROM bookings", /permission denied for table bookings/);
});

test("a table created later gives the role no privileges", async () => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Created as the connecting user, before the role switch, inside the transaction that is rolled back.
    await db.query("CREATE TABLE public.role_check_future (id int)");
    await db.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await expect(db.query("SELECT * FROM public.role_check_future")).rejects.toThrow(/permission denied for table role_check_future/);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

test("the role cannot create tables, truncate, read migration history or create extensions", async () => {
  await rejects("CREATE TABLE public.role_check (id int)", /permission denied for schema public/);
  await rejects("TRUNCATE sessions", /permission denied for table sessions/);
  await rejects("SELECT * FROM drizzle.__drizzle_migrations", /permission denied for schema drizzle/);
  await rejects("CREATE EXTENSION pgcrypto", /permission denied to create extension "pgcrypto"/);
});
