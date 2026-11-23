/**
 * k6 Query Throughput & Index Benchmark (`tests/load/query-throughput.js`)
 * Equality (GIN), Range Scan (Composite B-Tree), and Array-Contains Queries.
 *
 * TASK-804 locked SLO: query p95 < 25ms at 100k documents; error < 0.1%.
 * Seed 100k documents before trusting the latency gate. Thresholds FAIL the
 * k6 run when breached.
 */

import http from "k6/http";
import { check, sleep } from "k6";

const QUERY_P95_MS = Number(__ENV.SLO_QUERY_P95_MS || 25);
const QUERY_P99_MS = Number(__ENV.SLO_QUERY_P99_MS || 60);
const MAX_ERROR_RATE = Number(__ENV.SLO_MAX_ERROR_RATE || 0.001);

export const options = {
  scenarios: {
    query_workload: {
      executor: "constant-vus",
      vus: 50,
      duration: __ENV.QUERY_DURATION || "1m",
    },
  },
  thresholds: {
    http_req_failed: [`rate<${MAX_ERROR_RATE}`],
    http_req_duration: [`p(95)<${QUERY_P95_MS}`, `p(99)<${QUERY_P99_MS}`],
    checks: [`rate>${1 - MAX_ERROR_RATE}`],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const PROJECT_ID = __ENV.PROJECT_ID || "proj_loadtest";
const API_KEY = __ENV.API_KEY || "sk_loadtest_secret_key_12345678901234";

export default function () {
  const queryUrl = `${BASE_URL}/v1/projects/${PROJECT_ID}/query`;
  const headers = {
    "X-Project-Key": API_KEY,
    "Content-Type": "application/json",
  };

  const queryType = __ITER % 3;

  if (queryType === 0) {
    // 1. Equality Filter (B-Tree on status / GIN on data)
    const res = http.post(
      queryUrl,
      JSON.stringify({
        collectionPath: "customers",
        where: [{ field: "status", op: "==", value: "active" }],
        limit: 20,
      }),
      { headers }
    );
    check(res, { "equality query status is 200": (r) => r.status === 200 });
  } else if (queryType === 1) {
    // 2. Range Query (Composite Index: status ASC, score DESC)
    const res = http.post(
      queryUrl,
      JSON.stringify({
        collectionPath: "customers",
        where: [
          { field: "status", op: "==", value: "active" },
          { field: "score", op: ">=", value: 50 },
        ],
        orderBy: [{ field: "score", direction: "desc" }],
        limit: 20,
      }),
      { headers }
    );
    check(res, { "composite range query status is 200": (r) => r.status === 200 });
  } else {
    // 3. Array Contains Query
    const res = http.post(
      queryUrl,
      JSON.stringify({
        collectionPath: "customers",
        where: [{ field: "tags", op: "array-contains", value: "vip" }],
        limit: 10,
      }),
      { headers }
    );
    check(res, { "array contains query status is 200": (r) => r.status === 200 });
  }

  sleep(0.05);
}

export function handleSummary(data) {
  return {
    "tests/load/results/query-summary.json": JSON.stringify(data, null, 2),
  };
}
