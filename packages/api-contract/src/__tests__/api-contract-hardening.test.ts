import { describe, it, expect } from "vitest";
import {
  validateClientWsFrame,
  CreateDocumentRequestSchema,
  TaggedBytesSchema,
  TaggedInt64Schema,
  QuerySpecSchema,
  OrGroupsSchema,
  DotPathSchema,
  CommitTransactionSchema,
  SignUpEmailRequestSchema,
  InvoiceGenerateSchema,
  AggregateRequestSchema,
} from "../index.js";
import { VellumError } from "@vellum/core";

describe("@vellum/api-contract hardening", () => {
  describe("WebSocket frame validation", () => {
    it("rejects prototype pollution, control characters, and non-finite ping timestamps", () => {
      const polluted = JSON.parse('{"type":"ping","ts":123,"__proto__":{"admin":true}}') as unknown;
      expect(() => validateClientWsFrame(polluted)).toThrow(VellumError);

      expect(() =>
        validateClientWsFrame({ type: "ping", ts: Number.POSITIVE_INFINITY })
      ).toThrow(VellumError);

      expect(() =>
        validateClientWsFrame({ type: "auth", projectId: "proj\r\n", apiKey: "pk_123" })
      ).toThrow(VellumError);
    });
  });

  describe("Document & tagged value bounds", () => {
    it("rejects prototype-pollution keys and excessive nesting depth in DocumentDataSchema", () => {
      const polluted = JSON.parse('{"data":{"__proto__":{"isAdmin":true}}}') as unknown;
      expect(CreateDocumentRequestSchema.safeParse(polluted).success).toBe(false);

      let deep: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 25; i++) {
        deep = { nested: deep };
      }
      expect(CreateDocumentRequestSchema.safeParse({ data: deep }).success).toBe(false);
    });

    it("enforces int64 range and linear-time base64 validation", () => {
      expect(TaggedInt64Schema.safeParse({ $t: "int", $v: "99999999999999999999" }).success).toBe(false);
      expect(TaggedBytesSchema.safeParse({ $t: "bytes", $v: "aGVsbG8=" }).success).toBe(true);
      expect(TaggedBytesSchema.safeParse({ $t: "bytes", $v: "not-valid!" }).success).toBe(false);
    });
  });

  describe("Query, batch, auth & admin bounds", () => {
    it("rejects prototype-pollution dot paths and oversized OR inner groups", () => {
      expect(DotPathSchema.safeParse("user.__proto__.role").success).toBe(false);
      expect(DotPathSchema.safeParse("a.b.c.d.e.f.g.h.i.j.k").success).toBe(false);

      const tooManyInGroup = Array.from({ length: 20 }, (_, i) => ({
        field: `f${i}`,
        op: "==" as const,
        value: i,
      }));
      expect(OrGroupsSchema.safeParse([tooManyInGroup]).success).toBe(false);
      expect(
        QuerySpecSchema.safeParse({
          collectionPath: "posts",
          where: [{ field: "title", op: "text_search", value: "a".repeat(201) }],
        }).success
      ).toBe(false);
    });

    it("rejects prototype pollution in auth metadata and invalid calendar months", () => {
      const pollutedAuth = JSON.parse(
        '{"email":"a@b.com","password":"password123","metadata":{"constructor":{"x":1}}}'
      ) as unknown;
      expect(SignUpEmailRequestSchema.safeParse(pollutedAuth).success).toBe(false);
      expect(InvoiceGenerateSchema.safeParse({ billingMonth: "2026-13" }).success).toBe(false);
    });

    it("caps transaction read sets and aggregate metrics", () => {
      const hugeReads = Array.from({ length: 501 }, (_, i) => ({
        path: `users/u_${i}`,
        readVersion: 1,
      }));
      expect(
        CommitTransactionSchema.safeParse({
          transactionToken: "tok_123",
          mutations: [],
          reads: hugeReads,
        }).success
      ).toBe(false);

      const tooManyMetrics: Record<string, { op: "count" }> = {};
      for (let i = 0; i < 21; i++) {
        tooManyMetrics[`m_${i}`] = { op: "count" };
      }
      expect(
        AggregateRequestSchema.safeParse({
          collectionPath: "orders",
          metrics: tooManyMetrics,
        }).success
      ).toBe(false);
    });

    it("accepts SDK/Flutter QuerySpec payloads with dir, null select/cursors, cursor strings, and resumeSeqId", () => {
      const sdkQuery = {
        collectionPath: "orders",
        where: [
          { field: "status", op: "==", value: "open" },
          { field: "title", op: "contains_ci", value: "inv" },
          { field: "title", op: "starts_with_ci", value: "INV" },
          { field: "body", op: "text_search", value: "paid" },
        ],
        or: [[{ field: "priority", op: ">=", value: 2 }]],
        orderBy: [{ field: "createdAt", dir: "desc" }],
        limit: 50,
        select: null,
        startAt: null,
        startAfter: "opaque-hmac-cursor",
      };
      const parsed = QuerySpecSchema.safeParse(sdkQuery);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.orderBy[0]?.direction).toBe("desc");
        expect(parsed.data.startAfter).toBe("opaque-hmac-cursor");
      }

      const sub = validateClientWsFrame({
        type: "subscribe",
        subId: "sub_sdk_1",
        query: sdkQuery,
        resumeSeqId: 42,
      });
      expect(sub.type).toBe("subscribe");
    });
  });
});
