/**
 * @vellum/core - Canonical Tagged Wire Format (v1)
 * Matches Specification Section 6.2 and Limits Section 2.3.
 */

import { SYSTEM_LIMITS } from "./limits.js";
import { VellumError } from "./errors.js";
import { parseDocumentPath } from "./paths.js";

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const INT64_STR_REGEX = /^-?\d{1,20}$/;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

/** Keys that can trigger prototype pollution or break object invariants. */
const DANGEROUS_FIELD_NAMES = new Set<string>(["__proto__", "constructor", "prototype"]);

/** Defensive bounds for in-memory DoS protection prior to JSON serialization. */
const MAX_ARRAY_LENGTH = 10_000;
const MAX_MAP_KEYS = 10_000;
const MAX_TOTAL_NODES = 100_000;
const MAX_TIMESTAMP_STR_LEN = 64;
const MAX_BASE64_STR_LEN = Math.ceil((SYSTEM_LIMITS.MAX_DOCUMENT_BYTES * 4) / 3) + 4;
const MAX_DATE_EPOCH_MS = 8.64e15;

const hasOwn = Object.prototype.hasOwnProperty;

export interface TaggedInt64 {
  $t: "int";
  $v: string;
}

export interface TaggedTimestamp {
  $t: "ts";
  $v: string;
  $ms: number;
}

export interface TaggedReference {
  $t: "ref";
  $v: string;
}

export interface TaggedBytes {
  $t: "bytes";
  $v: string;
}

export interface TaggedGeopoint {
  $t: "geo";
  $v: {
    lat: number;
    lng: number;
  };
}

export interface TaggedMap {
  $t: "map";
  $v: Record<string, unknown>;
}

export type TaggedValue =
  | TaggedInt64
  | TaggedTimestamp
  | TaggedReference
  | TaggedBytes
  | TaggedGeopoint
  | TaggedMap;

export interface AtomicFieldOp {
  $op: "serverTimestamp" | "inc" | "arrayUnion" | "arrayRemove" | "deleteField";
  by?: number;
  elements?: unknown[];
}

export function validateFieldName(fieldName: string): void {
  if (
    typeof fieldName !== "string" ||
    fieldName.length === 0 ||
    fieldName.length > SYSTEM_LIMITS.MAX_FIELD_NAME_LENGTH ||
    DANGEROUS_FIELD_NAMES.has(fieldName) ||
    CONTROL_CHAR_REGEX.test(fieldName)
  ) {
    throw new VellumError("INVALID_FIELD_NAME", `Invalid field name: '${String(fieldName).slice(0, 64)}'`, {
      fieldName: typeof fieldName === "string" ? fieldName.slice(0, 64) : fieldName,
    });
  }
}

interface ValidationState {
  nodes: number;
  seen: Set<object>;
}

