import { afterEach, expect, test, vi } from "vitest";
import { loadServerConfig } from "../src/config.js";

const url = "postgres://app:s3cret-pass@127.0.0.1:5432/app";

// Runs loadServerConfig and captures what it writes to stderr and the exit code it requests.
function run(env: Record<string, string | undefined>) {
  let stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  try {
    return { config: loadServerConfig(env), stderr, exit: undefined };
  } catch (err) {
    return { config: undefined, stderr, exit: (err as Error).message };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("a valid environment is accepted and defaults are applied", () => {
  expect(run({ DATABASE_URL: url })).toEqual({
    config: { databaseUrl: url, port: 3000, host: "127.0.0.1", logLevel: undefined },
    stderr: "",
    exit: undefined,
  });
  expect(run({ DATABASE_URL: url, PORT: "8080", HOST: "0.0.0.0", LOG_LEVEL: "debug" }).config).toEqual({
    databaseUrl: url,
    port: 8080,
    host: "0.0.0.0",
    logLevel: "debug",
  });
});

test("a missing DATABASE_URL exits 1 and names the variable", () => {
  const result = run({ PORT: "3000" });
  expect(result.exit).toBe("exit 1");
  expect(result.stderr).toContain("DATABASE_URL: missing");
  expect(run({ DATABASE_URL: "" }).stderr).toContain("DATABASE_URL: missing");
});

test("an invalid DATABASE_URL is named without printing its value", () => {
  const value = "mysql://app:s3cret-pass@127.0.0.1/app";
  const result = run({ DATABASE_URL: value });
  expect(result.exit).toBe("exit 1");
  expect(result.stderr).toContain("DATABASE_URL: invalid");
  expect(result.stderr).not.toContain("s3cret-pass");
  expect(result.stderr).not.toContain(value);
});

test.each(["abc", "70000", "0", "3000x", "-1"])("PORT=%s exits 1 naming PORT without its value", (port) => {
  const result = run({ DATABASE_URL: url, PORT: port });
  expect(result.exit).toBe("exit 1");
  expect(result.stderr).toBe("Invalid environment configuration:\n  PORT: invalid\n");
  expect(result.stderr).not.toContain(url);
});

test("an unknown LOG_LEVEL is rejected", () => {
  expect(run({ DATABASE_URL: url, LOG_LEVEL: "verbose" }).stderr).toContain("LOG_LEVEL: invalid");
});
