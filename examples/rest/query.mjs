/**
 * Structured queries (REST) — analytics filters over the /query endpoint.
 *
 * What you'll build: a ranked "top events in a region" view plus a disjunctive
 * `in` filter, using the raw query request body.
 * Real-world scenario: a dashboard needs only a few projected fields and an
 * exact set of revenue bands, so it posts a structured spec instead of
 * scanning the whole collection.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("query");
const col = h.prefix;
const fixtures = [
  { id: "a", event: "signup", region: "north", revenue: 10 },
  { id: "b", event: "purchase", region: "south", revenue: 20 },
  { id: "c", event: "renewal", region: "north", revenue: 30 },
  { id: "d", event: "upgrade", region: "south", revenue: 40 },
  { id: "e", event: "purchase", region: "north", revenue: 50 },
];

try {
  h.log("=== Structured Queries ===");
  for (const fixture of fixtures) {
    const res = await h.api.data("POST", `/documents/${col}/${fixture.id}`, { data: fixture });
    check(res.status === 201, `seed fixture ${fixture.id}`);
  }

  const topNorth = await h.api.data("POST", "/query", {
    collectionPath: col,
    where: [{ field: "region", op: "==", value: "north" }],
    orderBy: [{ field: "revenue", dir: "desc" }],
    limit: 3,
    select: ["event", "revenue"],
    startAt: null,
    startAfter: null,
  });
  check(topNorth.ok && topNorth.body.documents.length === 3, "three north-region events");
  const topIds = topNorth.body.documents.map((d) => d.documentId);
  check(topIds[0] === "e", "highest revenue first");
  h.log({
    query: "region == north ORDER BY revenue DESC LIMIT 3 SELECT event,revenue",
    ids: topIds,
    rows: topNorth.body.documents.map((d) => d.data),
  });

  const inQuery = await h.api.data("POST", "/query", {
    collectionPath: col,
    where: [{ field: "revenue", op: "in", value: [10, 40] }],
    orderBy: [{ field: "revenue", dir: "asc" }],
    limit: 50,
    select: null,
    startAt: null,
    startAfter: null,
  });
  const inIds = inQuery.body.documents.map((d) => d.documentId);
  check(inQuery.ok && inIds.length === 2, "in filter matched two bands");
  h.log({
    query: "revenue in [10,40] ORDER BY revenue ASC",
    ids: inIds,
    indexUsed: inQuery.body.meta?.indexUsed,
  });

  h.log({
    query: "raw query spec (no execution)",
    spec: { collectionPath: col, where: [{ field: "region", op: "==", value: "south" }], limit: 1 },
  });
} finally {
  await h.cleanup();
}