function validateWireValueInternal(
  value: unknown,
  depth: number,
  allowFieldOps: boolean,
  state: ValidationState
): void {
  if (depth > SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH) {
    throw new VellumError(
      "MAX_NESTING_EXCEEDED",
      `Document nesting exceeds maximum depth of ${SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH}`,
      { maxDepth: SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH }
    );
  }

  state.nodes += 1;
  if (state.nodes > MAX_TOTAL_NODES) {
    throw new VellumError("DOCUMENT_TOO_LARGE", `Document exceeds maximum value node budget (${MAX_TOTAL_NODES})`, {
      maxNodes: MAX_TOTAL_NODES,
    });
  }

  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new VellumError("INVALID_ARGUMENT", "Non-finite numbers (NaN or Infinity) are not permitted in documents");
    }
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      throw new VellumError("LIMIT_EXCEEDED", `Array length (${value.length}) exceeds maximum of ${MAX_ARRAY_LENGTH}`, {
        length: value.length,
        maxArrayLength: MAX_ARRAY_LENGTH,
      });
    }
    if (state.seen.has(value)) {
      throw new VellumError("INVALID_ARGUMENT", "Circular reference detected in document data");
    }
    state.seen.add(value);
    try {
      for (let i = 0; i < value.length; i += 1) {
        validateWireValueInternal(value[i], depth + 1, false, state);
      }
    } finally {
      state.seen.delete(value);
    }
    return;
  }

  if (typeof value === "object") {
    if (state.seen.has(value)) {
      throw new VellumError("INVALID_ARGUMENT", "Circular reference detected in document data");
    }
    state.seen.add(value);
    try {
      const record = value as Record<string, unknown>;

      // Check atomic transform sentinel ($op) using own property only
      if (hasOwn.call(record, "$op")) {
        if (!allowFieldOps) {
          throw new VellumError("INVALID_ARGUMENT", "Field operation ($op) is not permitted in this context");
        }
        const op = record["$op"];
        if (op === "serverTimestamp" || op === "deleteField") {
          return;
        }
        if (op === "inc" || op === "increment") {
          const by = typeof record["by"] === "number" ? record["by"] : record["value"];
          if (typeof by !== "number" || !Number.isFinite(by)) {
            throw new VellumError("INVALID_ARGUMENT", "$op 'inc' requires a finite numeric 'by' or 'value' parameter");
          }
          return;
        }
        if (op === "arrayUnion" || op === "arrayRemove") {
          const elements = record["elements"];
          if (!Array.isArray(elements)) {
            throw new VellumError("INVALID_ARGUMENT", `$op '${String(op)}' requires an 'elements' array`);
          }
          if (elements.length > MAX_ARRAY_LENGTH) {
            throw new VellumError(
              "LIMIT_EXCEEDED",
              `$op '${String(op)}' elements length exceeds maximum of ${MAX_ARRAY_LENGTH}`
            );
          }
          for (let i = 0; i < elements.length; i += 1) {
            validateWireValueInternal(elements[i], depth + 1, false, state);
          }
          return;
        }
        throw new VellumError("INVALID_ARGUMENT", `Unknown field transform operation '${String(op)}'`);
      }

      // Check Tagged Wire Format wrapper ($t) using own property only
      if (hasOwn.call(record, "$t")) {
        const tag = record["$t"];
        switch (tag) {
          case "int": {
            const v = record["$v"];
            if (typeof v !== "string" || v.length > 20 || !INT64_STR_REGEX.test(v)) {
              throw new VellumError("INVALID_ARGUMENT", "Tagged int64 ($t='int') requires a base-10 integer string '$v'");
            }
            const bi = BigInt(v);
            if (bi < INT64_MIN || bi > INT64_MAX) {
              throw new VellumError("INVALID_ARGUMENT", `Tagged int64 value '${v}' is outside signed 64-bit range`);
            }
            return;
          }
          case "ts": {
            const v = record["$v"];
            if (typeof v !== "string" || v.length === 0 || v.length > MAX_TIMESTAMP_STR_LEN) {
              throw new VellumError("INVALID_ARGUMENT", "Tagged timestamp ($t='ts') requires ISO-8601 UTC string '$v'");
            }
            const parsedMs = Date.parse(v);
            if (!Number.isFinite(parsedMs) || Math.abs(parsedMs) > MAX_DATE_EPOCH_MS) {
              throw new VellumError("INVALID_ARGUMENT", `Invalid ISO-8601 timestamp '${v}'`);
            }
            if (hasOwn.call(record, "$ms")) {
              const ms = record["$ms"];
              if (typeof ms !== "number" || !Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_EPOCH_MS) {
                throw new VellumError(
                  "INVALID_ARGUMENT",
                  "Tagged timestamp '$ms' must be a finite epoch millisecond number"
                );
              }
            }
            return;
          }
          case "ref": {
            const v = record["$v"];
            if (typeof v !== "string") {
              throw new VellumError("INVALID_ARGUMENT", "Tagged reference ($t='ref') requires document path string '$v'");
            }
            parseDocumentPath(v);
            return;
          }
          case "bytes": {
            const v = record["$v"];
            if (
              typeof v !== "string" ||
              v.length > MAX_BASE64_STR_LEN ||
              v.length % 4 !== 0 ||
              !BASE64_REGEX.test(v)
            ) {
              throw new VellumError("INVALID_ARGUMENT", "Tagged bytes ($t='bytes') requires valid Base64 string '$v'");
            }
            return;
          }
          case "geo": {
            const geo = record["$v"] as { lat?: unknown; lng?: unknown } | undefined;
            if (
              !geo ||
              typeof geo !== "object" ||
              Array.isArray(geo) ||
              typeof geo.lat !== "number" ||
              typeof geo.lng !== "number" ||
              !Number.isFinite(geo.lat) ||
              !Number.isFinite(geo.lng) ||
              geo.lat < -90 ||
              geo.lat > 90 ||
              geo.lng < -180 ||
              geo.lng > 180
            ) {
              throw new VellumError(
                "INVALID_ARGUMENT",
                "Tagged geopoint ($t='geo') requires lat [-90,90] and lng [-180,180]"
              );
            }
            return;
          }
          case "map": {
            const innerMap = record["$v"];
            if (!innerMap || typeof innerMap !== "object" || Array.isArray(innerMap)) {
              throw new VellumError("INVALID_ARGUMENT", "Escaped map ($t='map') requires plain object '$v'");
            }
            const innerKeys = Object.keys(innerMap);
            if (innerKeys.length > MAX_MAP_KEYS) {
              throw new VellumError("LIMIT_EXCEEDED", `Map key count (${innerKeys.length}) exceeds maximum of ${MAX_MAP_KEYS}`);
            }
            const innerRec = innerMap as Record<string, unknown>;
            for (let i = 0; i < innerKeys.length; i += 1) {
              const k = innerKeys[i]!;
              validateFieldName(k);
              validateWireValueInternal(innerRec[k], depth + 1, allowFieldOps, state);
            }
            return;
          }
          default:
            throw new VellumError("INVALID_ARGUMENT", `Unknown wire format tag '$t': '${String(tag)}'`);
        }
      }

      // Plain user map
      const keys = Object.keys(record);
      if (keys.length > MAX_MAP_KEYS) {
        throw new VellumError("LIMIT_EXCEEDED", `Map key count (${keys.length}) exceeds maximum of ${MAX_MAP_KEYS}`);
      }
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i]!;
        validateFieldName(k);
        validateWireValueInternal(record[k], depth + 1, allowFieldOps, state);
      }
    } finally {
      state.seen.delete(value);
    }
    return;
  }

  throw new VellumError("INVALID_ARGUMENT", `Unsupported value type: ${typeof value}`);
}

