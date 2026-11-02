// Shared helpers for the k6 scripts in this directory. Plain k6 ES modules with no dependencies.
import { check } from "k6";
import { Counter } from "k6/metrics";

const GAP_SECONDS = 5;
const DEFAULT_STEP_SECONDS = 45;
const DEFAULT_PRE_ALLOCATED_VUS = 100;
const DEFAULT_MAX_VUS = 1000;
export const SUMMARY_TREND_STATS = ["count", "avg", "min", "p(50)", "p(95)", "p(99)", "max"];
// Statuses counted per step. k6 tags a request that got no response with status 0.
const STEP_STATUSES = [0, 200, 401, 403, 429, 500, 502, 503, 504];

// Throwing in the init context stops k6 before any request is sent.
export function requireEnv(name) {
  const value = __ENV[name];
  if (value === undefined || value === "") throw new Error(`${name} is required and is not set`);
  return value;
}

function positiveInteger(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return Number(raw);
}

// No default: a load test must never fall back to a host nobody chose.
export function baseUrl() {
  return requireEnv("BASE_URL").replace(/\/+$/, "");
}

function rates() {
  const raw = requireEnv("RATES");
  const list = raw.split(",").map((s) => s.trim());
  if (list.some((s) => !/^[1-9][0-9]*$/.test(s))) throw new Error(`RATES must be comma-separated positive integers, got "${raw}"`);
  return list.map(Number);
}

// One constant-arrival-rate scenario per rate, named r<rate>, run back to back with a 5 s gap. Every scenario calls
// the script's exported function `exec`, and gets per-scenario thresholds so its submetrics appear in the summary.
export function rampOptions(exec) {
  const step = positiveInteger("STEP_SECONDS", DEFAULT_STEP_SECONDS);
  const preAllocatedVUs = positiveInteger("PRE_ALLOCATED_VUS", DEFAULT_PRE_ALLOCATED_VUS);
  const maxVUs = Math.max(preAllocatedVUs, positiveInteger("MAX_VUS", DEFAULT_MAX_VUS));
  const scenarios = {};
  const thresholds = {};
  rates().forEach((rate, i) => {
    const name = `r${rate}`;
    scenarios[name] = {
      executor: "constant-arrival-rate",
      exec,
      rate,
      timeUnit: "1s",
      duration: `${step}s`,
      startTime: `${i * (step + GAP_SECONDS)}s`,
      // In-flight requests get at most the gap to finish, so one step's tail does not overlap the next step.
      gracefulStop: `${GAP_SECONDS}s`,
      preAllocatedVUs,
      maxVUs,
    };
    thresholds[`http_req_duration{scenario:${name}}`] = [{ threshold: "p(95)<5000", abortOnFail: true, delayAbortEval: "10s" }];
    thresholds[`http_req_failed{scenario:${name}}`] = [{ threshold: "rate<0.10", abortOnFail: true, delayAbortEval: "10s" }];
    thresholds[`http_reqs{scenario:${name}}`] = ["count>=0"];
    thresholds[`dropped_iterations{scenario:${name}}`] = ["count>=0"];
    for (const status of STEP_STATUSES) thresholds[`http_reqs{scenario:${name},status:${status}}`] = ["count>=0"];
  });
  return {
    scenarios,
    thresholds,
    discardResponseBodies: true,
    summaryTrendStats: SUMMARY_TREND_STATS,
  };
}

const nonDynamic = new Counter("non_dynamic");
const noCfHeader = new Counter("no_cf_header");

// Checks the status and counts cache behaviour. Both counters get a sample on every response, including 0, so they
// always appear in the summary. Cloudflare answers DYNAMIC for responses it did not cache; any other value means
// the request was served or considered by the cache instead of reaching the API.
export function checkResponse(res, status) {
  check(res, { [`status is ${status}`]: (r) => r.status === status });
  const cache = res.headers["Cf-Cache-Status"];
  nonDynamic.add(cache !== undefined && cache !== "DYNAMIC" ? 1 : 0);
  noCfHeader.add(cache === undefined ? 1 : 0);
}

