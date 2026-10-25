import { Type, type Static, type TObject } from "typebox";
import { Value } from "typebox/value";

const DatabaseUrl = Type.String({ pattern: "^postgres(ql)?://" });

// Read by dist/migrate.js, which only needs the database.
export const MigrateEnv = Type.Object({
  DATABASE_URL: DatabaseUrl,
});

// Read by dist/server.js.
export const ServerEnv = Type.Object({
  DATABASE_URL: DatabaseUrl,
  PORT: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  HOST: Type.Optional(Type.String({ minLength: 1 })),
  LOG_LEVEL: Type.Optional(Type.Union(["fatal", "error", "warn", "info", "debug", "trace", "silent"].map((level) => Type.Literal(level)))),
});

export type ConfigProblem = { name: string; reason: "missing" | "invalid" };

type Env = Record<string, string | undefined>;

// Validates the variables named in the schema. An empty string counts as unset; PORT is converted only when it is all digits.
export function readEnv<S extends TObject>(schema: S, env: Env): { ok: true; value: Static<S> } | { ok: false; problems: ConfigProblem[] } {
  const input: Record<string, unknown> = {};
  for (const name of Object.keys(schema.properties)) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    input[name] = name === "PORT" && /^[0-9]+$/.test(raw) ? Number(raw) : raw;
  }
  if (Value.Check(schema, input)) return { ok: true, value: input as Static<S> };

  const problems = new Map<string, ConfigProblem["reason"]>();
  for (const error of Value.Errors(schema, input)) {
    if (error.keyword === "required") {
      for (const name of error.params.requiredProperties) problems.set(name, "missing");
    } else {
      const name = error.instancePath.split("/")[1];
      if (name && !problems.has(name)) problems.set(name, "invalid");
    }
  }
  return { ok: false, problems: [...problems].map(([name, reason]) => ({ name, reason })) };
}

// Names and reasons only: values may hold credentials, so they are never printed.
export function formatProblems(problems: ConfigProblem[]) {
  return ["Invalid environment configuration:", ...problems.map((p) => `  ${p.name}: ${p.reason}`)].join("\n") + "\n";
}

function loadOrExit<S extends TObject>(schema: S, env: Env): Static<S> {
  const result = readEnv(schema, env);
  if (result.ok) return result.value;
  process.stderr.write(formatProblems(result.problems));
  process.exit(1);
}

export function loadServerConfig(env: Env = process.env) {
  const value = loadOrExit(ServerEnv, env);
  return {
    databaseUrl: value.DATABASE_URL,
    port: value.PORT ?? 3000,
    host: value.HOST ?? "127.0.0.1",
    logLevel: value.LOG_LEVEL,
  };
}

export function loadMigrateConfig(env: Env = process.env) {
  return { databaseUrl: loadOrExit(MigrateEnv, env).DATABASE_URL };
}
