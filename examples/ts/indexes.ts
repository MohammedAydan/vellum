/**
 * Composite indexes — a leaderboard index over (team, score).
 *
 * What you'll build: a tenant-defined composite index that accelerates an
 * ordered leaderboard query.
 * Real-world scenario: ranking players by score within a team would otherwise
 * need a custom index. Tenant indexes are rows in document_indexes (never DDL
 * on the shared documents table), so creating one is safe in a shared cluster.
 * A repeated definition returns 409 ALREADY_EXISTS and is explicitly tolerated.
 */
import { harness, check } from "./_harness.js";

const h = await harness("indexes");
const col = h.prefix;
const fields = [
  { path: "team", dir: "asc" },
  { path: "score", dir: "asc" },
];

try {
  h.log("=== Composite Indexes ===");
  for (const row of [
    { id: "p1", team: "red", score: 10 },
    { id: "p2", team: "red", score: 30 },
    { id: "p3", team: "blue", score: 20 },
  ]) {
    await h.sdk.collection(col).doc(row.id).set(row);
  }

  const created = await h.api.data<{ id?: string }>("POST", "/indexes", {
    collectionPath: col,
    fields,
  });
  check(created.status === 201 || created.status === 409, "index creation is 201 or duplicate 409");
  const alreadyExists = created.status === 409;
  h.log({ createStatus: created.status, outcome: alreadyExists ? "already exists" : "created" });

  const listed = await h.api.data<{ indexes: Array<{ collectionPath: string; id: string }> }>("GET", "/indexes");
  check(listed.ok, "index listing succeeded");
  // The server returns the real (unscrubbed) path, so compare against `col`.
  const found = listed.body.indexes.find((index) => index.collectionPath === col);
  check(Boolean(found) || alreadyExists, "created index appears in the listing");
  h.log({ listed: listed.body.indexes.length > 0, foundInListing: Boolean(found) });

  const rows = await h.sdk.collection(col).where("team", "==", "red").orderBy("score", "asc").get();
  check(rows.docs.length === 2, "indexed query returned both red-team rows");
  h.log({
    query: "team == red ORDER BY score ASC",
    ids: rows.docs.map((doc) => doc.id),
    indexUsed: (rows.meta as { indexUsed?: string } | null)?.indexUsed,
  });

  if (found) {
    const removed = await h.api.data("DELETE", `/indexes/${found.id}`);
    check(removed.ok, "index deletion succeeded");
    h.log({ deleted: true });
  }
} finally {
  await h.cleanup();
}
