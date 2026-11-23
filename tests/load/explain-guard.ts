/**
 * pure EXPLAIN plan guard used by `tests/load/explain-regression.ts`.
 * Extends (does not duplicate) the Query agent's `tests/integration/query/
 * query-sql.test.ts` assertion by (a) parsing structured `EXPLAIN (FORMAT JSON)`
 * output recursively and (b) failing on ANY sequential-scan node without
 * disabling `enable_seqscan` — so a missing index cannot be masked by planner
 * hints. No database dependency lives in this module.
 */

export interface PlanAnalysis {
  nodeTypes: string[];
  sequentialScans: string[];
  indexScans: string[];
  relationNames: string[];
}

function collectNodes(value: unknown, out: unknown[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["Node Type"] === "string") out.push(record);
  for (const child of Object.values(record)) collectNodes(child, out);
}

/** Analyze `EXPLAIN (FORMAT JSON)` rows (or a raw text plan) for scan nodes. */
export function analyzeExplainPlan(rows: unknown[]): PlanAnalysis {
  const nodes: unknown[] = [];
  collectNodes(rows, nodes);

  const nodeTypes: string[] = [];
  const sequentialScans: string[] = [];
  const indexScans: string[] = [];
  const relationNames: string[] = [];

  for (const raw of nodes) {
    const node = raw as Record<string, unknown>;
    const type = typeof node["Node Type"] === "string" ? node["Node Type"] : "Unknown";
    nodeTypes.push(type);
    const relation = typeof node["Relation Name"] === "string" ? node["Relation Name"] : undefined;
    if (relation !== undefined) relationNames.push(relation);
    if (/seq scan/i.test(type)) sequentialScans.push(relation ?? type);
    if (/index scan|bitmap.*scan/i.test(type)) indexScans.push(`${type}${relation === undefined ? "" : `:${relation}`}`);
  }

  // Structured plans are preferred; fall back to text for parity with the
  // existing e2e `explain-analyze.log` report.
  if (nodes.length === 0) {
    const text = rows.map((row) => JSON.stringify(row)).join("\n");
    const lines = text.split("\n");
    for (const line of lines) {
      const match = /\b(Index Scan|Bitmap Index Scan|Bitmap Heap Scan|Seq Scan|Parallel Seq Scan)\b/i.exec(line);
      if (match?.[1] !== undefined) nodeTypes.push(match[1]);
      if (/\b(Seq Scan|Parallel Seq Scan)\b/i.test(line)) sequentialScans.push(line.trim());
      if (/\b(Index Scan|Bitmap Index Scan)\b/i.test(line)) indexScans.push(line.trim());
    }
  }

  return { nodeTypes, sequentialScans, indexScans, relationNames };
}

/**
 * Fail the run when any indexed collection query falls back to a Seq Scan,
 * or when no index-backed scan is present at all.
 */
export function assertNoSeqScan(rows: unknown[], context: string): PlanAnalysis {
  const analysis = analyzeExplainPlan(rows);
  if (analysis.sequentialScans.length > 0) {
    throw new Error(
      `[load] EXPLAIN regression (${context}): Seq Scan detected on ${analysis.sequentialScans.join(", ")}. ` +
        `Observed nodes: ${analysis.nodeTypes.join(" -> ")}`
    );
  }
  if (analysis.indexScans.length === 0) {
    throw new Error(
      `[load] EXPLAIN regression (${context}): no index-backed scan found. Observed nodes: ${analysis.nodeTypes.join(" -> ")}`
    );
  }
  return analysis;
}
