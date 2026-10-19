import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: './drizzle' });
  console.log('migrations applied');
} finally {
  await pool.end();
}
