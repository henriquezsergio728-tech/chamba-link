import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, expect, test } from 'vitest';

config({ path: '../.env' });

// Unlike booking-overlap.test.ts, these tests commit on separate connections, so every row is deleted in afterAll.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 25 });
const accountIds: string[] = [];

const insertSql = 'INSERT INTO bookings (provider_id, client_id, during) VALUES ($1, $2, $3)';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Creates and commits a fresh provider and client so tests never share rows.
async function createAccounts() {
  const { rows } = await pool.query(
    `INSERT INTO accounts (role, display_name) VALUES ('provider', 'concurrency provider'), ('client', 'concurrency client') RETURNING id, role`,
  );
  for (const row of rows) accountIds.push(row.id);
  return {
    provider: rows.find((row) => row.role === 'provider')!.id as string,
    client: rows.find((row) => row.role === 'client')!.id as string,
  };
}

// Resolves to null if the insert succeeded, otherwise the Postgres error code. Never rejects.
function tryInsert(conn: pg.ClientBase, values: string[]) {
  return conn.query(insertSql, values).then(
    () => null,
    (err: { code?: string }) => err.code ?? 'unknown',
  );
}

afterAll(async () => {
  await pool.query('DELETE FROM bookings WHERE provider_id = ANY($1) OR client_id = ANY($1)', [accountIds]);
  await pool.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
  await pool.end();
});

// A holds an open transaction with a booking; B inserts an overlapping booking on another connection.
async function blockedInsert(finishA: 'COMMIT' | 'ROLLBACK') {
  const { provider, client } = await createAccounts();
  const a = await pool.connect();
  const b = await pool.connect();
  let outcome: Promise<string | null> | undefined;
  try {
    await a.query('BEGIN');
    await a.query(insertSql, [provider, client, '[2026-12-01 09:00+00,2026-12-01 10:00+00)']);

    let settled = false;
    outcome = tryInsert(b, [provider, client, '[2026-12-01 09:30+00,2026-12-01 10:30+00)']).finally(() => {
      settled = true;
    });
    await sleep(300);
    expect(settled).toBe(false);

    await a.query(finishA);
    return await outcome;
  } finally {
    await a.query('ROLLBACK').catch(() => {});
    await outcome;
    a.release();
    b.release();
  }
}

test('an overlapping insert waits for the open transaction and fails once it commits', async () => {
  expect(await blockedInsert('COMMIT')).toBe('23P01');
});

test('an overlapping insert waits for the open transaction and succeeds once it rolls back', async () => {
  expect(await blockedInsert('ROLLBACK')).toBeNull();
});

// Concurrent inserters can each see the other's uncommitted row and wait on each other. Postgres breaks that cycle
// with 40P01 (deadlock_detected) after deadlock_timeout instead of 23P01, so losers may fail with either code and the
// test can take about one deadlock_timeout per loser.
test('exactly one of 20 concurrent overlapping inserts succeeds', { timeout: 60_000 }, async () => {
  const { provider, client } = await createAccounts();
  const conns = await Promise.all(Array.from({ length: 20 }, () => pool.connect()));
  try {
    const pids = await Promise.all(conns.map(async (conn) => (await conn.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    expect(new Set(pids).size).toBe(20);

    const results = await Promise.allSettled(
      conns.map((conn, i) => conn.query(insertSql, [provider, client, `[2026-12-02 09:00+00,2026-12-02 10:${String(i).padStart(2, '0')}+00)`])),
    );
    const codes = results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as { code?: string }).code ?? 'unknown'] : []));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(codes).toHaveLength(19);
    for (const code of codes) expect(['23P01', '40P01']).toContain(code);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM bookings WHERE provider_id = $1', [provider]);
    expect(rows[0].n).toBe(1);
  } finally {
    for (const conn of conns) conn.release();
  }
});
