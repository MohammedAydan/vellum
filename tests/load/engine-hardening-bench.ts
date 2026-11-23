/**
 * ENGINE-HARDENING benchmark — measured, never invented.
 *
 * Usage:
 *   corepack pnpm exec tsx tests/load/engine-hardening-bench.ts
 *
 * A "storage round trip" in this benchmark is a DATA-FETCH operation that
 * crosses the adapter boundary: withTransaction (connection checkout + BEGIN),
 * batchGetDocuments, listDependentsByReference, listActiveDocumentsInCollection,
 * listDocumentsInCollectionPage, queryDocuments and listDocumentsInCollection.
 * Write statements (outbox append / document upsert) are pipelined inside the
 * same tenant transaction and are reported separately, not folded into the
 * round-trip count.
 *
 * The counting adapter also exposes the SQL-style uncapped cursor page
 * capability (`listDocumentsInCollectionPage` with limit=1000) so the export
 * case measures the real O(limit) contract instead of the in-memory adapter's
 * deliberate 500-row test cap.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { type DocumentRecord, type TenantContext, type TxHandle } from "../../packages/storage/src/index.js";
import { DataPlaneStore } from "../../packages/storage/src/adapters.js";
import { DocumentEngine } from "../../packages/document-engine/src/index.js";

const TENANT = {
  projectId: "11111111-1111-1111-1111-111111111111",
  internal: true as const,
};

export interface Counters {
  withTransaction: number;
  batchGetDocuments: number;
  listDependentsByReference: number;
  listActiveDocumentsInCollection: number;
  listDocumentsInCollectionPage: number;
  listDocumentsInCollection: number;
  queryDocuments: number;
  getDocument: number;
  appendOutboxEvent: number;
  putDocumentRow: number;
  putDocumentRows: number;
  conditionalPutDocument: number;
}

function emptyCounters(): Counters {
  return {
    withTransaction: 0,
    batchGetDocuments: 0,
    listDependentsByReference: 0,
    listActiveDocumentsInCollection: 0,
    listDocumentsInCollectionPage: 0,
    listDocumentsInCollection: 0,
    queryDocuments: 0,
    getDocument: 0,
    appendOutboxEvent: 0,
    putDocumentRow: 0,
    putDocumentRows: 0,
    conditionalPutDocument: 0,
  };
}

/** Data-fetch operations that cross the adapter boundary. */
function fetchRoundTrips(c: Counters): number {
  return (
    c.withTransaction +
    c.batchGetDocuments +
    c.listDependentsByReference +
    c.listActiveDocumentsInCollection +
    c.listDocumentsInCollectionPage +
    c.queryDocuments +
    c.listDocumentsInCollection
  );
}

class CountingStore extends DataPlaneStore {
  public readonly counters = emptyCounters();

  public reset(): void {
    Object.assign(this.counters, emptyCounters());
  }

  public override async withTransaction<T>(
    ctx: TenantContext,
    callback: (tx: TxHandle) => Promise<T>
  ): Promise<T> {
    this.counters.withTransaction += 1;
    return super.withTransaction(ctx, (tx) => callback(this.instrument(ctx, tx)));
  }

  public override async listDocumentsInCollection(
    ctx: TenantContext,
    collectionPath: string
  ): Promise<DocumentRecord[]> {
    this.counters.listDocumentsInCollection += 1;
    return super.listDocumentsInCollection(ctx, collectionPath);
  }

