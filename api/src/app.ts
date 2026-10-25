import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import { Type } from "typebox";
import { registerErrorHandlers } from "./errors.js";

// Only ids that are safe to write into logs are accepted from the client.
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function buildApp() {
  // nginx reaches the container from loopback or the Docker bridge network, so trust only those peers.
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    trustProxy: "loopback,uniquelocal",
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // HSTS is left to the Cloudflare layer, and a JSON API serves no documents for a CSP to protect.
  app.register(helmet, { hsts: false, contentSecurityPolicy: false });
  app.register(swagger, {
    openapi: { openapi: "3.1.0", info: { title: "ChambaLink API", version: "0.0.0" } },
  });
  registerErrorHandlers(app);

  // Routes are registered as plugins so they load after @fastify/swagger and appear in the generated document.
  app.register(async (root) => {
    root.get(
      "/healthz",
      { schema: { response: { 200: Type.Object({ status: Type.Literal("ok") }) } } },
      async () => ({ status: "ok" as const }),
    );
  });

  app.register(
    async (v1) => {
      v1.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: "/v1" },
  );

  return app;
}
