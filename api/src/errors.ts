import { STATUS_CODES } from "node:http";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// An error whose status, title and detail are safe to return to the client.
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly extensions?: Record<string, unknown>;

  constructor(opts: { status: number; code: string; title: string; detail: string; extensions?: Record<string, unknown> }) {
    super(opts.detail);
    this.name = "AppError";
    this.status = opts.status;
    this.code = opts.code;
    this.title = opts.title;
    this.detail = opts.detail;
    this.extensions = opts.extensions;
  }
}

type Problem = { status: number; title: string; detail: string; code?: string; [extension: string]: unknown };

// RFC 9457 problem details.
function sendProblem(request: FastifyRequest, reply: FastifyReply, problem: Problem) {
  const { status, title, detail, code, ...extensions } = problem;
  return reply
    .code(status)
    .type("application/problem+json")
    .send({ ...extensions, type: "about:blank", title, status, detail, instance: request.url, requestId: request.id, ...(code ? { code } : {}) });
}

export function registerErrorHandlers(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError && err.status < 500) {
      return sendProblem(request, reply, { ...err.extensions, status: err.status, title: err.title, detail: err.detail, code: err.code });
    }
    if (!(err instanceof AppError) && err.validation) {
      const context = err.validationContext ?? "";
      const errors = err.validation.map((v) => {
        const missing = (v.params as { missingProperty?: string }).missingProperty;
        return { path: `${context}${v.instancePath}${missing ? `/${missing}` : ""}`, message: v.message ?? "is invalid" };
      });
      return sendProblem(request, reply, { status: 400, title: "Bad Request", detail: "Request validation failed", errors });
    }
    // Client errors raised by Fastify itself, such as a malformed JSON body (400) or an unsupported media type (415).
    if (!(err instanceof AppError) && err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return sendProblem(request, reply, { status: err.statusCode, title: STATUS_CODES[err.statusCode] ?? "Error", detail: err.message });
    }
    request.log.error({ err }, "unhandled error");
    return sendProblem(request, reply, { status: 500, title: "Internal Server Error", detail: "Internal Server Error" });
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, { status: 404, title: "Not Found", detail: `Route ${request.method} ${request.url.split("?")[0]} not found` }),
  );
}
