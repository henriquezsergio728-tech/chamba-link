// S0c: login cost and the per-IP login limit. One VU logs in 35 times in a row with a real account, which passes the
// limit of 30 attempts per client address per 15-minute window, so the run ends with 429 responses.
import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Trend } from "k6/metrics";
import { baseUrl, counterLines, requireEnv, SUMMARY_TREND_STATS, summaryOutput, trendTable } from "./lib.js";

const URL = `${baseUrl()}/v1/auth/login`;
// Credentials: sent in the request body only, never logged, tagged or put in the summary.
const BODY = JSON.stringify({ email: requireEnv("LOGIN_EMAIL"), password: requireEnv("LOGIN_PASSWORD") });
const PARAMS = { headers: { "Content-Type": "application/json" }, responseCallback: http.expectedStatuses(200, 429) };

const loginOk = new Trend("login_ok_duration", true);
const loginLimited = new Trend("login_limited_duration", true);

export const options = {
  scenarios: { login: { executor: "per-vu-iterations", vus: 1, iterations: 35 } },
  // k6 tags every request with its response status; these thresholds make the per-status submetrics appear.
  thresholds: {
    "http_req_duration{status:200}": ["max>=0"],
    "http_req_duration{status:429}": ["max>=0"],
    "http_reqs{status:200}": ["count>=0"],
    "http_reqs{status:429}": ["count>=0"],
    "http_reqs{status:401}": ["count>=0"],
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

// A single VU runs every iteration, so a module-level flag is enough to log the first 429 once.
let seenLimited = false;

export default function () {
  const res = http.post(URL, BODY, PARAMS);
  check(res, { "status is 200 or 429": (r) => r.status === 200 || r.status === 429 });
  if (res.status === 200) loginOk.add(res.timings.duration);
  if (res.status === 429) {
    loginLimited.add(res.timings.duration);
    if (!seenLimited) {
      seenLimited = true;
      console.log(`first 429 at iteration ${exec.scenario.iterationInTest}, Retry-After: ${res.headers["Retry-After"]} s`);
    }
  }
}

export function handleSummary(data) {
  const statuses = counterLines(data, ["http_reqs{status:200}", "http_reqs{status:429}", "http_reqs{status:401}"]);
  const text = `${trendTable(data, ["login_ok_duration", "login_limited_duration"])}\n\n${statuses}`;
  return summaryOutput("s0c-auth", data, text, { base: baseUrl() });
}