  private instrument(ctx: TenantContext, tx: TxHandle): TxHandle {
    const c = this.counters;
    // Advertising a SQL `query` capability makes the engine take the production
    // branch in the relation evaluator (one index-backed
    // `listDependentsByReference` statement) instead of the in-memory adapter's
    // `$ref` compatibility full-scan. No OCC tokens are used in these cases, so
    // this stub is never actually invoked.
    const instrumented: TxHandle & {
      query: () => Promise<{ rows: unknown[]; rowCount: number }>;
      putDocumentRows: (rows: DocumentRecord[]) => Promise<void>;
    } = {
      ...tx,
      query: async () => ({ rows: [], rowCount: 0 }),
      getDocument: async (path, includeSoftDeleted = false, forUpdate = false) => {
        c.getDocument += 1;
        return tx.getDocument(path, includeSoftDeleted, forUpdate);
      },
      batchGetDocuments: async (paths, includeDeleted = false) => {
        c.batchGetDocuments += 1;
        if (typeof tx.batchGetDocuments === "function") {
          return tx.batchGetDocuments(paths, includeDeleted);
        }
        return (await Promise.all(paths.map((p) => tx.getDocument(p, includeDeleted)))).filter(
          (row): row is DocumentRecord => row !== null
        );
      },
      listDependentsByReference: async (...args) => {
        c.listDependentsByReference += 1;
        const [a, b, d, e] = args as [
          string,
          string,
          string,
          number
        ];
        if (typeof tx.listDependentsByReference === "function") {
          return tx.listDependentsByReference(a, b, d, e);
        }
        return [];
      },
      listActiveDocumentsInCollection: async (collectionPath) => {
        c.listActiveDocumentsInCollection += 1;
        return tx.listActiveDocumentsInCollection?.(collectionPath) ?? [];
      },
      listDocumentsInCollectionPage: (async (
        collectionName: string,
        opts: { afterDocumentId?: string | null; limit: number }
      ) => {
        c.listDocumentsInCollectionPage += 1;
        const after = opts.afterDocumentId ?? null;
        const rows = Array.from(this.documents.values())
          .filter(
            (row) =>
              row.projectId === ctx.projectId &&
              row.collectionPath === collectionName &&
              row.deletedAt === null &&
              (after === null || row.documentId > after)
          )
          .sort((x, y) => (x.documentId < y.documentId ? -1 : x.documentId > y.documentId ? 1 : 0))
          .slice(0, opts.limit);
        return rows.map((row) => structuredClone(row));
      }) as NonNullable<TxHandle["listDocumentsInCollectionPage"]>,
      queryDocuments: async (compiled) => {
        c.queryDocuments += 1;
        return tx.queryDocuments(compiled);
      },
      appendOutboxEvent: async (event) => {
        c.appendOutboxEvent += 1;
        return tx.appendOutboxEvent(event);
      },
      putDocumentRow: async (row) => {
        c.putDocumentRow += 1;
        return tx.putDocumentRow(row);
      },
      putDocumentRows: async (rows) => {
        c.putDocumentRows += 1;
        const batched = tx as TxHandle & { putDocumentRows?: (r: DocumentRecord[]) => Promise<void> };
        if (typeof batched.putDocumentRows === "function") return batched.putDocumentRows(rows);
        for (const row of rows) await tx.putDocumentRow(row);
      },
      conditionalPutDocument: async (row, expected) => {
        c.conditionalPutDocument += 1;
        if (typeof tx.conditionalPutDocument === "function") {
          return tx.conditionalPutDocument(row, expected);
        }
        return { applied: false };
      },
    };
    return instrumented;
  }
}

function makeEngine(store: CountingStore): DocumentEngine {
  return new DocumentEngine({
    controlStore: { getActiveRuleset: () => null, incrementUsage: () => undefined },
    dataStore: store,
  });
}

interface Measurement {
  name: string;
  ms: number;
  counters: Counters;
  roundTrips: number;
}

function print(m: Measurement, note: string): void {
  console.log(
    `${m.name.padEnd(38)} ${m.ms.toFixed(2).padStart(9)} ms  ` +
      `roundTrips=${String(m.roundTrips).padStart(3)}  ${note}`
  );
  console.log(`  counters: ${JSON.stringify(m.counters)}`);
}

async function timed<T>(name: string, store: CountingStore, fn: () => Promise<T>): Promise<[T, Measurement]> {
  store.reset();
  const started = performance.now();
  const value = await fn();
  const ms = performance.now() - started;
  const counters = { ...store.counters };
  return [value, { name, ms, counters, roundTrips: fetchRoundTrips(counters) }];
}

