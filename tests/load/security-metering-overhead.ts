/**
 * Security/billing hot-path overhead benchmark (runnable tsx script).
 *
 * Measures 10,000 representative hot-path operations with the full fortress
 * stack active (payload guard + query-cost guard + O(1) quota check + O(1)
 * metering delta) against a baseline performing only the underlying in-memory
 * increment. All timings use `process.hrtime.bigint()`; nothing is invented.
 *
 * Usage:
 *   corepack pnpm exec tsx tests/load/security-metering-overhead.ts
 *   PHASE5_REAL=1 corepack pnpm exec tsx tests/load/security-metering-overhead.ts
 *
 * With PHASE5_REAL=1 a handful of real Neon reads are also routed through the
 * same quota/metering hooks and both memory-adapter and live numbers are
 * written to docs/evidence/SECURITY-BILLING-PERFORMANCE.md.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRawPgClient } from "../../packages/database-control/src/index.js";
import { ControlPlaneStore } from "../../packages/database-control/src/adapters.js";
import { DocumentEngine } from "../../packages/document-engine/src/index.js";
import { PgStorageAdapter } from "../../packages/storage/src/adapters.js";
import {
  QuotaGuard,
  UsageMeteringEngine,
} from "../../packages/billing/src/index.js";
import {
  assertQueryCost,
  assertSafeJsonPayload,
  deriveChainKey,
} from "../../packages/security/src/index.js";
import { withTenantData } from "../e2e-real/tenant-data-sql.js";
import { ensureLiveEnv } from "../integration/_live-env.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = path.join(ROOT, "docs", "evidence", "SECURITY-BILLING-PERFORMANCE.md");
const REAL = process.env.PHASE5_REAL === "1";
if (REAL) ensureLiveEnv();

const ITERATIONS = 10_000;
const WARMUP = 1_000;
const LIVE_READS = 5;
const BUDGET_MS = 0.5;

interface SampleSet {
  name: string;
  iterations: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function summarize(name: string, samples: number[]): SampleSet {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1);
  const round = (value: number): number => Number(value.toFixed(6));
  return {
    name,
    iterations: sorted.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    meanMs: round(mean),
  };
}

function measure(name: string, iterations: number, fn: () => void): SampleSet {
  for (let i = 0; i < WARMUP; i += 1) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  return summarize(name, samples);
}

function table(rows: readonly SampleSet[]): string {
  const lines = [
    "| Case | Iterations | p50 (ms) | p95 (ms) | Mean (ms) |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${row.iterations} | ${row.p50Ms} | ${row.p95Ms} | ${row.meanMs} |`
    );
  }
  return lines.join("\n");
}

interface LiveResult {
  samples: number[];
  summary: SampleSet;
  mode: string;
}

async function runLiveReads(): Promise<LiveResult | null> {
  const dataUrl = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL;
  if (!dataUrl) return null;

  const orgId = randomUUID();
  const projectId = randomUUID();
  const tenant = { projectId };
  const path = `security_bench_${randomUUID().replace(/-/g, "").slice(0, 10)}/docs/items/bench_doc`;
  const prefix = path.split("/")[0] ?? "security_bench";

  // Node 20 has no global WebSocket, so the node-postgres adapter is the real
  // live path here (the Neon serverless adapter needs a WebSocket constructor).
  const store = new PgStorageAdapter({ connectionString: dataUrl });
  const rawClient = createRawPgClient({
    connectionString: dataUrl,
    applicationName: "vellum-task5a-overhead",
  });
  try {
    await rawClient.connect();
    const billing = new ControlPlaneStore().billing;
    const chainKey = deriveChainKey("overhead-bench-master-v1", "billing-ledger-v1");
    const metering = new UsageMeteringEngine({ billing, chainKey });
    const quota = new QuotaGuard({
      billing,
      chainKey,
      usageProvider: (id) => metering.totalsFor(id),
    });
    await quota.refreshPlans();
    quota.refreshFromStore([await billing.ensureSubscription(orgId)]);

    const controlStore = { getActiveRuleset: () => null, incrementUsage: () => undefined };
    const engine = new DocumentEngine({ controlStore, dataStore: store });
    await engine.createDocument({ ...tenant, path, data: { bench: true, value: 42 } });

    const samples: number[] = [];
    for (let i = 0; i < LIVE_READS; i += 1) {
      const decision = quota.checkQuota(orgId, "read");
      if (!decision.allowed) throw new Error(`quota guard blocked the live read: ${decision.code}`);
      const started = process.hrtime.bigint();
      await store.withTransaction(tenant, (tx) => tx.getDocument(path));
      metering.recordReads(orgId, projectId, 1);
      samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
    }
    return {
      samples,
      summary: summarize("real Neon document read through quota + metering hooks", samples),
      mode: "live Neon/PostgreSQL data plane",
    };
  } finally {
    await withTenantData(rawClient, projectId, async (tx) => {
      await tx.query("DELETE FROM documents WHERE path LIKE $1 || '%'", [prefix]);
    });
    await rawClient.end();
    await store.close();
  }
}

async function main(): Promise<void> {
  const control = new ControlPlaneStore();
  const chainKey = deriveChainKey("overhead-bench-master-v1", "billing-ledger-v1");
  const metering = new UsageMeteringEngine({ billing: control.billing, chainKey });
  const quota = new QuotaGuard({
    billing: control.billing,
    chainKey,
    usageProvider: (orgId) => metering.totalsFor(orgId),
  });
  await quota.refreshPlans();
  const orgId = randomUUID();
  const projectId = randomUUID();
  quota.refreshFromStore([await control.billing.ensureSubscription(orgId)]);

  const payload = { data: { bench: true, nested: { value: 42, tags: ["a", "b", "c"] } } };
  const query = {
    collectionPath: "bench/items",
    where: [{ field: "status", op: "==", value: "open" }],
    limit: 50,
  };
  // Ensure the guards accept the sample before timing the guarded loop.
  if (!assertSafeJsonPayload(payload).ok || !assertQueryCost(query).ok) {
    throw new Error("benchmark fixture rejected by the security guards");
  }

  let baselineCounter = 0;
  const baseline = measure(
    "baseline (in-memory counter only)",
    ITERATIONS,
    () => {
      baselineCounter += 1;
    }
  );
  const guarded = measure(
    "guarded (payload + query + quota + metering)",
    ITERATIONS,
    () => {
      assertSafeJsonPayload(payload);
      assertQueryCost(query);
      if (!quota.checkQuota(orgId, "read").allowed) throw new Error("unexpected quota denial");
      metering.recordReads(orgId, projectId, 1);
    }
  );

  const addedOverheadMs = Number((guarded.p50Ms - baseline.p50Ms).toFixed(6));
  const addedOverheadP95Ms = Number((guarded.p95Ms - baseline.p95Ms).toFixed(6));
  const budget = REAL ? "memory-adapter benchmark" : "memory-adapter benchmark";
  const result = {
    mode: "memory-adapter",
    iterationsPerCase: ITERATIONS,
    warmup: WARMUP,
    p50Ms: guarded.p50Ms,
    p95Ms: guarded.p95Ms,
    addedOverheadMs,
    addedOverheadP95Ms,
    budgetMs: BUDGET_MS,
    withinBudget: addedOverheadMs < BUDGET_MS,
    baseline,
    guarded,
    baselineCounter,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.withinBudget) {
    throw new Error(
      `added hot-path overhead ${addedOverheadMs} ms exceeds the ${BUDGET_MS} ms budget`
    );
  }

  let live: LiveResult | null = null;
  if (REAL) {
    live = await runLiveReads();
    if (live === null) {
      console.log(JSON.stringify({ live: "not measured: DATA_DATABASE_URL unavailable" }));
    } else {
      console.log(
        JSON.stringify({
          mode: live.mode,
          iterations: live.samples.length,
          p50Ms: live.summary.p50Ms,
          p95Ms: live.summary.p95Ms,
        })
      );
    }
  }

  const generated = new Date().toISOString();
  const liveSection =
    live === null
      ? REAL
        ? "_Live mode was requested but `DATA_DATABASE_URL[_DIRECT]` was unavailable, so no live numbers were measured._"
        : "_Live Neon numbers were not measured in this invocation (run with `PHASE5_REAL=1`)._"
      : `**Mode: live Neon/PostgreSQL data plane** — ${live.samples.length} real document reads, each preceded by an O(1) quota check and followed by an O(1) metering delta.\n\n${table([live.summary])}\n\nRaw samples (ms): ${live.samples.map((value) => value.toFixed(6)).join(", ")}.`;

  const report = `# Security & Billing Performance Evidence

Generated: ${generated}
Budget: added in-process hot-path overhead **< ${BUDGET_MS} ms** (p50).
Timing: \`process.hrtime.bigint()\` around real guard/quota/metering calls. No synthetic delays or estimated values.

## In-process benchmark — in-memory adapter (no database)

**Mode: ${budget}.** ${ITERATIONS} measured iterations per case after ${WARMUP} warmups.
The guarded case runs \`assertSafeJsonPayload\`, \`assertQueryCost\`, \`QuotaGuard.checkQuota\`
and \`UsageMeteringEngine.recordReads\`; the baseline performs only the equivalent
in-memory counter increment. Both cases pay the same timer and sample-array cost.

${table([baseline, guarded])}

- p50: **${guarded.p50Ms} ms** guarded vs **${baseline.p50Ms} ms** baseline.
- p95: **${guarded.p95Ms} ms** guarded vs **${baseline.p95Ms} ms** baseline.
- Added overhead (p50): **${addedOverheadMs} ms** — ${result.withinBudget ? "within" : "OVER"} the ${BUDGET_MS} ms budget.
- Added overhead (p95): **${addedOverheadP95Ms} ms**.

## Live Neon measurements

${liveSection}

## Reproduce

\`\`\`bash
cd /home/ubuntu/projects/document-db
corepack pnpm exec tsx tests/load/security-metering-overhead.ts
# with live Neon reads added:
PHASE5_REAL=1 corepack pnpm exec tsx tests/load/security-metering-overhead.ts
\`\`\`
`;
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, report, "utf8");
  console.log(`Wrote ${path.relative(ROOT, EVIDENCE)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
