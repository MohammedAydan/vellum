/**
 * Realtime snapshots — watch a sensor feed and a matching query.
 *
 * What you'll build: a live ops dashboard that listens to one sensor document
 * and to a channel query, and observes changes without re-polling manually.
 * Real-world scenario: a monitoring screen must reflect a new reading the
 * instant it is written. The document subscription sees value changes; the
 * query subscription sees a new matching sensor appear.
 *
 * If a browser-free Node WebSocket cannot be established, the example degrades
 * to a clearly-labelled REST polling fallback. The mutation is always asserted.
 */
import { harness, check } from "./_harness.js";

const h = await harness("realtime-snapshot");
const col = h.prefix;
const docPath = `${col}/sensor-1`;

interface ReceivedEvent {
  type: string;
  id: string;
  value: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  events: ReceivedEvent[],
  predicate: (event: ReceivedEvent) => boolean,
  timeoutMs = 6000
): Promise<ReceivedEvent | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await sleep(50);
  }
  return null;
}

try {
  h.log("=== Realtime Snapshots ===");
  await h.sdk.collection(col).doc("sensor-1").set({ reading: 1, channel: "sensors" });

  // --- Document subscription -------------------------------------------------
  const docEvents: ReceivedEvent[] = [];
  const unsubscribeDoc = h.sdk.doc(docPath).onSnapshot((snapshot) => {
    for (const change of snapshot.changes) {
      const data = change.doc.data() as Record<string, unknown>;
      docEvents.push({ type: change.type, id: change.doc.id, value: data["reading"] });
    }
  });
  const initial = await waitFor(docEvents, (event) => event.type === "added");

  let mode: string;
  if (initial) {
    mode = "native WebSocket onSnapshot";
    await h.sdk.collection(col).doc("sensor-1").update({ reading: 2 });
    const modified = await waitFor(docEvents, (event) => event.type === "modified" && event.value === 2);
    check(Boolean(modified), "document subscription observed the new reading");
    h.log({
      transport: mode,
      target: "document",
      initialType: initial.type,
      observedTypes: docEvents.map((event) => event.type),
      finalReading: modified?.value,
    });
  } else {
    mode = "REST polling fallback (WebSocket unavailable)";
    await h.sdk.collection(col).doc("sensor-1").update({ reading: 2 });
    let observed = false;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const snap = await h.sdk.collection(col).doc("sensor-1").get();
      if ((snap.data() as { reading: number }).reading === 2) {
        observed = true;
        break;
      }
      await sleep(100);
    }
    check(observed, "REST GET eventually observed the committed reading");
    h.log({ transport: mode, target: "document", initialCallback: false, readingViaRest: 2, mutationAsserted: true });
  }
  unsubscribeDoc();

  // --- Query subscription ----------------------------------------------------
  // The realtime subscribe frame strips unused null members and opaque cursors.
  const channelQuery = h.sdk.collection(col).where("channel", "==", "sensors");

  const queryEvents: ReceivedEvent[] = [];
  const unsubscribeQuery = channelQuery.onSnapshot((snapshot) => {
    for (const change of snapshot.changes) {
      queryEvents.push({ type: change.type, id: change.doc.id, value: (change.doc.data() as { reading?: number }).reading });
    }
  });
  const queryInitial = await waitFor(queryEvents, (event) => event.type === "added");

  if (queryInitial && mode === "native WebSocket onSnapshot") {
    await h.sdk.collection(col).doc("sensor-2").set({ reading: 3, channel: "sensors" });
    const added = await waitFor(queryEvents, (event) => event.type === "added" && event.id === "sensor-2");
    check(Boolean(added), "query subscription observed the new matching sensor");
    h.log({
      transport: mode,
      target: "query",
      initialCount: 1,
      observedTypes: queryEvents.map((event) => event.type),
      addedId: added?.id,
    });
  } else {
    await h.sdk.collection(col).doc("sensor-2").set({ reading: 3, channel: "sensors" });
    let count = 0;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const result = await h.sdk.collection(col).where("channel", "==", "sensors").get();
      count = result.docs.length;
      if (count === 2) break;
      await sleep(100);
    }
    check(count === 2, "REST query eventually returned both matching sensors");
    h.log({ transport: mode, target: "query", initialCallback: false, countViaRest: count, mutationAsserted: true });
  }
  unsubscribeQuery();

  const finalDoc = await h.sdk.collection(col).doc("sensor-1").get();
  check((finalDoc.data() as { reading: number }).reading === 2, "final sensor reading is committed");
  h.log({ finalReading: (finalDoc.data() as { reading: number }).reading });
} finally {
  await h.cleanup();
}
