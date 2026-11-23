/**
 * k6 Batch Write Throughput (`tests/load/batch-throughput.js`)
 *
 * TASK-804 locked SLO: batchWrite >= 5,000 document writes/s.
 * Each request carries 100 `set` mutations (the v1 MAX_BATCH_OPERATIONS cap),
 * so 50 successful requests/s satisfies the gate. The `batch_writes` counter
 * threshold fails the run when the sustained rate drops below 5,000/s.
 * Error rate must stay < 0.1%.
 */

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const batchWrites = new Counter("batch_writes");

const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 100);
const BATCH_VUS = Number(__ENV.BATCH_VUS || 100);
const MAX_ERROR_RATE = Number(__ENV.SLO_MAX_ERROR_RATE || 0.001);
const MIN_WRITES_PER_SEC = Number(__ENV.SLO_BATCH_WRITES_PER_SEC || 5000);

export const options = {
  scenarios: {
    batch_throughput: {
      executor: "constant-vus",
      vus: BATCH_VUS,
      duration: __ENV.BATCH_DURATION || "30s",
    },
  },
  thresholds: {
    batch_writes: [`rate>=${MIN_WRITES_PER_SEC}`],
    http_req_failed: [`rate<${MAX_ERROR_RATE}`],
    http_req_duration: [`p(95)<${Number(__ENV.SLO_BATCH_P95_MS || 50)}`],
    checks: [`rate>${1 - MAX_ERROR_RATE}`],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const PROJECT_ID = __ENV.PROJECT_ID || "proj_loadtest";
const API_KEY = __ENV.API_KEY || "sk_loadtest_secret_key_12345678901234";

export default function () {
  const writes = [];
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    writes.push({
      type: "set",
      path: `batch/bench_${__VU}_${__ITER}_${index}`,
      data: { vu: __VU, iter: __ITER, index, status: "active" },
    });
  }

  const res = http.post(
    `${BASE_URL}/v1/projects/${PROJECT_ID}/batchWrite`,
    JSON.stringify({ writes }),
    {
      headers: {
        "X-Project-Key": API_KEY,
        "Content-Type": "application/json",
      },
    }
  );

  const accepted = check(res, {
    "batchWrite status is 200": (r) => r.status === 200,
  });
  if (accepted) batchWrites.add(BATCH_SIZE);
}

export function handleSummary(data) {
  return {
    "tests/load/results/batch-summary.json": JSON.stringify(data, null, 2),
  };
}