/**
 * Validates a Wire Format value recursively and enforces nesting depth <= 20.
 */
export function validateWireValue(value: unknown, depth = 0, allowFieldOps = false): void {
  validateWireValueInternal(value, depth, allowFieldOps, { nodes: 0, seen: new Set<object>() });
}

/**
 * Safely assigns an own property on an object without risking prototype pollution.
 */
function safeDefineProp(target: Record<string, unknown>, key: string, value: unknown): void {
  if (DANGEROUS_FIELD_NAMES.has(key)) return;
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Recursively canonicalizes timestamps so `$ms` is consistently present.
 */
function canonicalizeTimestamps(val: unknown, depth = 0): unknown {
  if (val === null || typeof val !== "object") return val;
  if (depth > SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH + 1) {
    throw new VellumError(
      "MAX_NESTING_EXCEEDED",
      `Document nesting exceeds maximum depth of ${SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH}`,
      { maxDepth: SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH }
    );
  }
  if (Array.isArray(val)) {
    const outArr = new Array<unknown>(val.length);
    for (let i = 0; i < val.length; i += 1) {
      outArr[i] = canonicalizeTimestamps(val[i], depth + 1);
    }
    return outArr;
  }

  const obj = val as Record<string, unknown>;
  if (hasOwn.call(obj, "$t")) {
    if (obj["$t"] === "ts") {
      const v = obj["$v"] as string;
      const ms = typeof obj["$ms"] === "number" ? obj["$ms"] : Date.parse(v);
      return { $t: "ts", $v: new Date(ms).toISOString(), $ms: ms };
    }
    if (obj["$t"] === "map" && obj["$v"] && typeof obj["$v"] === "object" && !Array.isArray(obj["$v"])) {
      const innerSrc = obj["$v"] as Record<string, unknown>;
      const innerKeys = Object.keys(innerSrc);
      const inner: Record<string, unknown> = {};
      for (let i = 0; i < innerKeys.length; i += 1) {
        const k = innerKeys[i]!;
        safeDefineProp(inner, k, canonicalizeTimestamps(innerSrc[k], depth + 1));
      }
      return { $t: "map", $v: inner };
    }
    return obj;
  }

  const keys = Object.keys(obj);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i]!;
    safeDefineProp(out, k, canonicalizeTimestamps(obj[k], depth + 1));
  }
  return out;
}

export interface NormalizedDocument {
  data: Record<string, unknown>;
  sizeBytes: number;
}

/**
 * Normalizes document data and enforces the 1 MiB limit.
 */
export function normalizeAndValidateDocumentData(
  data: unknown,
  allowFieldOps = false
): NormalizedDocument {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    hasOwn.call(data, "$t") ||
    hasOwn.call(data, "$op")
  ) {
    throw new VellumError("INVALID_ARGUMENT", "Top-level document data must be a plain JSON map");
  }
  validateWireValue(data, 1, allowFieldOps);
  const normalized = canonicalizeTimestamps(data, 1) as Record<string, unknown>;
  const serialized = JSON.stringify(normalized);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");
  if (sizeBytes > SYSTEM_LIMITS.MAX_DOCUMENT_BYTES) {
    throw new VellumError(
      "DOCUMENT_TOO_LARGE",
      `Serialized document size (${sizeBytes} bytes) exceeds 1 MiB limit (${SYSTEM_LIMITS.MAX_DOCUMENT_BYTES} bytes)`,
      { sizeBytes, maxBytes: SYSTEM_LIMITS.MAX_DOCUMENT_BYTES }
    );
  }
  return { data: normalized, sizeBytes };
}

/**
 * Constructors for Tagged Wire Format values.
 */
export const WireValue = {
  int64: (val: string | number | bigint): TaggedInt64 => ({
    $t: "int",
    $v: BigInt(val).toString(),
  }),
  timestamp: (dateOrIso: string | Date | number): TaggedTimestamp => {
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
    return { $t: "ts", $v: d.toISOString(), $ms: d.getTime() };
  },
  reference: (docPath: string): TaggedReference => {
    parseDocumentPath(docPath);
    return { $t: "ref", $v: docPath };
  },
  bytes: (uint8OrBase64: Uint8Array | string): TaggedBytes => {
    const b64 =
      typeof uint8OrBase64 === "string"
        ? uint8OrBase64
        : Buffer.from(uint8OrBase64).toString("base64");
    return { $t: "bytes", $v: b64 };
  },
  geopoint: (lat: number, lng: number): TaggedGeopoint => ({
    $t: "geo",
    $v: { lat, lng },
  }),
  escapeMap: <T extends Record<string, unknown>>(obj: T): TaggedMap | T => {
    return hasOwn.call(obj, "$t") ? { $t: "map", $v: obj } : obj;
  },
} as const;
