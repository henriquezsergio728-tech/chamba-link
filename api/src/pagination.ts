import { Type } from "typebox";
import { AppError } from "./errors.js";

export const PAGE_LIMIT_MAX = 50;
export const PAGE_LIMIT_DEFAULT = 20;

export const PageQuery = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE_LIMIT_MAX, default: PAGE_LIMIT_DEFAULT })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
};

// The position after the last row of a page, ordered by (created_at, id) descending. createdAt is the column's text
// form, which keeps Postgres' microseconds; a JavaScript Date would round them and skip or repeat rows.
export type Cursor = { createdAt: string; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Postgres' text output for timestamptz, e.g. 2026-11-02 22:53:53.123456+00.
const TIMESTAMPTZ = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString("base64url");

// The cursor is opaque to clients; anything this API did not produce is rejected with 400 INVALID_CURSOR.
export function decodeCursor(value: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [createdAt, id] = parsed as unknown[];
      if (typeof createdAt === "string" && TIMESTAMPTZ.test(createdAt) && typeof id === "string" && UUID.test(id)) {
        return { createdAt, id };
      }
    }
  } catch {
    // Falls through to the error below.
  }
  throw new AppError({ status: 400, code: "INVALID_CURSOR", title: "Bad Request", detail: "The cursor is not valid" });
}

// Fetches limit + 1 rows to learn whether another page follows, and returns the cursor for it.
export function page<T extends { cursor: Cursor }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.cursor) : null };
}
