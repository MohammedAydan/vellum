/**
 * Raw REST API — call the public data plane with `fetch` directly.
 *
 * What you'll build: the same document lifecycle as the SDK examples, but using
 * plain HTTP and the x-project-key header (no SDK involved).
 * Real-world scenario: a non-JavaScript client or a thin serverless function
 * can talk to Vellum with nothing but fetch. This covers POST/GET/PUT/PATCH/
 * DELETE, a collection listing and the structured /query endpoint.
 */
import { harness, check } from "./_harness.js";

const h = await harness("rest-api");
const col = h.prefix;
const docPath = `${col}/rest-doc`;
const dataBase = `/v1/projects/${h.projectId}`;
const auth = { "x-project-key": h.apiKey };

try {
  h.log("=== Raw REST API ===");

  const created = await h.api.raw("POST", `${dataBase}/documents/${docPath}`, {
    data: { title: "raw", count: 1 },
  }, auth);
  check(created.status === 201, "POST created the document");
  h.log({ "POST /documents/:path": { status: created.status, id: (created.body as { documentId?: string }).documentId } });

  const fetched = await h.api.raw("GET", `${dataBase}/documents/${docPath}`, undefined, auth);
  const version = (fetched.body as { version: number }).version;
  check(fetched.status === 200 && version === 1, "GET returned version 1");
  h.log({ "GET /documents/:path": { status: fetched.status, version } });

  const put = await h.api.raw("PUT", `${dataBase}/documents/${docPath}`, {
    data: { title: "merged" },
    merge: true,
  }, auth);
  check(put.ok, "PUT with merge succeeded");
  h.log({ "PUT /documents/:path": { status: put.status, version: (put.body as { version: number }).version } });

  const patch = await h.api.raw("PATCH", `${dataBase}/documents/${docPath}`, {
    data: { count: 2 },
  }, auth);
  check(patch.ok, "PATCH succeeded");
  h.log({ "PATCH /documents/:path": { status: patch.status, version: (patch.body as { version: number }).version } });

  const query = await h.api.raw("POST", `${dataBase}/query`, {
    collectionPath: col,
    where: [{ field: "count", op: "==", value: 2 }],
    orderBy: [],
    limit: 10,
    select: null,
    startAt: null,
    startAfter: null,
  }, auth);
  const ids = ((query.body as { documents?: Array<{ documentId: string }> }).documents ?? []).map((d) => d.documentId);
  check(query.ok && ids.includes("rest-doc"), "query found the document");
  h.log({ "POST /query": { status: query.status, ids } });

  const listing = await h.api.raw("GET", `${dataBase}/documents/${col}?limit=10`, undefined, auth);
  check(listing.ok, "collection listing succeeded");
  h.log({ "GET /documents/:collection": { status: listing.status, count: (listing.body as { documents?: unknown[] }).documents?.length } });

  const removed = await h.api.raw("DELETE", `${dataBase}/documents/${docPath}`, undefined, auth);
  check(removed.ok, "DELETE succeeded");
  h.log({ "DELETE /documents/:path": { status: removed.status } });
} finally {
  await h.cleanup();
}
