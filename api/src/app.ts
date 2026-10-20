import Fastify from "fastify";

export function buildApp() {
  // nginx reaches the container from loopback or the Docker bridge network, so trust only those peers.
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", trustProxy: "loopback,uniquelocal" });
  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}
