import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';

config({ path: '../.env' });

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const ids: Record<string, string> = {};

// Returns null if the insert succeeded, otherwise the Postgres error code.
async function tryInsert(provider: string, during: string, status = 'pending') {
  await db.query('SAVEPOINT attempt');
  try {
    await db.query(
      // Every booking needs a service; a pending one also needs expires_at (bookings_pending_expires).
      `INSERT INTO bookings (provider_id, client_id, service_id, during, status, expires_at)
       VALUES ($1, $2, (SELECT id FROM services WHERE provider_id = $1), $3, $4, now() + interval '1 day')`,
      [ids[provider], ids.client, during, status],
    );
    await db.query('RELEASE SAVEPOINT attempt');
    return null;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT attempt');
    return (err as { code?: string }).code ?? 'unknown';
  }
}

beforeAll(async () => {
  await db.connect();
  await db.query('BEGIN');
  const { rows } = await db.query(
    `INSERT INTO accounts (role, display_name) VALUES ('provider', 'A'), ('provider', 'B'), ('client', 'C') RETURNING id, display_name`,
  );
  for (const row of rows) ids[row.display_name === 'C' ? 'client' : row.display_name] = row.id;
  for (const provider of ['A', 'B']) {
    await db.query(`INSERT INTO provider_profiles (account_id, headline, bio, department, municipality) VALUES ($1, 'h', '', 'la-paz', 'm')`, [ids[provider]]);
    await db.query(`INSERT INTO services (provider_id, title, description, category, duration_minutes) VALUES ($1, 't', '', 'other', 60)`, [ids[provider]]);
  }
});

afterAll(async () => {
  await db.query('ROLLBACK');
  await db.end();
});

test('rejects an overlapping booking for the same provider', async () => {
  expect(await tryInsert('A', '[2026-11-02 09:00+00,2026-11-02 10:00+00)')).toBeNull();
  expect(await tryInsert('A', '[2026-11-02 09:30+00,2026-11-02 10:30+00)')).toBe('23P01');
});

test('allows back-to-back bookings (ranges are half-open)', async () => {
  expect(await tryInsert('A', '[2026-11-03 09:00+00,2026-11-03 10:00+00)')).toBeNull();
  expect(await tryInsert('A', '[2026-11-03 10:00+00,2026-11-03 11:00+00)')).toBeNull();
});

test('allows the same slot for a different provider', async () => {
  expect(await tryInsert('A', '[2026-11-04 09:00+00,2026-11-04 10:00+00)')).toBeNull();
  expect(await tryInsert('B', '[2026-11-04 09:00+00,2026-11-04 10:00+00)')).toBeNull();
});

test('a cancelled booking does not block the slot', async () => {
  expect(await tryInsert('A', '[2026-11-05 09:00+00,2026-11-05 10:00+00)', 'cancelled')).toBeNull();
  expect(await tryInsert('A', '[2026-11-05 09:00+00,2026-11-05 10:00+00)')).toBeNull();
});

test('rejects empty and unbounded ranges', async () => {
  expect(await tryInsert('A', 'empty')).toBe('23514');
  expect(await tryInsert('A', '[2026-11-06 09:00+00,)')).toBe('23514');
  expect(await tryInsert('A', '(,2026-11-06 10:00+00)')).toBe('23514');
});

test('a confirmed booking blocks an overlapping pending one', async () => {
  expect(await tryInsert('A', '[2026-11-07 09:00+00,2026-11-07 10:00+00)', 'confirmed')).toBeNull();
  expect(await tryInsert('A', '[2026-11-07 09:30+00,2026-11-07 10:30+00)')).toBe('23P01');
});

test('declined and expired bookings do not block the slot', async () => {
  expect(await tryInsert('A', '[2026-11-08 09:00+00,2026-11-08 10:00+00)', 'declined')).toBeNull();
  expect(await tryInsert('A', '[2026-11-08 09:00+00,2026-11-08 10:00+00)', 'expired')).toBeNull();
  expect(await tryInsert('A', '[2026-11-08 09:00+00,2026-11-08 10:00+00)')).toBeNull();
});

test('a completed booking blocks an overlapping one', async () => {
  expect(await tryInsert('A', '[2026-11-09 09:00+00,2026-11-09 10:00+00)', 'completed')).toBeNull();
  expect(await tryInsert('A', '[2026-11-09 09:30+00,2026-11-09 10:30+00)', 'confirmed')).toBe('23P01');
});

test('a pending booking without expires_at is rejected', async () => {
  await db.query('SAVEPOINT attempt');
  const code = await db
    .query(`INSERT INTO bookings (provider_id, client_id, service_id, during) VALUES ($1, $2, (SELECT id FROM services WHERE provider_id = $1), '[2026-11-10 09:00+00,2026-11-10 10:00+00)')`, [ids.A, ids.client])
    .then(() => null, (err: { code?: string }) => err.code);
  await db.query('ROLLBACK TO SAVEPOINT attempt');
  expect(code).toBe('23514');
});
