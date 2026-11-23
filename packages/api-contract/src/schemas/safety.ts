/**
 * @vellum/api-contract - Internal payload safety & prototype-pollution guards.
 *
 * Shared by HTTP and WebSocket Zod schemas to reject prototype-pollution keys
 * (`__proto__`, `constructor`, `prototype`), NUL bytes, cyclic object graphs,
 * excessive nesting depth, key counts, array lengths, and byte sizes without
 * adding any external dependencies.
 */

import { z } from "zod";

export const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
const NUL = "\u0000";

export interface PayloadSafetyBounds {
  maxDepth?: number;
  maxKeys?: number;
  maxArrayLength?: number;
  maxBytes?: number;
}

export type PayloadSafetyResult = { ok: true } | { ok: false; message: string };

const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_MAX_KEYS = 500;
const DEFAULT_MAX_ARRAY_LENGTH = 5_000;
const DEFAULT_MAX_BYTES = 1_048_576;

/**
 * Single-pass structural guard over untrusted JSON-like values.
 */
export function validateSafePayload(
  value: unknown,
  bounds: PayloadSafetyBounds = {}
): PayloadSafetyResult {
  const maxDepth = bounds.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxKeys = bounds.maxKeys ?? DEFAULT_MAX_KEYS;
  const maxArrayLength = bounds.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const maxBytes = bounds.maxBytes ?? DEFAULT_MAX_BYTES;

  let totalKeys = 0;
  let estimatedBytes = 0;
  const visited = new WeakSet<object>();

  const walk = (node: unknown, depth: number): PayloadSafetyResult => {
    if (depth > maxDepth) {
      return { ok: false, message: `Payload nesting depth exceeds maximum of ${maxDepth}` };
    }
    if (typeof node === "string") {
      if (node.includes(NUL)) {
        return { ok: false, message: "NUL byte is not allowed in string values" };
      }
      estimatedBytes += Buffer.byteLength(node, "utf8");
      if (estimatedBytes > maxBytes) {
        return { ok: false, message: `Payload size exceeds maximum of ${maxBytes} bytes` };
      }
      return { ok: true };
    }
    if (node === null || typeof node !== "object") {
      return { ok: true };
    }
    if (visited.has(node)) {
      return { ok: false, message: "Cyclic object reference is not allowed" };
    }
    visited.add(node);

    if (Array.isArray(node)) {
      if (node.length > maxArrayLength) {
        return { ok: false, message: `Array length exceeds maximum of ${maxArrayLength}` };
      }
      for (let i = 0; i < node.length; i++) {
        const res = walk(node[i], depth + 1);
        if (!res.ok) return res;
      }
      return { ok: true };
    }

    for (const key of Object.getOwnPropertyNames(node)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        return { ok: false, message: `Forbidden object key '${key}' is not allowed` };
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key.includes(NUL)) {
        return { ok: false, message: "NUL byte is not allowed in object keys" };
      }
      estimatedBytes += Buffer.byteLength(key, "utf8");
      if (estimatedBytes > maxBytes) {
        return { ok: false, message: `Payload size exceeds maximum of ${maxBytes} bytes` };
      }
      totalKeys += 1;
      if (totalKeys > maxKeys) {
        return { ok: false, message: `Object key count exceeds maximum of ${maxKeys}` };
      }
      const res = walk(child, depth + 1);
      if (!res.ok) return res;
    }

    return { ok: true };
  };

  return walk(value, 0);
}

/**
 * Zod record schema enforcing prototype-pollution rejection and structural bounds.
 */
export function createSafeRecordSchema(bounds: PayloadSafetyBounds = {}) {
  // Validate the RAW input before Zod's record parser gets a chance to strip
  // special keys such as `__proto__` (Zod v4 drops them during parsing, so a
  // plain superRefine after the record never sees them).
  return z
    .any()
    .superRefine((val, ctx) => {
      const res = validateSafePayload(val, bounds);
      if (!res.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: res.message,
        });
      }
    })
    .pipe(z.record(z.string(), z.unknown()));
}
