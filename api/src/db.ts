import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import fp from "fastify-plugin";
import pg from "pg";
import { DB_POOL_MAX_DEFAULT } from "./config.js";

declare module "fastify" {
  interface FastifyInstance {
    db: NodePgDatabase;
    pg: pg.Pool;
  }
}

// node-postgres applies this to opening a connection and to waiting for a free one when all `max` are in use,
// so a request that cannot get a connection within 5 s fails instead of waiting indefinitely.
export const CONNECTION_TIMEOUT_MS = 5_000;

export function poolOptions(connectionString: string, max: number): pg.PoolConfig {
  return { connectionString, max, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS };
}

// The pool connects lazily, so registering the plugin does not open a connection.
export const dbPlugin = fp<{ connectionString: string; poolMax?: number }>(
  async (app, opts) => {
    const pool = new pg.Pool(poolOptions(opts.connectionString, opts.poolMax ?? DB_POOL_MAX_DEFAULT));
    // An idle client can fail when Postgres restarts or drops the connection; without a listener that error crashes the process.
    pool.on("error", (err) => app.log.error({ err }, "idle Postgres client error"));
    app.decorate("pg", pool);
    app.decorate("db", drizzle({ client: pool }));
    app.addHook("onClose", async () => {
      await pool.end();
    });
  },
  { name: "db", fastify: "5.x" },
);
