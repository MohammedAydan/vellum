/**
 * Composite indexes (REST) — a leaderboard index over (team, score).
 *
 * What you'll build: a tenant composite index created as a row via the REST
 * API, then an ordered query that uses it, then cleanup.
 * Real-world scenario: ranking players by team and score needs a composite
 * index, but no CREATE INDEX on the shared documents table is ever issued.
 */
import { harness, check } from "./_harness.mjs";

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
    const res = await h.api.data("POST", `/documents/${col}/${row.id}`, { data: row });
    check(res.status === 201, `seed player ${row.id}`);
  }

  const created = await h.api.data("POST", "/indexes", { collectionPath: col, fields });
  check(created.status === 201 || created.status === 409, "index creation is 201 or duplicate 409");
  const alreadyExists = created.status === 409;
  h.log({ createStatus: created.status, outcome: alreadyExists ? "already exists" : "created" });

  const listed = await h.api.data("GET", "/indexes");
  check(listed.ok, "index listing succeeded");
  const found = listed.body.indexes.find((index) => index.collectionPath === col);
  check(Boolean(found) || alreadyExists, "created index appears in the listing");
  h.log({ listed: listed.body.indexes.length > 0, foundInListing: Boolean(found) });

  const rows = await h.api.data("POST", "/query", {
    collectionPath: col,
    where: [{ field: "team", op: "==", value: "red" }],
    orderBy: [{ field: "score", dir: "asc" }],
    limit: 50,
    select: null,
    startAt: null,
    startAfter: null,
  });
  const ids = rows.body.documents.map((d) => d.documentId);
  check(rows.ok && ids.length === 2, "indexed query returned both red-team rows");
  h.log({
    query: "team == red ORDER BY score ASC",
    ids,
    indexUsed: rows.body.meta?.indexUsed,
  });

  if (found) {
    const removed = await h.api.data("DELETE", `/indexes/${found.id}`);
    check(removed.ok, "index deletion succeeded");
    h.log({ deleted: true });
  }
} finally {
  await h.cleanup();
}
