/**
 * @vellum/security - Defensive JSON payload guard.
 *
 * A single recursive walk rejects prototype-pollution keys (including
 * non-enumerable own properties), excessive nesting/key counts/array lengths,
 * oversized UTF-8 string payloads, NUL bytes in strings and cyclic object
 * graphs. The guard never throws: every outcome is returned to the caller,
 * which maps failures to a `400 INVALID_ARGUMENT` response at the API edge.
 */

import type { ThreatCategory } from "./types.js";

export interface PayloadLimits {
  maxDocumentBytes: number;
  maxBatchBytes: number;
  maxJsonDepth: number;
  maxObjectKeys: number;
  maxArrayLength: number;
}

export const PAYLOAD_LIMITS: Readonly<PayloadLimits> = Object.freeze({
  maxDocumentBytes: 1_048_576,
  maxBatchBytes: 5_242_880,
  maxJsonDepth: 20,
  maxObjectKeys: 500,
  maxArrayLength: 5_000,
});

export type GuardOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string; threatCategory?: ThreatCategory };

const OK: GuardOutcome = { ok: true };

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const NUL = "\u0000";

function failure(code: string, message: string, threatCategory?: ThreatCategory): GuardOutcome {
  // `exactOptionalPropertyTypes` forbids writing `threatCategory: undefined`.
  return threatCategory === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, threatCategory };
}

function resolveLimit(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

/**
 * Validate an untrusted JSON-like value in one pass.
 *
 * Depth is counted the same way as `@vellum/core`'s wire validator: the root
 * value is depth 0 and a child is one level deeper than its parent.
 */
export function assertSafeJsonPayload(
  value: unknown,
  limits: Readonly<PayloadLimits> = PAYLOAD_LIMITS,
): GuardOutcome {
  const maxJsonDepth = resolveLimit(limits.maxJsonDepth, PAYLOAD_LIMITS.maxJsonDepth);
  const maxObjectKeys = resolveLimit(limits.maxObjectKeys, PAYLOAD_LIMITS.maxObjectKeys);
  const maxArrayLength = resolveLimit(limits.maxArrayLength, PAYLOAD_LIMITS.maxArrayLength);
  const maxDocumentBytes = resolveLimit(limits.maxDocumentBytes, PAYLOAD_LIMITS.maxDocumentBytes);

  let totalKeys = 0;
  let estimatedBytes = 0;
  const visited = new WeakSet<object>();

  const walk = (node: unknown, depth: number): GuardOutcome => {
    if (depth > maxJsonDepth) {
      return failure("MAX_NESTING_EXCEEDED", `JSON nesting depth exceeds ${maxJsonDepth}`);
    }

    if (typeof node === "string") {
      if (node.includes(NUL)) {
        return failure("INVALID_ARGUMENT", "NUL byte detected in string value");
      }
      estimatedBytes += Buffer.byteLength(node, "utf8");
      if (estimatedBytes > maxDocumentBytes) {
        return failure("DOCUMENT_TOO_LARGE", `Payload size exceeds ${maxDocumentBytes} bytes`);
      }
      return OK;
    }

    if (node === null || typeof node !== "object") {
      return OK;
    }

    // Shared/repeated references are treated as cycles: fail closed rather
    // than recursing forever (or accepting an aliased attack graph).
    if (visited.has(node)) {
      return failure("INVALID_ARGUMENT", "Cyclic object graph detected in payload");
    }
    visited.add(node);

    if (Array.isArray(node)) {
      if (node.length > maxArrayLength) {
        return failure("INVALID_ARGUMENT", `Array length exceeds ${maxArrayLength}`);
      }
      for (let i = 0; i < node.length; i++) {
        const outcome = walk(node[i], depth + 1);
        if (!outcome.ok) {
          return outcome;
        }
      }
      return OK;
    }

    // Check all own property names (including non-enumerable) for prototype pollution.
    for (const key of Object.getOwnPropertyNames(node)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return failure(
          "INVALID_ARGUMENT",
          `Forbidden object key '${key}' in payload`,
          "prototype_pollution",
        );
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key.includes(NUL)) {
        return failure("INVALID_ARGUMENT", "NUL byte detected in object key");
      }

      estimatedBytes += Buffer.byteLength(key, "utf8");
      if (estimatedBytes > maxDocumentBytes) {
        return failure("DOCUMENT_TOO_LARGE", `Payload size exceeds ${maxDocumentBytes} bytes`);
      }

      totalKeys += 1;
      if (totalKeys > maxObjectKeys) {
        return failure("INVALID_ARGUMENT", `Total object keys exceed ${maxObjectKeys}`);
      }

      const outcome = walk(child, depth + 1);
      if (!outcome.ok) {
        return outcome;
      }
    }

    return OK;
  };

  return walk(value, 0);
}
