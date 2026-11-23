/**
 * Errors & limits (REST) — probe the API's guardrails with fetch.
 *
 * What you'll build: a tour of canonical error codes by deliberately breaking
 * documented quotas, printing only stable code + status pairs.
 * Real-world scenario: clients must handle limit, complexity, size and conflict
 * errors gracefully; this example proves each boundary's exact canonical code.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("errors");
const col = h.prefix;
const codeOf = (reply) => reply.body?.error?.code ?? "UNKNOWN";

try {
  h.log("=== Errors & Limits ===");

  const overLimit = await h.api.data("POST", "/query", {
    collectionPath: col,
    where: [],
    orderBy: [],
    limit: 501,
    select: null,
    startAt: null,
    startAfter: null,
  });
  check(overLimit.status === 400 && codeOf(overLimit) === "LIMIT_EXCEEDED", "limit above 500 rejected");
  h.log({ limit: codeOf(overLimit), status: overLimit.status });

  const where = Array.from({ length: 11 }, (_, i) => ({ field: `f${i}`, op: "==", value: i }));
  const complex = await h.api.data("POST", "/query", {
    collectionPath: col,
    where,
    orderBy: [],
    limit: 50,
    select: null,
    startAt: null,
    startAfter: null,
  });
  check(complex.status === 400 && codeOf(complex) === "QUERY_TOO_COMPLEX", "11 where clauses rejected");
  h.log({ whereClauses: 11, code: codeOf(complex) });

  const writes = Array.from({ length: 101 }, (_, i) => ({
    type: "create",
    path: `${col}/bulk-${i}`,
    data: { i },
  }));
  const oversizedBatch = await h.api.data("POST", "/batchWrite", { writes });
  check(oversizedBatch.status === 400 && codeOf(oversizedBatch) === "BATCH_SIZE_EXCEEDED", "101 writes rejected");
  h.log({ batchOperations: 101, code: codeOf(oversizedBatch) });

  const firstIndex = await h.api.data("POST", "/indexes", {
    collectionPath: col,
    fields: [{ path: "onlyField", dir: "asc" }],
  });
  const duplicateIndex = await h.api.data("POST", "/indexes", {
    collectionPath: col,
    fields: [{ path: "onlyField", dir: "asc" }],
  });
  check(firstIndex.status === 201 && duplicateIndex.status === 409, "duplicate index returns 409");
  check(codeOf(duplicateIndex) === "ALREADY_EXISTS", "duplicate index code is ALREADY_EXISTS");
  h.log({ duplicateIndex: { status: duplicateIndex.status, code: codeOf(duplicateIndex) } });

  await h.api.data("POST", `/documents/${col}/stale`, { data: { n: 0 } });
  const stale = await h.api.data("PATCH", `/documents/${col}/stale`, { data: { n: 2 }, ifVersion: 0 });
  check(stale.status === 412 && codeOf(stale) === "FAILED_PRECONDITION", "stale version rejected");
  h.log({ staleVersion: { code: codeOf(stale), status: stale.status } });

  const tooLarge = await h.api.data("POST", `/documents/${col}/too-large`, {
    data: { blob: "x".repeat(1_048_577) },
  });
  check(tooLarge.status === 413 && codeOf(tooLarge) === "DOCUMENT_TOO_LARGE", "oversized doc rejected");
  h.log({ documentTooLarge: { status: tooLarge.status, code: codeOf(tooLarge) } });

  const missing = await h.api.data("GET", `/documents/${col}/does-not-exist`);
  check(missing.status === 404, "missing document returns 404");
  h.log({ notFound: { status: missing.status, code: codeOf(missing) } });
} finally {
  await h.cleanup();
}
