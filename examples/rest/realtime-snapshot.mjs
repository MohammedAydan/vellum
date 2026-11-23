/**
 * Realtime snapshots (REST) — observe sensor changes by polling.
 *
 * What you'll build: a live dashboard's data path using only fetch — write a
 * sensor reading, then observe it and a new matching sensor via repeated GET /
 * query requests.
 * Real-world scenario: the SDK exposes native WebSocket onSnapshot; a fetch-only
 * client has no WebSocket, so this example uses the outbox/REST polling path and
 * labels it explicitly. The committed mutation is always asserted.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("realtime-snapshot");
const col = h.prefix;
const docPath = `${col}/sensor-1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

try {
  h.log("=== Realtime Snapshots ===");
  const seeded = await h.api.data("POST", `/documents/${docPath}`, { data: { reading: 1, channel: "sensors" } });
  check(seeded.status === 201, "seed sensor");

  const mode = "REST polling (fetch-only; no WebSocket transport)";

  // --- Document observation --------------------------------------------------
  const patched = await h.api.data("PATCH", `/documents/${docPath}`, { data: { reading: 2 } });
  check(patched.ok, "writing the new reading succeeded");
  const observedDoc = await pollUntil(async () => {
    const snap = await h.api.data("GET", `/documents/${docPath}`);
    return snap.ok && snap.body.data.reading === 2;
  });
  check(observedDoc, "REST GET eventually observed the committed reading");
  h.log({ transport: mode, target: "document", initialCallback: false, readingViaRest: 2, mutationAsserted: true });

  // --- Query observation -----------------------------------------------------
  const createdSecond = await h.api.data("POST", `/documents/${col}/sensor-2`, {
    data: { reading: 3, channel: "sensors" },
  });
  check(createdSecond.status === 201, "second matching sensor created");
  let count = 0;
  const observedQuery = await pollUntil(async () => {
    const result = await h.api.data("POST", "/query", {
      collectionPath: col,
      where: [{ field: "channel", op: "==", value: "sensors" }],
      orderBy: [],
      limit: 50,
      select: null,
      startAt: null,
      startAfter: null,
    });
    count = result.body.documents?.length ?? 0;
    return count === 2;
  });
  check(observedQuery, "REST query eventually returned both matching sensors");
  h.log({ transport: mode, target: "query", initialCallback: false, countViaRest: count, mutationAsserted: true });

  const final = await h.api.data("GET", `/documents/${docPath}`);
  check(final.body.data.reading === 2, "final sensor reading is committed");
  h.log({ finalReading: final.body.data.reading });
} finally {
  await h.cleanup();
}
