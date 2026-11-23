/**
 * Structured queries — build immutable query steps with where/orderBy/limit/
 * select and execute them through the SDK.
 *
 * What you'll build: an analytics view over revenue events, filtered by region
 * and ranked by revenue.
 * Real-world scenario: a dashboard asks for "top 3 events in the north region"
 * and for an exact set of revenue bands via a disjunctive `in` filter. `select`
 * keeps the response small by projecting only the columns the chart needs.
 */
import { harness, check } from "./_harness.js";

const h = await harness("query");
const col = h.prefix;

const fixtures: Array<{ id: string; event: string; region: string; revenue: number }> = [
  { id: "a", event: "signup", region: "north", revenue: 10 },
  { id: "b", event: "purchase", region: "south", revenue: 20 },
  { id: "c", event: "renewal", region: "north", revenue: 30 },
  { id: "d", event: "upgrade", region: "south", revenue: 40 },
  { id: "e", event: "purchase", region: "north", revenue: 50 },
];

try {
  h.log("=== Structured Queries ===");
  for (const fixture of fixtures) {
    await h.sdk.collection(col).doc(fixture.id).set(fixture);
  }

  const topNorth = await h.sdk
    .collection(col)
    .where("region", "==", "north")
    .orderBy("revenue", "desc")
    .limit(3)
    .select("event", "revenue")
    .get();
  check(topNorth.docs.length === 3, "expected three north-region events");
  check(topNorth.docs[0]?.id === "e", "highest revenue first");
  h.log({
    query: "region == north ORDER BY revenue DESC LIMIT 3 SELECT event,revenue",
    ids: topNorth.docs.map((doc) => doc.id),
    rows: topNorth.docs.map((doc) => doc.data()),
  });

  const inQuery = await h.sdk
    .collection(col)
    .where("revenue", "in", [10, 40])
    .orderBy("revenue", "asc")
    .get();
  check(inQuery.docs.length === 2, "in filter matched exactly two revenue bands");
  h.log({
    query: "revenue in [10,40] ORDER BY revenue ASC",
    ids: inQuery.docs.map((doc) => doc.id),
    indexUsed: (inQuery.meta as { indexUsed?: string } | null)?.indexUsed,
  });

  const spec = h.sdk.collection(col).where("region", "==", "south").limit(1).toQuerySpec();
  h.log({
    query: "toQuerySpec() (no network call)",
    where: spec.where,
    orderBy: spec.orderBy,
    limit: spec.limit,
  });
} finally {
  await h.cleanup();
}
