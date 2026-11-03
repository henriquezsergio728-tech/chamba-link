// S0a: the application tier without the database. GET /healthz answers from the Fastify process alone.
import http from "k6/http";
import { baseUrl, CACHE_COUNTERS, checkResponse, counterLines, rampOptions, rampRun, rateSteps, rateTable, summaryOutput } from "./lib.js";

const URL = `${baseUrl()}/healthz`;

export const options = rampOptions("hit");

export function hit() {
  checkResponse(http.get(URL), 200);
}

export function handleSummary(data) {
  const steps = rateSteps(data);
  return summaryOutput("s0a-app-tier", data, `${rateTable(steps)}\n\n${counterLines(data, CACHE_COUNTERS)}`, rampRun(), { steps });
}
