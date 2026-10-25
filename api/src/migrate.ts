import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { loadMigrateConfig } from './config.js';

const { databaseUrl } = loadMigrateConfig();
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: './drizzle' });
  console.log('migrations applied');
} finally {
  await pool.end();
}
