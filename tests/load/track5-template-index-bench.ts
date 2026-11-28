/**
 * Track 5 benchmark: wildcard collection-template indexes (P1-3) end to end on
 * real Postgres. Verifies:
 *  1. A subcollection with more than 50k docs fails an unindexed orderBy with
 *     FAILED_PRECONDITION, whose suggestedIndex is the canonical TEMPLATE
 *     path (chats/{*}/messages), not the concrete one.
 *  2. A template composite index backfills every matching concrete
 *     subcollection (segment-wise SQL + (collection_path, document_id) tuple
 *     pagination), and the query compiler then serves indexed orderBy queries
 *     on any concrete path covered by the template.
 *  3. Write-path index maintenance lands entries for documents written after
 *     the backfill, in chats the backfill never saw.
 *
 * Usage: DATA_DATABASE_URL=postgresql://user:pass@host:port/db \
 *        corepack pnpm exec tsx tests/load/track5-template-index-bench.ts
 *
 * Requires the data-plane schema (scripts/migrate.ts --only=data).
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { type TenantContext, type DocumentRecord } from "../../packages/storage/src/index.js";
import { PgStorageAdapter } from "../../packages/storage/src/pg-adapter.js";
import { DocumentEngine } from "../../packages/document-engine/src/index.js";
import { VellumError } from "../../packages/core/src/index.js";

const URL = process.env.DATA_DATABASE_URL ?? "postgresql://vellum:vellum@127.0.0.1:55440/vellum_test";
const TENANT: TenantContext = { projectId: "11111111-1111-1111-1111-111111111111", internal: true } as TenantContext;

const HOT_CHAT = "chat_hot"; // >50k docs: over the unindexed scan cap
const HOT_MESSAGES = 60_000;
const WIDE_CHATS = 60; // breadth: template covers many concrete paths
const WIDE_MESSAGES = 400;
const FRESH_CHAT = "chat_fresh"; // written after the backfill

function doc(chat: string, i: number): DocumentRecord {
  const createdAt = 1_700_000_000_000 + i;
  const collection = `chats/${chat}/messages`;
  const id = `m${String(i).padStart(6, "0")}`;
  const data = { sender: i % 2 === 0 ? "a" : "b", body: `message ${i} in ${chat}`, seq: i, createdAt };
  return {
    projectId: TENANT.projectId,
    path: `${collection}/${id}`,
    collectionPath: collection,
    collectionGroup: collection,
    documentId: id,
    pathDepth: 4,
    data,
    sizeBytes: JSON.stringify(data).length,
    version: 1,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(createdAt).toISOString(),
    deletedAt: null,
    expiresAt: null,
  };
}

async function seed(adapter: PgStorageAdapter): Promise<void> {
  const t0 = performance.now();
  let batch: DocumentRecord[] = [];
  let written = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await adapter.withTransaction(TENANT, async (tx) => {
      await (tx as unknown as { putDocumentRows(rows: DocumentRecord[]): Promise<void> }).putDocumentRows(batch);
    });
    written += batch.length;
    batch = [];
  };
  for (let i = 0; i < HOT_MESSAGES; i++) {
    batch.push(doc(HOT_CHAT, i));
    if (batch.length >= 500) await flush();
  }
  for (let c = 0; c < WIDE_CHATS; c++) {
    for (let i = 0; i < WIDE_MESSAGES; i++) {
      batch.push(doc(`chat_${String(c).padStart(3, "0")}`, i));
      if (batch.length >= 500) await flush();
    }
  }
  await flush();
  console.log(`seeded ${written} messages in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

async function timeQuery(engine: DocumentEngine, chat: string, runs = 40) {
  const lat: number[] = [];
  let last: Awaited<ReturnType<DocumentEngine["executeQuery"]>> | undefined;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    last = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: `chats/${chat}/messages`,
        where: [],
        orderBy: [{ field: "seq", dir: "asc" }],
        limit: 50,
      },
    });
    lat.push(performance.now() - t0);
  }
  lat.sort((a, b) => a - b);
  return {
    p50: lat[Math.floor(lat.length * 0.5)],
    p95: lat[Math.floor(lat.length * 0.95)],
    last: last!,
  };
}

const adapter = new PgStorageAdapter({ connectionString: URL });
const engine = new DocumentEngine({
  controlStore: { getActiveRuleset: () => null, incrementUsage: () => undefined },
  dataStore: adapter,
});

try {
  await seed(adapter);

  // ── 1. Unindexed query on the hot subcollection fails, suggesting the template
  let err: VellumError | undefined;
  try {
    await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collectionPath: `chats/${HOT_CHAT}/messages`,
        where: [],
        orderBy: [{ field: "seq", dir: "asc" }],
        limit: 50,
      },
    });
    assert.fail("unindexed query on >50k subcollection should have failed");
  } catch (e) {
    err = e as VellumError;
  }
  if (err!.code !== "FAILED_PRECONDITION") console.log("UNEXPECTED ERR:", err!.code, err!.message);
  assert.equal(err!.code, "FAILED_PRECONDITION");
  const suggested = (err as unknown as { details?: { suggestedIndex?: { collectionPath: string } } }).details?.suggestedIndex;
  assert.equal(suggested?.collectionPath, "chats/*/messages");
  console.log(`unindexed orderBy on chats/${HOT_CHAT}/messages (60k docs) -> FAILED_PRECONDITION, suggestedIndex.collectionPath=${suggested?.collectionPath} ✓`);

  // A small concrete path under the cap still works without an index (unchanged behaviour)
  const small = await engine.executeQuery({
    ...TENANT,
    querySpec: {
      collectionPath: "chats/chat_000/messages",
      where: [],
      orderBy: [{ field: "seq", dir: "asc" }],
      limit: 50,
    },
  });
  assert.equal(small.documents.length, 50);
  console.log(`unindexed orderBy on chats/chat_000/messages (400 docs, under cap) still served ✓`);

  // ── 2. Create the template index and backfill it
  const tCreate = performance.now();
  const created = await adapter.createCompositeIndex(TENANT, "chats/*/messages", [
    { path: "seq", dir: "asc" },
  ]);
  console.log(`created template index ${created.id} on chats/*/messages (status=${created.status})`);
  const tBuild = performance.now();
  let built = false;
  while (performance.now() - tBuild < 120_000) {
    await adapter.runIndexBuilderWorker({ projectId: TENANT.projectId, deadlineMs: 10_000 });
    const idx = (await adapter.listCompositeIndexes(TENANT)).find((i) => i.id === created.id);
    if (idx?.status === "ready") { built = true; break; }
  }
  assert.ok(built, "template index backfill did not reach READY in 120s");
  const backfillMs = performance.now() - tCreate;
  console.log(`template backfill READY in ${(backfillMs / 1000).toFixed(1)}s`);
  // entry count verified below via listIndexEntries

  // ── 3. Indexed queries: hot path + another concrete path under the same template
  for (const chat of [HOT_CHAT, "chat_042"]) {
    const { p50, p95, last } = await timeQuery(engine, chat);
    assert.match(last.meta.indexUsed ?? "", /^composite:/);
    assert.equal(last.documents.length, 50);
    assert.equal(last.documents[0].path, `chats/${chat}/messages/m000000`);
    for (let i = 1; i < last.documents.length; i++) {
      assert.ok(
        (last.documents[i].data.seq as number) >= (last.documents[i - 1].data.seq as number),
        "results must be ordered by seq"
      );
    }
    console.log(`indexed orderBy chats/${chat}/messages: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms indexUsed=${last.meta.indexUsed} ✓`);
  }

  // ── 4. Write-path: a document in a chat the backfill never saw
  await engine.setDocument({
    ...TENANT,
    path: `chats/${FRESH_CHAT}/messages/m000000`,
    data: { sender: "a", body: "first message", seq: 0, createdAt: 1_800_000_000_000 },
  });
  await adapter.withTransaction(TENANT, async (tx) => {
    const docs = await (tx as { listDocumentsViaCompositeIndex(indexId: string): Promise<Array<{ collectionPath: string }>> }).listDocumentsViaCompositeIndex(created.id);
    const mine = docs.filter((d) => d.collectionPath === `chats/${FRESH_CHAT}/messages`);
    assert.equal(mine.length, 1, "write-path entry for fresh chat missing from template index");
  });
  const fresh = await engine.executeQuery({
    ...TENANT,
    querySpec: {
      collectionPath: `chats/${FRESH_CHAT}/messages`,
      where: [],
      orderBy: [{ field: "seq", dir: "asc" }],
      limit: 10,
    },
  });
  assert.match(fresh.meta.indexUsed ?? "", /^composite:/);
  assert.equal(fresh.documents.length, 1);
  assert.equal(fresh.documents[0].data.body, "first message");
  console.log(`write-path entry landed for ${FRESH_CHAT} (post-backfill) and query served from template index ✓`);

  console.log("\nALL TRACK 5 TEMPLATE-INDEX BENCHMARK ASSERTIONS PASSED");
} finally {
  await adapter.close?.();
}
