/**
 * k6 CRUD Throughput Benchmark (`tests/load/crud-throughput.js`)
 * 500 VUs, 40% Read / 30% Write / 20% Update / 10% Delete.
 *
 * TASK-804 locked SLO: CRUD p95 < 15ms on local PostgreSQL, < 50ms on Neon.
 * Set SLO_CRUD_P95_MS=50 for a Neon run. Error rate must stay < 0.1%.
 * Thresholds FAIL the k6 run when breached (non-zero exit code).
 */

import http from "k6/http";
import { check, sleep } from "k6";

const CRUD_P95_MS = Number(__ENV.SLO_CRUD_P95_MS || 15);
const CRUD_P99_MS = Number(__ENV.SLO_CRUD_P99_MS || 50);
const MAX_ERROR_RATE = Number(__ENV.SLO_MAX_ERROR_RATE || 0.001);

export const options = {
  scenarios: {
    crud_throughput: {
      executor: "ramping-vus",
      startVUs: 10,
      stages: __ENV.K6_SHORT
        ? [
            { duration: "5s", target: 10 },
            { duration: "10s", target: 20 },
            { duration: "5s", target: 0 },
          ]
        : [
            { duration: "30s", target: 200 },
            { duration: "1m", target: 500 },
            { duration: "30s", target: 500 },
            { duration: "15s", target: 0 },
          ],
    },
  },
  thresholds: {
    // Strict SLO gate: any breach aborts the run with a non-zero exit code.
    http_req_failed: [`rate<${MAX_ERROR_RATE}`],
    http_req_duration: [`p(95)<${CRUD_P95_MS}`, `p(99)<${CRUD_P99_MS}`],
    checks: [`rate>${1 - MAX_ERROR_RATE}`],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const PROJECT_ID = __ENV.PROJECT_ID || "proj_loadtest";
const API_KEY = __ENV.API_KEY || "sk_loadtest_secret_key_12345678901234";

export default function () {
  const docId = `doc_${__VU}_${__ITER}`;
  const basePath = `${BASE_URL}/v1/projects/${PROJECT_ID}/documents`;
  const headers = {
    "X-Project-Key": API_KEY,
    "Content-Type": "application/json",
  };

  const rand = Math.random();
  const okOr404 = {
    headers,
    responseCallback: http.expectedStatuses(200, 404),
  };

  if (rand < 0.4) {
    // 40% Read
    const res = http.get(`${basePath}/customers/${docId}`, okOr404);
    check(res, { "read status is 200 or 404": (r) => r.status === 200 || r.status === 404 });
  } else if (rand < 0.7) {
    // 30% Write (Create / Set)
    const payload = JSON.stringify({
      data: {
        vu: __VU,
        iter: __ITER,
        score: Math.floor(Math.random() * 100),
        status: "active",
        createdAt: { $op: "serverTimestamp" },
      },
    });
    const res = http.put(`${basePath}/customers/${docId}`, payload, { headers });
    check(res, { "write status is 200": (r) => r.status === 200 });
  } else if (rand < 0.9) {
    // 20% Update (Atomic Increment & Field Update)
    const payload = JSON.stringify({
      data: {
        lastSeenAt: { $op: "serverTimestamp" },
        iterationCount: { $op: "increment", value: 1 },
      },
    });
    const res = http.patch(`${basePath}/customers/${docId}`, payload, okOr404);
    check(res, { "update status is 200 or 404": (r) => r.status === 200 || r.status === 404 });
  } else {
    // 10% Delete
    const res = http.del(`${basePath}/customers/${docId}`, null, okOr404);
    check(res, { "delete status is 200 or 404": (r) => r.status === 200 || r.status === 404 });
  }

  sleep(0.05);
}

export function handleSummary(data) {
  return {
    "tests/load/results/crud-summary.json": JSON.stringify(data, null, 2),
  };
}