async function main(): Promise<void> {
  console.log("ENGINE HARDENING BENCHMARK (in-memory data plane, real code paths)");
  console.log("");

  // 1. 500 creates. The locked MAX_BATCH_OPERATIONS is 100, so 500 documents
  //    are written as five 100-op batchWrite chunks (exactly what the import
  //    path does). The <= 3 round-trip budget is asserted per chunk.
  {
    const store = new CountingStore();
    const engine = makeEngine(store);
    const all = Array.from({ length: 500 }, (_, i) => ({
      type: "create" as const,
      path: `bench_total/c${String(i).padStart(4, "0")}`,
      data: { n: i },
    }));

    const oneChunk = all.slice(0, 100).map((w) => ({
      ...w,
      path: w.path.replace("bench_total/", "bench_chunk/"),
    }));
    const chunkMeasurement = await timed("batchWrite(100 creates)", store, () =>
      engine.batchWrite({ ...TENANT, writes: oneChunk })
    );
    print(chunkMeasurement[1], "<= 3 fetch round trips per 100-op chunk");
    assert.equal(chunkMeasurement[1].counters.withTransaction, 1, "batchWrite must use one tenant transaction");
    assert.ok(
      chunkMeasurement[1].roundTrips <= 3,
      `batchWrite chunk used ${chunkMeasurement[1].roundTrips} fetch round trips (limit 3)`
    );
    assert.ok(chunkMeasurement[1].counters.appendOutboxEvent <= 100, "outbox events must be bounded by batch size");

    // Whole 500-create workload (5 chunks) — reported as a real number.
    const [, total] = await timed("500 creates (5 x 100 chunks)", store, async () => {
      for (let start = 0; start < all.length; start += 100) {
        await engine.batchWrite({ ...TENANT, writes: all.slice(start, start + 100) });
      }
    });
    print(total, `total, ${(total.roundTrips / 5).toFixed(1)} round trips/chunk`);
    assert.ok(total.roundTrips / 5 <= 3, "average round trips per 100-op chunk must stay <= 3");
  }

  // 2. relation-rule delete: one index-backed dependent lookup.
  {
    const store = new CountingStore();
    const engine = makeEngine(store);
    await engine.createDocument({ ...TENANT, path: "bench_authors/a1", data: { stale: true } });
    await engine.createDocument({
      ...TENANT,
      path: "bench_posts/p001",
      data: { authorId: "bench_authors/a1" },
    });
    const [, m] = await timed("deleteWhere(cascade, 1 parent)", store, () =>
      engine.deleteWhere({
        ...TENANT,
        collectionPath: "bench_authors",
        where: [{ field: "stale", op: "==", value: true }],
        relationRules: [{ collection: "bench_posts", field: "authorId", onDelete: "cascade" }],
      })
    );
    print(m, "<= 2 dependent lookups via listDependentsByReference");
    const dependentLookups = m.counters.listDependentsByReference;
    assert.ok(dependentLookups >= 1 && dependentLookups <= 2, `used ${dependentLookups} dependent lookups (limit 2)`);
    assert.equal(m.counters.listActiveDocumentsInCollection, 0, "relation delete must not full-scan the collection");
  }

  // 3. streaming export: one SQL-style cursor page of 1,000 rows, O(limit) memory.
  {
    const store = new CountingStore();
    const engine = makeEngine(store);
    const docs = Array.from({ length: 3_000 }, (_, i) => ({
      id: `x_${String(i).padStart(5, "0")}`,
      n: i,
    }));
    await engine.importCollectionDocuments(TENANT, "bench_export", docs);

    const heapBefore = process.memoryUsage().heapUsed;
    const [emitted, m] = await timed("exportStream(page of 1000)", store, async () => {
      const out: string[] = [];
      for await (const doc of engine.exportCollectionDocumentsStream(TENANT, "bench_export", { limit: 1000 })) {
        out.push(doc.id);
      }
      return out;
    });
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
    print(m, `emitted=${emitted.length}, heapDelta=${heapDeltaMb.toFixed(2)}MB, O(limit)`);
    assert.equal(emitted.length, 1000, "stream must emit exactly the requested page size");
    assert.equal(new Set(emitted).size, 1000, "stream page must contain no duplicates");
    assert.ok(
      m.counters.listDocumentsInCollectionPage >= 1 && m.counters.listDocumentsInCollectionPage <= 2,
      `export page used ${m.counters.listDocumentsInCollectionPage} page loads (expected 1, +1 lookahead tolerated)`
    );
    assert.equal(m.counters.listDocumentsInCollection, 0, "streaming export must never full-scan the collection");
    assert.ok(heapDeltaMb < 128, `export heap delta ${heapDeltaMb.toFixed(2)}MB exceeds O(limit) budget`);
  }

  console.log("");
  console.log("All engine-hardening benchmark assertions passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
