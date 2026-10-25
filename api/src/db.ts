import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import fp from "fastify-plugin";
import pg from "pg";

declare module "fastify" {
  interface FastifyInstance {
    db: NodePgDatabase;
    pg: pg.Pool;
  }
}

// The pool connects lazily, so registering the plugin does not open a connection.
export const dbPlugin = fp<{ connectionString: string }>(
  async (app, opts) => {
    const pool = new pg.Pool({ connectionString: opts.connectionString });
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
