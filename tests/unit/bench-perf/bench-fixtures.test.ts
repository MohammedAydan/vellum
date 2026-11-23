import { describe, it, expect } from "vitest";
import {
  compileQuery,
  decodeWire,
  encodeSortKey,
  encodeWire,
  makeNormalizedQuery,
  makeSortableDoc,
  makeWireDocument,
} from "./fixtures.js";
import { analyzeExplainPlan, assertNoSeqScan } from "../../load/explain-guard.js";

describe("benchmark fixtures (correctness gate)", () => {
  it("wire-format encode/decode round trips a tagged document", () => {
    const source = makeWireDocument(7);
    const encoded = encodeWire(source);
    expect(encoded.sizeBytes).toBeGreaterThan(0);
    expect(encoded.json.length).toBeGreaterThan(0);
    const decoded = decodeWire(encoded.json) as Record<string, unknown>;
    expect(decoded["name"]).toBe("user-7");
    expect((decoded["createdAt"] as { $t: string }).$t).toBe("ts");
    expect(decoded["profile"]).toBeDefined();
  });

  it("sort keys are deterministic and differ per document", () => {
    const first = makeSortableDoc(1);
    const second = makeSortableDoc(2);
    const keyA = encodeSortKey(first);
    const keyB = encodeSortKey(second);
    expect(Buffer.isBuffer(keyA)).toBe(true);
    expect(keyA.length).toBeGreaterThan(0);
    expect(keyA.equals(encodeSortKey(first))).toBe(true);
    expect(keyA.equals(keyB)).toBe(false);
  });

  it("query compilation yields parameterized, cursor-only SQL", () => {
    const normalized = makeNormalizedQuery();
    const unindexed = compileQuery(normalized, false);
    expect(unindexed.sql).toContain("d.project_id = $1::uuid");
    expect(unindexed.sql).not.toMatch(/\bOFFSET\b/i);
    expect(unindexed.params).toContain("customers");

    const indexed = compileQuery(normalized, true);
    expect(indexed.compositeIndexId).toBe("33333333-3333-3333-3333-333333333333");
    expect(indexed.sql).toContain("document_index_entries");
  });
});

describe("EXPLAIN guard", () => {
  it("accepts a structured plan with only index scans", () => {
    const rows = [
      {
        "QUERY PLAN": [
          {
            Plan: {
              "Node Type": "Index Scan",
              "Relation Name": "documents",
              Plans: [{ "Node Type": "Bitmap Index Scan", "Index Name": "idx_docs_data_gin_active" }],
            },
          },
        ],
      },
    ];
    const analysis = analyzeExplainPlan(rows);
    expect(analysis.sequentialScans).toEqual([]);
    expect(analysis.indexScans.length).toBe(2);
    expect(() => assertNoSeqScan(rows, "test-indexed")).not.toThrow();
  });

  it("fails on a nested Seq Scan node", () => {
    const rows = [
      {
        "QUERY PLAN": [
          {
            Plan: {
              "Node Type": "Nested Loop",
              Plans: [
                { "Node Type": "Index Scan", "Relation Name": "document_index_entries" },
                { "Node Type": "Seq Scan", "Relation Name": "documents" },
              ],
            },
          },
        ],
      },
    ];
    expect(() => assertNoSeqScan(rows, "test-regression")).toThrow(/Seq Scan.*documents/);
  });

  it("fails when no index-backed scan exists and parses text plans", () => {
    expect(() => assertNoSeqScan([{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }], "no-index")).toThrow(
      /no index-backed scan/
    );
    const textPlan = [{ "QUERY PLAN": "Seq Scan on documents" }];
    expect(analyzeExplainPlan(textPlan).sequentialScans.length).toBe(1);
  });
});
