import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const CATALOG_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";
export const SLOTS_CACHE_CONTROL = "public, max-age=15";

// If-None-Match uses the weak comparison (RFC 9110 13.1.2), so a W/ prefix from an intermediary still matches.
function matches(header: string | undefined, etag: string) {
  if (!header) return false;
  return header.split(",").some((tag) => {
    const t = tag.trim();
    return t === "*" || t.replace(/^W\//, "") === etag;
  });
}

// onSend hook that sets Cache-Control on a 200 response only, so errors are not kept by shared caches.
export function cacheControlOn200(cacheControl: string) {
  return async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (reply.statusCode === 200) reply.header("cache-control", cacheControl);
    return payload;
  };
}

// onSend hook for a public 200 response: sets Cache-Control and a strong ETag, the SHA-256 of the serialized body,
// and turns the response into an empty 304 when If-None-Match names that ETag. Other statuses pass through unchanged.
export function publicCache(cacheControl: string) {
  return async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (reply.statusCode !== 200 || typeof payload !== "string") return payload;
    const etag = `"${createHash("sha256").update(payload).digest("base64url")}"`;
    reply.header("cache-control", cacheControl);
    reply.header("etag", etag);
    if (!matches(request.headers["if-none-match"], etag)) return payload;
    reply.code(304);
    reply.removeHeader("content-type");
    return "";
  };
}
