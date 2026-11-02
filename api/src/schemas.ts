import { type Static, type TLiteral, type TSchema, Type } from "typebox";
import { CATEGORIES, DEPARTMENTS } from "./domain.js";

export const Uuid = Type.String({ format: "uuid" });
// ISO 8601 with an offset; requests may use any offset, responses use the local one, e.g. 2026-11-03T09:00:00-06:00.
export const Timestamp = Type.String({ format: "date-time" });

// A union of string literals that keeps its static type, from a constant tuple.
type Literals<T extends readonly string[]> = T extends readonly [infer H extends string, ...infer R extends readonly string[]] ? [TLiteral<H>, ...Literals<R>] : [];
const literals = (values: readonly string[]) => values.map((v) => Type.Literal(v));

export const Category = Type.Union(literals(CATEGORIES) as unknown as Literals<typeof CATEGORIES>);
export type Category = Static<typeof Category>;
export const Department = Type.Union(literals(DEPARTMENTS) as unknown as Literals<typeof DEPARTMENTS>);
export type Department = Static<typeof Department>;

export const IdParams = Type.Object({ id: Uuid });

// A nullable value as a JSON Schema type array, e.g. {"type": ["integer", "null"]}. Fastify's Ajv coerces types, and
// with anyOf [integer, null] it would turn a null into 0 before the null branch is tried; a type array is not coerced.
export const Nullable = <T extends TSchema & { type: string }>(schema: T) => Type.Unsafe<Static<T> | null>({ ...schema, type: [schema.type, "null"] });
