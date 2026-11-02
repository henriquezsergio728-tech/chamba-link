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

test("the role can read bookings, for the slots query, but cannot write them", async () => {
  await asApp(async (db) => {
    expect((await db.query("SELECT count(*) FROM bookings")).rowCount).toBe(1);
  });
  await rejects("INSERT INTO bookings (provider_id, client_id, during) VALUES (gen_random_uuid(), gen_random_uuid(), 'empty')", /permission denied for table bookings/);
  await rejects("UPDATE bookings SET status = 'cancelled'", /permission denied for table bookings/);
  await rejects("DELETE FROM bookings", /permission denied for table bookings/);
});

// A provider account with a profile, created as the role inside the rolled-back transaction.
async function providerProfile(db: pg.PoolClient) {
  const { rows } = await db.query("INSERT INTO accounts (role, display_name) VALUES ('provider', 'role check') RETURNING id");
  const id: string = rows[0].id;
  await db.query("INSERT INTO provider_profiles (account_id, headline, bio, department, municipality) VALUES ($1, 'h', '', 'la-paz', 'm')", [id]);
  return id;
}

// Runs one statement as the role after setup and returns its error message, or null if it succeeded.
async function attempt(setup: (db: pg.PoolClient) => Promise<string>, statement: (id: string) => [string, unknown[]]) {
  return asApp(async (db) => {
    const id = await setup(db);
    await db.query("SAVEPOINT s");
    try {
      await db.query(...statement(id));
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });
}

test("the role can create a provider profile and update only the columns the API writes", async () => {
  expect(await attempt(providerProfile, (id) => ["UPDATE provider_profiles SET headline = 'x', whatsapp_e164 = '+50370001234', updated_at = now() WHERE account_id = $1", [id]])).toBeNull();
  for (const column of ["account_id = gen_random_uuid()", "role = 'client'", "created_at = now()"]) {
    expect(await attempt(providerProfile, (id) => [`UPDATE provider_profiles SET ${column} WHERE account_id = $1`, [id]])).toMatch(/permission denied for table provider_profiles/);
  }
  expect(await attempt(providerProfile, (id) => ["DELETE FROM provider_profiles WHERE account_id = $1", [id]])).toMatch(/permission denied for table provider_profiles/);
});

const withService = async (db: pg.PoolClient) => {
  const provider = await providerProfile(db);
  const { rows } = await db.query("INSERT INTO services (provider_id, title, description, category, duration_minutes) VALUES ($1, 't', '', 'other', 60) RETURNING id", [provider]);
  return rows[0].id as string;
};

test("the role can create services and update only their editable columns, and cannot delete them", async () => {
  expect(
    await attempt(withService, (id) => ["UPDATE services SET title = 'x', description = 'y', category = 'beauty', price_from_cents = 0, duration_minutes = 30, active = false WHERE id = $1", [id]]),
  ).toBeNull();
  for (const column of ["provider_id = gen_random_uuid()", "created_at = now()", "id = gen_random_uuid()"]) {
    expect(await attempt(withService, (id) => [`UPDATE services SET ${column} WHERE id = $1`, [id]])).toMatch(/permission denied for table services/);
  }
  expect(await attempt(withService, (id) => ["DELETE FROM services WHERE id = $1", [id]])).toMatch(/permission denied for table services/);
});

const withRule = async (db: pg.PoolClient) => {
  const provider = await providerProfile(db);
  await db.query("INSERT INTO availability_rules (provider_id, weekday, start_time, end_time) VALUES ($1, 1, '09:00', '12:00')", [provider]);
  return provider;
};

test("the role can insert, read and delete availability rules, and cannot update them", async () => {
  expect(await attempt(withRule, (id) => ["SELECT * FROM availability_rules WHERE provider_id = $1", [id]])).toBeNull();
  expect(await attempt(withRule, (id) => ["DELETE FROM availability_rules WHERE provider_id = $1", [id]])).toBeNull();
  expect(await attempt(withRule, (id) => ["UPDATE availability_rules SET end_time = '13:00' WHERE provider_id = $1", [id]])).toMatch(
    /permission denied for table availability_rules/,
  );
});

const withTimeOff = async (db: pg.PoolClient) => {
  const provider = await providerProfile(db);
  const { rows } = await db.query("INSERT INTO time_off (provider_id, during) VALUES ($1, '[2030-01-01 00:00+00,2030-01-02 00:00+00)') RETURNING id", [provider]);
  return rows[0].id as string;
};

test("the role can insert, read and delete time off, and cannot update it", async () => {
  expect(await attempt(withTimeOff, (id) => ["SELECT * FROM time_off WHERE id = $1", [id]])).toBeNull();
  expect(await attempt(withTimeOff, (id) => ["DELETE FROM time_off WHERE id = $1", [id]])).toBeNull();
  expect(await attempt(withTimeOff, (id) => ["UPDATE time_off SET during = '[2030-01-01 00:00+00,2030-01-03 00:00+00)' WHERE id = $1", [id]])).toMatch(
    /permission denied for table time_off/,
  );
});

test.each(["provider_profiles", "services", "availability_rules", "time_off"])("the role cannot truncate or drop %s", async (table) => {
  await rejects(`TRUNCATE ${table}`, new RegExp(`permission denied for table ${table}`));
  await rejects(`DROP TABLE ${table}`, new RegExp(`must be owner of table ${table}`));
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
