/**
 * Errors & limits — probe the API's guardrails.
 *
 * What you'll build: a tour of the canonical Vellum error codes by deliberately
 * violating each documented quota.
 * Real-world scenario: when a client sends an over-limit query or an oversized
 * document, the app should show a useful message instead of crashing. This
 * example proves each boundary returns a stable `code` + HTTP `status` pair.
 * Only codes and statuses are printed — no secrets or request IDs.
 */
import { harness, check } from "./_harness.js";

const h = await harness("errors");
const col = h.prefix;

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? "UNKNOWN";
}

try {
  h.log("=== Errors & Limits ===");

  try {
    await h.sdk.collection(col).limit(501).get();
    throw new Error("limit above 500 should fail");
  } catch (error: unknown) {
    check(codeOf(error) === "LIMIT_EXCEEDED", "MAX_QUERY_LIMIT returns LIMIT_EXCEEDED");
    h.log({ limit: codeOf(error), status: (error as { status?: number }).status });
  }

  let complex = h.sdk.collection(col);
  for (let i = 0; i < 11; i += 1) complex = complex.where(`f${i}`, "==", i);
  try {
    await complex.get();
    throw new Error("more than 10 where clauses should fail");
  } catch (error: unknown) {
    check(codeOf(error) === "QUERY_TOO_COMPLEX", "MAX_WHERE_CLAUSES returns QUERY_TOO_COMPLEX");
    h.log({ whereClauses: 11, code: codeOf(error) });
  }

  const oversizedBatch = Array.from({ length: 101 }, (_, i) => ({
    type: "create",
    path: `${col}/bulk-${i}`,
    data: { i },
  }));
  try {
    await h.sdk.batchWrite(oversizedBatch);
    throw new Error("more than 100 batch operations should fail");
  } catch (error: unknown) {
    check(codeOf(error) === "BATCH_SIZE_EXCEEDED", "MAX_BATCH_OPERATIONS returns BATCH_SIZE_EXCEEDED");
    h.log({ batchOperations: 101, code: codeOf(error) });
  }

  const firstIndex = await h.api.data("POST", "/indexes", {
    collectionPath: col,
    fields: [{ path: "onlyField", dir: "asc" }],
  });
  const duplicateIndex = await h.api.data("POST", "/indexes", {
    collectionPath: col,
    fields: [{ path: "onlyField", dir: "asc" }],
  });
  const duplicateCode = (duplicateIndex.body as { error?: { code?: string } })?.error?.code;
  check(firstIndex.status === 201 && duplicateIndex.status === 409, "duplicate index returns 409");
  check(duplicateCode === "ALREADY_EXISTS", "duplicate index code is ALREADY_EXISTS");
  h.log({ duplicateIndex: { status: duplicateIndex.status, code: duplicateCode } });

  await h.sdk.collection(col).doc("stale").set({ n: 0 });
  try {
    await h.sdk.collection(col).doc("stale").update({ n: 2 }, { ifVersion: 0 });
    throw new Error("stale version should fail");
  } catch (error: unknown) {
    check(codeOf(error) === "FAILED_PRECONDITION", "stale version returns FAILED_PRECONDITION");
    h.log({ staleVersion: { code: codeOf(error), status: (error as { status?: number }).status } });
  }

  const tooLarge = await h.api.data("POST", `/documents/${col}/too-large`, {
    data: { blob: "x".repeat(1_048_577) },
  });
  const tooLargeCode = (tooLarge.body as { error?: { code?: string } })?.error?.code;
  check(tooLarge.status === 413 && tooLargeCode === "DOCUMENT_TOO_LARGE", "1 MiB+ doc returns DOCUMENT_TOO_LARGE");
  h.log({ documentTooLarge: { status: tooLarge.status, code: tooLargeCode } });

  const missing = await h.api.data("GET", `/documents/${col}/does-not-exist`);
  check(missing.status === 404, "missing document returns 404");
  h.log({ notFound: { status: missing.status, code: (missing.body as { error?: { code?: string } })?.error?.code } });
} finally {
  await h.cleanup();
}