export const CACHE_COUNTERS = ["non_dynamic", "no_cf_header"];

function values(data, name) {
  return data.metrics[name] ? data.metrics[name].values : undefined;
}

const ms = (v) => (v === undefined ? "-" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(1)}ms`);

function table(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

// Every status other than 200 with a non-zero count in the step, as "<status>:<count>", plus "other:<n>" for
// requests whose status is not in STEP_STATUSES.
function stepErrors(data, rate, count) {
  let listed = 0;
  const parts = [];
  for (const status of STEP_STATUSES) {
    const v = values(data, `http_reqs{scenario:r${rate},status:${status}}`);
    const n = v ? v.count : 0;
    listed += n;
    if (status !== 200 && n > 0) parts.push(`${status}:${n}`);
  }
  if (count > listed) parts.push(`other:${count - listed}`);
  return parts.length ? parts.join(" ") : "-";
}

// One row per rate step: target rate, achieved requests per second, latency percentiles, failures, errors and drops.
export function rateTable(data) {
  const step = positiveInteger("STEP_SECONDS", DEFAULT_STEP_SECONDS);
  const rows = rates().map((rate) => {
    const tag = `{scenario:r${rate}}`;
    const reqs = values(data, `http_reqs${tag}`);
    const duration = values(data, `http_req_duration${tag}`);
    const failed = values(data, `http_req_failed${tag}`);
    const dropped = values(data, `dropped_iterations${tag}`);
    const count = reqs ? reqs.count : 0;
    // A step that never ran, for example after an abort, has empty submetrics that k6 reports as zeros.
    const ran = count > 0;
    return [
      `r${rate}`,
      (count / step).toFixed(1),
      String(count),
      ran ? ms(duration["p(50)"]) : "-",
      ran ? ms(duration["p(95)"]) : "-",
      ran ? ms(duration["p(99)"]) : "-",
      ran ? `${(failed.rate * 100).toFixed(2)}%` : "-",
      ran ? stepErrors(data, rate, count) : "-",
      String(dropped ? dropped.count : 0),
    ];
  });
  return table(["step", "achieved rps", "requests", "p50", "p95", "p99", "failed", "errors", "dropped"], rows);
}

// What a run was pointed at, for the report and the JSON summary. Credentials are never part of it.
export function rampRun() {
  return { base: baseUrl(), rates: rates().join(","), step: positiveInteger("STEP_SECONDS", DEFAULT_STEP_SECONDS) };
}

export function counterLines(data, names) {
  return names.map((name) => `${name}: ${values(data, name) ? values(data, name).count : 0}`).join("\n");
}

export function trendTable(data, names) {
  const rows = names.map((name) => {
    const v = values(data, name);
    if (!v || !v.count) return [name, "0", "-", "-", "-", "-"];
    return [name, String(v.count), ms(v["p(50)"]), ms(v["p(95)"]), ms(v["p(99)"]), ms(v.max)];
  });
  return table(["trend", "count", "p50", "p95", "p99", "max"], rows);
}

// The stdout report plus the full JSON summary at load/results/<script>-<timestamp>.json, relative to the directory
// k6 runs from. k6 does not create the directory. The timestamp is ISO 8601 basic format (no colons), e.g. 20261102T153000Z.
// `run` holds base and, for rate scripts, rates and step; the report's first line and the JSON's "run" object carry
// it with the finish time.
export function summaryOutput(script, data, text, run) {
  const now = new Date();
  const finished = now.toISOString();
  const stamp = finished.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const path = `load/results/${script}-${stamp}.json`;
  const full = { finished, ...run };
  const line = [`finished ${finished}`, `base=${run.base}`];
  if (run.rates !== undefined) line.push(`rates=${run.rates}`, `step=${run.step}s`);
  return {
    stdout: `${line.join(" ")}\n\n${script}\n\n${text}\n\nfull summary: ${path}\n`,
    [path]: JSON.stringify({ run: full, ...data }, null, 2),
  };
}
