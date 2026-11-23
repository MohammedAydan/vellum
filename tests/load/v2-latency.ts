/**
 * V2 latency benchmark — measured, never invented.
 *
 * Compares two V2 performance changes with real code paths:
 *   (a) single-transaction (single-roundtrip) tenant/document fan-out read vs
 *       a legacy 4-roundtrip sequence of four separate reads;
 *   (b) the same representative two-equality-field query before and after a
 *       composite index is built through the real index builder worker.
 *
 * By default it runs against the in-memory adapter (no database required).
 * Set `PHASE5_REAL=1` with DATA_DATABASE_URL[_DIRECT] to run the exact same
 * benchmark against a real Neon/PostgreSQL data plane under an isolated random
 * tenant. Every row created in real mode is removed afterwards.
 *
 * Usage:
 *   corepack pnpm exec tsx tests/load/v2-latency.ts
 *   PHASE5_REAL=1 corepack pnpm exec tsx tests/load/v2-latency.ts
 *
 * Results (with p50/p95 from the actual run) are printed and written to
 * `docs/evidence/V2-PERFORMANCE.md`.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type StorageAdapter } from "../../packages/storage/src/index.js";
import { DataPlaneStore, NeonStorageAdapter } from "../../packages/storage/src/adapters.js";
import { DocumentEngine } from "../../packages/document-engine/src/index.js";
import { createRawPgClient } from "../../packages/database-control/src/index.js";
import { withTenantData } from "../e2e-real/tenant-data-sql.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = path.join(ROOT, "docs", "evidence", "V2-PERFORMANCE.md");
const REAL = process.env.PHASE5_REAL === "1";
const ITERATIONS = 400;
const WARMUP = 50;
const DOC_COUNT = 300;

const projectId = randomUUID();
const TENANT = { projectId };
const PREFIX = `v2bench_${randomUUID().replace(/-/g, "").slice(0, 10)}_`;

const controlStore = {
  getActiveRuleset: () => null,
  incrementUsage: () => undefined,
};

interface Sample {
  name: string;
  p50: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
  iterations: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function measure(name: string, fn: () => Promise<unknown>): Promise<Sample> {
  for (let i = 0; i < WARMUP; i += 1) await fn();
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  return {
    name,
    p50: Number(percentile(samples, 0.5).toFixed(4)),
    p95: Number(percentile(samples, 0.95).toFixed(4)),
    mean: Number((sum / samples.length).toFixed(4)),
    min: Number(samples[0]!.toFixed(4)),
    max: Number(samples[samples.length - 1]!.toFixed(4)),
    iterations: samples.length,
  };
}

function table(samples: Sample[]): string {
  const lines = [
    "| Case | Iterations | p50 (ms) | p95 (ms) | Mean (ms) | Min (ms) | Max (ms) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const s of samples) {
    lines.push(
      `| ${s.name} | ${s.iterations} | ${s.p50} | ${s.p95} | ${s.mean} | ${s.min} | ${s.max} |`
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  let store: StorageAdapter;
  let rawClient: Awaited<ReturnType<typeof createRawPgClient>> | undefined;
  if (REAL) {
    const url = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL;
    if (!url) throw new Error("PHASE5_REAL=1 requires DATA_DATABASE_URL[_DIRECT]");
    store = new NeonStorageAdapter({ connectionString: url });
    rawClient = createRawPgClient({ connectionString: url, applicationName: "vellum-v2-latency" });
    await rawClient.connect();
  } else {
    store = new DataPlaneStore();
  }
  const engine = new DocumentEngine({ controlStore, dataStore: store });

  try {
    const paths: string[] = [];
    for (let i = 0; i < DOC_COUNT; i += 1) {
      const path = `${PREFIX}docs/d_${String(i).padStart(4, "0")}`;
      paths.push(path);
      await engine.createDocument({
        ...TENANT,
        path,
        data: {
          group: i % 3 === 0 ? "alpha" : "beta",
          status: i % 2 === 0 ? "open" : "closed",
          score: i % 97,
        },
      });
    }

    // (a) One transaction with a single batch read (single-batch hot path) vs four
    // separate transactions — four real round trips in the legacy client.
    const fourPaths = paths.slice(0, 4);
    const single = await measure("single-roundtrip batch read (4 docs, 1 transaction)", async () =>
      store.withTransaction(TENANT, (tx) => tx.batchGetDocuments!(fourPaths))
    );
    const legacy = await measure("legacy 4-roundtrip reads (4 x getDocument)", async () => {
      const rows = [];
      for (const p of fourPaths) rows.push(await store.getDocument(TENANT, p));
      return rows;
    });

    // (b) Representative composite query. A two-equality-field query with no
    // custom sort needs a composite index for the advisor, but the engine can
    // execute it either way, so both paths are measured on identical data.
    const querySpec = {
      collectionPath: `${PREFIX}docs`,
      where: [
        { field: "group", op: "==", value: "alpha" },
        { field: "status", op: "==", value: "open" },
      ],
      orderBy: [{ field: "documentId", dir: "asc" }],
      limit: 50,
    };
    const unindexed = await measure("unindexed composite query", () =>
      engine.executeQuery({ ...TENANT, querySpec })
    );

    await store.createCompositeIndex(
      TENANT,
      `${PREFIX}docs`,
      [
        { path: "group", dir: "asc" },
        { path: "status", dir: "asc" },
      ]
    );
    await store.runIndexBuilderWorker();
    const indexed = await measure("composite-index-backed query", () =>
      engine.executeQuery({ ...TENANT, querySpec })
    );

    const samples = [single, legacy, unindexed, indexed];
    const mode = REAL ? "real Neon/PostgreSQL data plane" : "in-memory adapter (no database)";
    const generated = new Date().toISOString();
    const report = `# V2 Performance Evidence

Generated: ${generated}
Mode: **${mode}**
Dataset: ${DOC_COUNT} documents in one isolated tenant; ${ITERATIONS} measured iterations per case after ${WARMUP} warmups.
Timing: wall-clock \`performance.now()\` around real adapter/engine calls. No synthetic delays, no estimated values.

## What is measured

- **single-roundtrip batch read** — one \`withTransaction\` with a single
  \`batchGetDocuments\` call fetching four documents (the tenant
  fan-out path).
- **legacy 4-roundtrip reads** — four independent \`getDocument\` calls, each
  opening its own tenant transaction (the legacy client shape).
- **unindexed composite query** — \`DocumentEngine.executeQuery\` with two
  equality filters and no matching composite index.
- **composite-index-backed query** — the identical query after creating the
  recommended index in \`document_indexes\` and running the real index builder
  worker.

${REAL ? "Network, connection-pool and SQL planning costs are included." : "This run used the in-memory adapter: there is no network or SQL engine cost. The numbers measure the real in-process code paths (transaction boundaries, batch vs per-document reads, index selection and evaluator work) and are labelled accordingly."}

## Measured results

${table(samples)}

## Interpretation

- Batch-vs-legacy compares the number of real transaction boundaries (1 vs 4).
- Index-vs-unindexed compares identical query text with and without a ready
  composite index in the tenant's index metadata.
- Ratios below are derived from the measured p50 values above.

Batch p50 speedup: **${(legacy.p50 / single.p50).toFixed(2)}x** (${single.p50} ms vs ${legacy.p50} ms).
Indexed query p50 ratio vs unindexed: **${(indexed.p50 / unindexed.p50).toFixed(2)}x** (${indexed.p50} ms vs ${unindexed.p50} ms).

## Reproduce

\`\`\`bash
cd /home/ubuntu/projects/document-db
corepack pnpm exec tsx tests/load/v2-latency.ts
# or, against a real Neon data plane:
PHASE5_REAL=1 corepack pnpm exec tsx tests/load/v2-latency.ts
\`\`\`
`;
    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    fs.writeFileSync(EVIDENCE, report, "utf8");
    console.log(report);
  } finally {
    if (REAL && rawClient) {
      await withTenantData(rawClient, projectId, async (tx) => {
        await tx.query("DELETE FROM realtime_outbox WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM document_index_entries WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM document_indexes WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
      });
      await rawClient.end();
    }
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
