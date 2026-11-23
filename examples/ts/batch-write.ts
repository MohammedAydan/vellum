/**
 * Batch write — onboard two users in one atomic request.
 *
 * What you'll build: a single batch that creates two user records, patches one
 * of them, and deletes a stale record — all or nothing.
 * Real-world scenario: a signup flow provisions a profile and a settings row
 * together. A second batch carries a stale ifVersion precondition; the whole
 * batch fails and a "should-not-exist" doc is never partially committed.
 */
import { harness, check } from "./_harness.js";

const h = await harness("batch-write");
const col = h.prefix;
const docPath = (id: string): string => `${col}/${id}`;

function errorCode(error: unknown): string {
  return (error as { code?: string }).code ?? "UNKNOWN";
}

try {
  h.log("=== Batch Write ===");
  // A delete mutation must target an existing document.
  await h.sdk.collection(col).doc("stale-user").set({ seats: 0 });

  const result = await h.sdk.batchWrite([
    { type: "create", path: docPath("u1"), data: { seats: 1, group: "onboarding" } },
    { type: "set", path: docPath("u2"), data: { seats: 2, group: "onboarding" } },
    { type: "update", path: docPath("u1"), data: { seats: 10 } },
    { type: "delete", path: docPath("stale-user") },
  ]);
  h.log({
    batchStatus: "ok",
    writesSubmitted: 4,
    responseKeys: Object.keys(result as object),
  });

  const u1 = await h.sdk.collection(col).doc("u1").get();
  const u2 = await h.sdk.collection(col).doc("u2").get();
  const removed = await h.api.data("GET", `/documents/${col}/stale-user`);
  check((u1.data() as { seats: number }).seats === 10, "create then update in one batch applied");
  check((u2.data() as { seats: number }).seats === 2, "set in batch applied");
  check(removed.status === 404, "delete in batch applied");
  h.log({
    u1: u1.data(),
    u2: u2.data(),
    deletedStatus: removed.status,
  });

  try {
    await h.sdk.batchWrite([
      { type: "update", path: docPath("u1"), data: { seats: 999 }, ifVersion: 1 },
      { type: "create", path: docPath("should-not-exist"), data: { seats: 0 } },
    ]);
    throw new Error("batch with stale precondition should have failed");
  } catch (error: unknown) {
    check(errorCode(error) === "FAILED_PRECONDITION", "stale batch returns FAILED_PRECONDITION");
    h.log({ preconditionBatchCode: errorCode(error) });
  }
  const rolledBack = await h.api.data("GET", `/documents/${col}/should-not-exist`);
  check(rolledBack.status === 404, "failed batch did not partially commit");
  h.log({ atomicRollback: rolledBack.status === 404 });
} finally {
  await h.cleanup();
}
