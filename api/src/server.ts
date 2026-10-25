import { buildApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { dbPlugin } from "./db.js";

const config = loadServerConfig();
const app = buildApp();
if (config.logLevel) app.log.level = config.logLevel;
app.register(dbPlugin, { connectionString: config.databaseUrl });

// docker stop sends SIGTERM and kills the container 10 s later, so a shutdown that hangs gives up after 8 s.
const SHUTDOWN_TIMEOUT_MS = 8_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  setTimeout(() => {
    app.log.error("shutdown timed out");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  app.close().then(
    () => process.exit(0),
    (err) => {
      app.log.error(err);
      process.exit(1);
    },
  );
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
