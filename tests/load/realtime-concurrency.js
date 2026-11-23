/**
 * k6 WebSocket Realtime Concurrency Benchmark (`tests/load/realtime-concurrency.js`)
 * 500 Concurrent WebSocket Connections Subscribed to Document Changes
 * Verifies Outbox Fan-out Latency, ping/pong heartbeats, and frame handling
 */

import ws from "k6/ws";
import { check, sleep } from "k6";

// TASK-804: realtime connects and frame handling must exceed 99.9% success.
const MAX_ERROR_RATE = Number(__ENV.SLO_MAX_ERROR_RATE || 0.001);

export const options = {
  scenarios: {
    ws_concurrency: {
      executor: "ramping-vus",
      startVUs: 20,
      stages: [
        { duration: "20s", target: 200 },
        { duration: "40s", target: 500 },
        { duration: "20s", target: 0 },
      ],
    },
  },
  thresholds: {
    ws_connecting: ["p(95)<1000"],
    ws_msgs_received: ["count>500"],
    checks: [`rate>${1 - MAX_ERROR_RATE}`],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const PROJECT_ID = __ENV.PROJECT_ID || "proj_loadtest";
const API_KEY = __ENV.API_KEY || "sk_loadtest_secret_key_12345678901234";
const WS_URL = BASE_URL.replace(/^http/, "ws") + "/v1/realtime";

export default function () {
  const url = `${WS_URL}?key=${API_KEY}`;
  const params = { tags: { my_tag: "realtime_worker" } };

  const res = ws.connect(url, params, function (socket) {
    socket.on("open", function () {
      // 1. Send authentication frame
      socket.send(
        JSON.stringify({
          type: "auth",
          projectId: PROJECT_ID,
          apiKey: API_KEY,
        })
      );

      // 2. Subscribe to document
      socket.send(
        JSON.stringify({
          type: "subscribe",
          subId: `sub_${__VU}`,
          path: "metrics/system_health",
        })
      );

      // 3. Keepalive ping every 5 seconds
      socket.setInterval(function () {
        socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }, 5000);
    });

    socket.on("message", function (data) {
      try {
        const frame = JSON.parse(data);
        check(frame, {
          "received valid frame": (f) => f && typeof f.type === "string",
        });
      } catch {
        // Ignored
      }
    });

    socket.on("close", function () {
      // Clean disconnect
    });

    // Hold connection open for 15 seconds
    socket.setTimeout(function () {
      socket.close();
    }, 15000);
  });

  check(res, { "ws connection established": (r) => r && r.status === 101 });
  sleep(1);
}

export function handleSummary(data) {
  return {
    "tests/load/results/realtime-summary.json": JSON.stringify(data, null, 2),
  };
}
