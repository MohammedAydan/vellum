/**
 * Cursor-only pagination — walk a user directory two records at a time.
 *
 * What you'll build: a paged "list users" screen that follows the opaque
 * HMAC cursor returned as nextCursor.
 * Real-world scenario: an admin UI pages through a large, ordered directory.
 * No SQL OFFSET is used or exposed — each page is anchored to the last row of
 * the previous page via startAfter, with document_id as the final tie-breaker.
 */
import { harness, check } from "./_harness.js";

const h = await harness("pagination");
const col = h.prefix;

try {
  h.log("=== Cursor Pagination ===");
  for (let i = 0; i < 6; i += 1) {
    await h.sdk.collection(col).doc(`u${i}`).set({ seq: i, status: "active", name: `user-${i}` });
  }

  const base = h.sdk.collection(col).where("status", "==", "active").orderBy("seq", "asc").limit(2);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pageNumber = 0;

  while (true) {
    const query = cursor ? base.startAfter(cursor) : base;
    const page = await query.get();
    pageNumber += 1;
    const ids = page.docs.map((doc) => doc.id as string);
    seen.push(...ids);
    h.log({ page: pageNumber, ids, cursorReturned: page.nextCursor !== null });
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    check(pageNumber < 10, "pagination should terminate");
  }

  check(seen.length === 6, "all six users were visited exactly once");
  check(new Set(seen).size === 6, "no user was returned twice");
  h.log({ pages: pageNumber, total: seen.length, unique: new Set(seen).size, nextCursor: null });
} finally {
  await h.cleanup();
}
