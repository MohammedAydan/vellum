/**
 * Cursor pagination (REST) — list users two at a time via opaque cursors.
 *
 * What you'll build: a paged user directory that follows `nextCursor` from the
 * /query response into `startAfter` on the next request.
 * Real-world scenario: a large admin list must avoid SQL OFFSET; each page is
 * anchored to the last row of the previous page and stops when nextCursor is null.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("pagination");
const col = h.prefix;

try {
  h.log("=== Cursor Pagination ===");
  for (let i = 0; i < 6; i += 1) {
    const res = await h.api.data("POST", `/documents/${col}/u${i}`, {
      data: { seq: i, status: "active", name: `user-${i}` },
    });
    check(res.status === 201, `seed user ${i}`);
  }

  const base = {
    collectionPath: col,
    where: [{ field: "status", op: "==", value: "active" }],
    orderBy: [{ field: "seq", dir: "asc" }],
    limit: 2,
    select: null,
    startAt: null,
    startAfter: null,
  };
  const seen = [];
  let cursor = null;
  let pageNumber = 0;

  while (true) {
    const reply = await h.api.data("POST", "/query", { ...base, startAfter: cursor });
    check(reply.ok, `page ${pageNumber + 1} query succeeded`);
    pageNumber += 1;
    const ids = reply.body.documents.map((d) => d.documentId);
    seen.push(...ids);
    const nextCursor = reply.body.nextCursor ?? null;
    h.log({ page: pageNumber, ids, cursorReturned: nextCursor !== null });
    if (nextCursor === null) break;
    cursor = nextCursor;
    check(pageNumber < 10, "pagination should terminate");
  }

  check(seen.length === 6, "all six users visited exactly once");
  check(new Set(seen).size === 6, "no user returned twice");
  h.log({ pages: pageNumber, total: seen.length, unique: new Set(seen).size, nextCursor: null });
} finally {
  await h.cleanup();
}
