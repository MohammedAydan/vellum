/**
 * Batch write (REST) — onboard two users atomically via /batchWrite.
 *
 * What you'll build: one batch that creates two users, patches one, and deletes
 * a stale user — all or nothing. A second batch with a stale ifVersion fails
 * the whole request.
 * Real-world scenario: provisioning a profile and settings row together so a
 * partial signup can never be observed.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("batch-write");
const col = h.prefix;
const docPath = (id) => `${col}/${id}`;

try {
  h.log("=== Batch Write ===");
  const seed = await h.api.data("POST", `/documents/${docPath("stale-user")}`, { data: { seats: 0 } });
  check(seed.status === 201, "seed user to delete");

  const result = await h.api.data("POST", "/batchWrite", {
    writes: [
      { type: "create", path: docPath("u1"), data: { seats: 1, group: "onboarding" } },
      { type: "set", path: docPath("u2"), data: { seats: 2, group: "onboarding" } },
      { type: "update", path: docPath("u1"), data: { seats: 10 } },
      { type: "delete", path: docPath("stale-user") },
    ],
  });
  check(result.ok, "batch succeeded");
  h.log({
    batchStatus: "ok",
    writesSubmitted: 4,
    responseKeys: Object.keys(result.body),
  });

  const u1 = await h.api.data("GET", `/documents/${docPath("u1")}`);
  const u2 = await h.api.data("GET", `/documents/${docPath("u2")}`);
  const removed = await h.api.data("GET", `/documents/${docPath("stale-user")}`);
  check(u1.body.data.seats === 10, "create then update in one batch applied");
  check(u2.body.data.seats === 2, "set in batch applied");
  check(removed.status === 404, "delete in batch applied");
  h.log({ u1: u1.body.data, u2: u2.body.data, deletedStatus: removed.status });

  const failed = await h.api.data("POST", "/batchWrite", {
    writes: [
      { type: "update", path: docPath("u1"), data: { seats: 999 }, ifVersion: 1 },
      { type: "create", path: docPath("should-not-exist"), data: { seats: 0 } },
    ],
  });
  check(failed.status === 412 && failed.body?.error?.code === "FAILED_PRECONDITION", "stale batch rejected");
  h.log({ preconditionBatchCode: failed.body.error.code });

  const rolledBack = await h.api.data("GET", `/documents/${docPath("should-not-exist")}`);
  check(rolledBack.status === 404, "failed batch did not partially commit");
  h.log({ atomicRollback: rolledBack.status === 404 });
} finally {
  await h.cleanup();
}
