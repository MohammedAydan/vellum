import { describe, it, expect } from "vitest";
import {
  ThreatDetector,
  assertSafeJsonPayload,
  assertQueryCost,
  assertSafeExternalUrl,
  SsrfBlockedError,
  verifyCsrfOrigin,
  canonicalSerialize,
  computeChainHash,
  deriveChainKey,
  verifyHashChain,
  timingSafeStringEqual,
} from "../index.js";

describe("@vellum/security hardening", () => {
  describe("ThreatDetector memory bounds, O(1) LRU & sanitization", () => {
    it("caps tracked IPs and stored events under flooding", () => {
      const detector = new ThreatDetector();
      for (let i = 0; i < 10_250; i++) {
        detector.record({
          severity: "low",
          category: "brute_force",
          sourceIp: `10.0.${Math.floor(i / 256)}.${i % 256}`,
          summary: "flood",
          evidence: { i },
        });
      }
      const stats = detector.stats();
      expect(stats.trackedIps).toBeLessThanOrEqual(10_000);
      expect(stats.events).toBeLessThanOrEqual(10_000);
    });

    it("sanitizes control characters and ignores non-finite TTLs", () => {
      const detector = new ThreatDetector();
      detector.block("ip", "1.2.3.4\r\nX-Injected: 1", "bad\r\nactor", Number.NaN);
      expect(detector.isBlocked("ip", "1.2.3.4X-Injected: 1").blocked).toBe(false);

      detector.block("ip", "203.0.113.10\n", "abusive", 60_000);
      const decision = detector.isBlocked("ip", "203.0.113.10");
      expect(decision.blocked).toBe(true);
    });
  });

  describe("Hash chain & constant-time comparison", () => {
    it("compares strings in constant time across equal and unequal lengths", () => {
      expect(timingSafeStringEqual("secret-token-123", "secret-token-123")).toBe(true);
      expect(timingSafeStringEqual("secret-token-123", "secret-token-124")).toBe(false);
      expect(timingSafeStringEqual("short", "much-longer-secret")).toBe(false);
    });

    it("handles cyclic objects safely in canonicalSerialize", () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic["self"] = cyclic;
      expect(canonicalSerialize(cyclic)).toBe('{"a":1,"self":"[Circular]"}');
    });

    it("verifies chain using constant-time prevHash and entryHash checks", () => {
      const key = deriveChainKey("master-secret", "security-audit-v1");
      const genesis = "0".repeat(64);
      const ts = "2026-11-21T00:00:00.000Z";
      const hash1 = computeChainHash(key, 1, genesis, ts, { ok: true });
      const res = verifyHashChain(key, [
        { seq: 1, prevHash: genesis, entryHash: hash1, timestampIso: ts, payload: { ok: true } },
      ]);
      expect(res.valid).toBe(true);
    });
  });

  describe("Payload & query cost guards", () => {
    it("rejects non-enumerable prototype pollution keys and oversized payloads", () => {
      const obj: Record<string, unknown> = {};
      Object.defineProperty(obj, "__proto__", { value: { admin: true }, enumerable: false });
      const res = assertSafeJsonPayload(obj);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.threatCategory).toBe("prototype_pollution");

      const big = assertSafeJsonPayload(
        { text: "a".repeat(200) },
        { maxDocumentBytes: 100, maxBatchBytes: 500, maxJsonDepth: 10, maxObjectKeys: 10, maxArrayLength: 10 }
      );
      expect(big.ok).toBe(false);
    });

    it("rejects NaN limits and prototype pollution in query cost guard", () => {
      expect(assertQueryCost({ limit: Number.NaN }).ok).toBe(false);
      const polluted = JSON.parse('{"__proto__":{"isAdmin":true}}') as unknown;
      const res = assertQueryCost(polluted);
      expect(res.ok).toBe(false);
    });
  });

  describe("CSRF & SSRF guards", () => {
    it("rejects control chars and duplicate-slash bypass in CSRF origin check", () => {
      const res = verifyCsrfOrigin(
        { method: "POST", path: "//v1/admin/users", origin: "https://app.example.com\r\n", cookieAuthenticated: true },
        ["https://app.example.com"]
      );
      expect(res.ok).toBe(false);
    });

    it("blocks internal hostnames and control chars in SSRF guard", async () => {
      await expect(assertSafeExternalUrl("https://metadata.google.internal/computeMetadata")).rejects.toThrow(SsrfBlockedError);
      await expect(assertSafeExternalUrl("https://example.com/\r\n")).rejects.toThrow(SsrfBlockedError);
    });
  });
});
