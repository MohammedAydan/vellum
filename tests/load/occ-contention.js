/**
 * k6 OCC Contention Benchmark (`tests/load/occ-contention.js`)
 * 100 Concurrent Workers Updating the Same 10 Hot Documents
 * Tests ABORTED_CONFLICT Detection and Exponential Backoff Retries
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

// 409 ABORTED_CONFLICT is expected and retried; only exhaustion is a failure.
const permanentFailures = new Rate("permanent_failures");
const OCC_P95_MS = Number(__ENV.SLO_OCC_P95_MS || 15);
const MAX_ERROR_RATE = Number(__ENV.SLO_MAX_ERROR_RATE || 0.001);

export const options = {
  scenarios: {
    hotspot_contention: {
      executor: "constant-vus",
      vus: 100,
      duration: "45s",
    },
  },
  thresholds: {
    // TASK-804: expected 409s are whitelisted via expectedStatuses, so any
    // remaining HTTP failure must stay < 0.1% and retried conflicts must
    // resolve within budget for > 99.9% of iterations.
    http_req_failed: [`rate<${MAX_ERROR_RATE}`],
    http_req_duration: [`p(95)<${OCC_P95_MS}`],
    permanent_failures: [`rate<${MAX_ERROR_RATE}`],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const PROJECT_ID = __ENV.PROJECT_ID || "proj_loadtest";
const API_KEY = __ENV.API_KEY || "sk_loadtest_secret_key_12345678901234";

export default function () {
  // Target 1 of 10 hot documents
  const hotDocIndex = Math.floor(Math.random() * 10);
  const hotDocPath = `accounts/hot_acc_${hotDocIndex}`;
  const basePath = `${BASE_URL}/v1/projects/${PROJECT_ID}`;
  const headers = {
    "X-Project-Key": API_KEY,
    "Content-Type": "application/json",
  };

  const MAX_RETRIES = 5;
  let committed = false;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 1. Begin Transaction
    const beginRes = http.post(`${basePath}/transactions:begin`, JSON.stringify({}), { headers });
    if (beginRes.status !== 200) {
      sleep(0.05);
      continue;
    }

    const { transactionToken } = JSON.parse(beginRes.body);

    // 2. Read current document snapshot within tx
    const readRes = http.get(
      `${basePath}/documents/${hotDocPath}?transactionToken=${transactionToken}&txToken=${transactionToken}`,
      { headers }
    );
    const currentVer = readRes.status === 200 ? JSON.parse(readRes.body).version : 0;

    // 3. Commit mutation with preconditions
    const commitRes = http.post(
      `${basePath}/transactions:commit`,
      JSON.stringify({
        transactionToken,
        mutations: [
          {
            type: "update",
            path: hotDocPath,
            data: {
              balance: { $op: "increment", value: 10 },
              lastUpdatedByVU: __VU,
            },
            ifVersion: currentVer,
            preconditions: { ifVersion: currentVer },
          },
        ],
      }),
      {
        headers,
        responseCallback: http.expectedStatuses(200, 409),
      }
    );

    if (commitRes.status === 200) {
      committed = true;
      break;
    }

    // On 409 ABORTED_CONFLICT, apply full-jitter exponential backoff
    const baseBackoffMs = 20 * Math.pow(2, attempt);
    const jitteredBackoffSeconds = (Math.random() * baseBackoffMs) / 1000;
    sleep(jitteredBackoffSeconds);
  }

  check(null, {
    "transaction committed within retry budget": () => committed === true,
  });
  permanentFailures.add(committed ? 0 : 1);

  sleep(0.05);
}

export function handleSummary(data) {
  return {
    "tests/load/results/occ-summary.json": JSON.stringify(data, null, 2),
  };
}
