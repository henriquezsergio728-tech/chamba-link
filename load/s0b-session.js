// S0b: an authenticated read. GET /v1/me looks the session up in Postgres on every request.
import http from "k6/http";
import { baseUrl, CACHE_COUNTERS, checkResponse, counterLines, rampOptions, rampRun, rateSteps, rateTable, requireEnv, summaryOutput } from "./lib.js";

const URL = `${baseUrl()}/v1/me`;
// The full name=value pair. A credential: it is sent as a header only, never logged, tagged or put in the summary.
const COOKIE = requireEnv("SESSION_COOKIE");
const PARAMS = { headers: { Cookie: COOKIE } };

export const options = rampOptions("me");

export function me() {
  checkResponse(http.get(URL, PARAMS), 200);
}

export function handleSummary(data) {
  const steps = rateSteps(data);
  return summaryOutput("s0b-session", data, `${rateTable(steps)}\n\n${counterLines(data, CACHE_COUNTERS)}`, rampRun(), { steps });
}
