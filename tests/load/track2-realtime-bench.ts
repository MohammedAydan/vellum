/**
 * TRACK 2 benchmark (P1-4 + P0-2) — measured against a real PostgreSQL.
 *
 * Usage:
 *   BENCH_DATABASE_URL=postgresql://user:pass@host:5432/db \
 *     corepack pnpm exec tsx tests/load/track2-realtime-bench.ts
 *
 * Runs ONLY against the database it is given; intended for throwaway
 * benchmark databases. Seeds 60k documents, then measures:
 *   A. hot-document OCC contention (50 concurrent workers, one counter doc),
 *      WAIT-mode locks vs NOWAIT locks, both under lock_timeout=1500ms
 *   B. commit-order-safe outbox watermark + capped page fetch at 60k outbox rows
 */
import { performance } from "node:perf_hooks";
import { PgStorageAdapter } from "../../packages/storage/src/pg-adapter.js";
import type { DocumentRecord, TenantContext } from "../../packages/storage/src/types.js";

const URL = process.env.BENCH_DATABASE_URL;
if (!URL) throw new Error("BENCH_DATABASE_URL is required");

const TENANT: TenantContext = { projectId: "11111111-1111-1111-1111-111111111111", internal: true };
const SEED_DOCS = 60_000;
const SEED_BATCH = 1_000;
const COLLECTIONS = 60;
const WORKERS = 50;
const OPS_PER_WORKER = 20;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}
function stats(lat: number[]): string {
  const s = [...lat].sort((a, b) => a - b);
  return `p50=${percentile(s, 50).toFixed(1)}ms p95=${percentile(s, 95).toFixed(1)}ms p99=${percentile(s, 99).toFixed(1)}ms max=${(s[s.length - 1] ?? 0).toFixed(1)}ms (n=${s.length})`;
}
function jitter(attempt: number): number {
  const cap = Math.min(500, 25 * Math.pow(2, attempt));
  return Math.floor(Math.random() * cap);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function doc(collection: string, id: string, n: number): DocumentRecord {
  const data = { n, tag: `t${n % 17}`, payload: "x".repeat(64) };
  const now = new Date().toISOString();
  return {
    projectId: TENANT.projectId,
    path: `${collection}/${id}`,
    collectionPath: collection,
    collectionGroup: collection,
    documentId: id,
    pathDepth: 2,
    data,
    sizeBytes: JSON.stringify(data).length,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    expiresAt: null,
  };
}

async function seed(adapter: PgStorageAdapter): Promise<void> {
  const t0 = performance.now();
  for (let c = 0; c < COLLECTIONS; c += 1) {
    const collection = `bench/c${c}`;
    for (let off = 0; off < SEED_DOCS / COLLECTIONS; off += SEED_BATCH) {
      const rows: DocumentRecord[] = [];
      for (let i = 0; i < SEED_BATCH; i += 1) {
        const n = off + i;
        rows.push(doc(collection, `d${String(n).padStart(6, "0")}`, n));
      }
      await adapter.withTransaction(TENANT, async (tx) => {
        await (tx as { putDocumentRows(rows: DocumentRecord[]): Promise<void> }).putDocumentRows(rows);
      });
    }
  }
  console.log(`[seed] ${SEED_DOCS} docs in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

async function hotDoc(adapter: PgStorageAdapter, nowait: boolean): Promise<void> {
  const path = "bench/counter";
  await adapter.withTransaction(TENANT, async (tx) => {
    await (tx as { putDocumentRows(rows: DocumentRecord[]): Promise<void> }).putDocumentRows([
      doc("bench", "counter", 0),
    ]);
  });
  const lat: number[] = [];
  let conflicts = 0;
  let retries = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (let op = 0; op < OPS_PER_WORKER; op += 1) {
        const start = performance.now();
        for (let attempt = 0; ; attempt += 1) {
          try {
            await adapter.withTransaction(TENANT, async (tx) => {
              const row = await tx.getDocument(path, false, true, nowait);
              if (!row) throw new Error("counter missing");
              const applied = await tx.conditionalPutDocument(
                { ...row, version: row.version + 1, data: { ...row.data, n: (row.data.n as number) + 1 }, updatedAt: new Date().toISOString() },
                row.version
              );
              if (!applied.applied) {
                const err = new Error("cas lost");
                (err as { code?: string }).code = "ABORTED_CONFLICT";
                throw err;
              }
            });
            break;
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === "ABORTED_CONFLICT" && attempt < 40) {
              conflicts += 1;
              retries = Math.max(retries, attempt + 1);
              await sleep(jitter(attempt));
              continue;
            }
            throw error;
          }
        }
        lat.push(performance.now() - start);
      }
    })
  );
  const wall = (performance.now() - t0) / 1000;
  const final = await adapter.withTransaction(TENANT, async (tx) => tx.getDocument(path));
  console.log(
    `[hot-doc ${nowait ? "NOWAIT" : "WAIT  "}] ${stats(lat)} | conflicts=${conflicts} maxRetries=${retries} wall=${wall.toFixed(1)}s finalCounter=${final?.data.n}`
  );
}

async function outbox(adapter: PgStorageAdapter): Promise<void> {
  const a = adapter as unknown as {
    queryOutboxSafeWatermark(ctx: TenantContext): Promise<string>;
    queryOutboxSince(ctx: TenantContext, after?: string, upTo?: string): Promise<unknown[]>;
  };
  const wmLat: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    const t = performance.now();
    await a.queryOutboxSafeWatermark(TENANT);
    wmLat.push(performance.now() - t);
  }
  const safe = await a.queryOutboxSafeWatermark(TENANT);
  const pageLat: number[] = [];
  let cursor = "0";
  let fetched = 0;
  const upTo = BigInt(safe);
  const mid = (upTo / 2n).toString();
  for (let i = 0; i < 20; i += 1) {
    const t = performance.now();
    const rows = await a.queryOutboxSince(TENANT, cursor, mid);
    pageLat.push(performance.now() - t);
    fetched += rows.length;
    const last = rows[rows.length - 1] as { seqId: string } | undefined;
    if (!last) break;
    cursor = last.seqId;
  }
  console.log(`[outbox] safeWatermark at ~${SEED_DOCS} rows: ${stats(wmLat)}`);
  console.log(`[outbox] capped page fetch (500/page): ${stats(pageLat)} fetchedSample=${fetched} safeHead=${safe}`);
}

const adapter = new PgStorageAdapter({ connectionString: URL });
const outboxOnly = process.argv.includes("--outbox-only");
try {
  if (!outboxOnly) {
    await seed(adapter);
    await hotDoc(adapter, false);
    await hotDoc(adapter, true);
  }
  await outbox(adapter);
} finally {
  await adapter.close();
}
