/**
 * @vellum/core - Order-Preserving Binary Sort-Key Encoder (`sort_key BYTEA`)
 * Matches Specification Section 7.2 exactly.
 */

import { VellumError } from "./errors.js";
import { SYSTEM_LIMITS } from "./limits.js";

export const TYPE_TAG = {
  MISSING: 0x05,
  NULL: 0x0a,
  BOOLEAN: 0x10,
  NUMBER: 0x20,
  STRING: 0x30,
  TIMESTAMP: 0x40,
  REFERENCE: 0x50,
  BYTES: 0x60,
  GEOPOINT: 0x70,
} as const;

export type SortDirection = "asc" | "desc";

/** `text` marks a full-text index field: no sort order, entries carry a tsvector for `text_search`. */
export type IndexFieldDirection = SortDirection | "text";

export interface IndexFieldSpec {
  path: string;
  dir: IndexFieldDirection;
}

/** A full-text index has exactly one field; "text" cannot be mixed with ordered fields. */
export function assertValidIndexFields(fields: ReadonlyArray<IndexFieldSpecLike>): void {
  const textCount = fields.filter((f) => String(f.dir ?? f.direction ?? "").toLowerCase() === "text").length;
  if (textCount > 0 && fields.length !== 1) {
    throw new VellumError("INVALID_ARGUMENT", "A full-text index (dir \"text\") takes exactly one field and cannot be combined with other fields");
  }
}

/** Field path of a whole-document full-text index: the one that serves the query-level `search`. */
export const FULL_TEXT_ALL_PATH = "*";

/** True when an index definition is a full-text index (one field with dir "text"). */
export function isFullTextIndexFields(fields: ReadonlyArray<IndexFieldSpecLike>): boolean {
  return fields.length === 1 && String(fields[0]?.dir ?? fields[0]?.direction ?? "").toLowerCase() === "text";
}

/** Legacy/alternate field shape accepted from older console-created indexes. */
export interface IndexFieldSpecLike {
  path?: string | undefined;
  dir?: string | undefined;
  field?: string | undefined;
  direction?: string | undefined;
}

const hasOwn = Object.prototype.hasOwnProperty;
const DANGEROUS_PATH_SEGMENTS = new Set<string>(["__proto__", "constructor", "prototype"]);
const MAX_FIELD_PATH_LENGTH = 2_048;
const MAX_FIELD_PATH_DEPTH = SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH + 1;
const MAX_EQUALITY_DEPTH = SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH + 5;

/** Pre-allocated immutable buffers for zero-allocation primitive sort keys. */
const BUF_MISSING = Buffer.from([TYPE_TAG.MISSING]);
const BUF_NULL = Buffer.from([TYPE_TAG.NULL]);
const BUF_BOOL_TRUE = Buffer.from([TYPE_TAG.BOOLEAN, 0x01]);
const BUF_BOOL_FALSE = Buffer.from([TYPE_TAG.BOOLEAN, 0x00]);
const BUF_MISSING_DESC = Buffer.from([TYPE_TAG.MISSING ^ 0xff]);
const BUF_NULL_DESC = Buffer.from([TYPE_TAG.NULL ^ 0xff]);
const BUF_BOOL_TRUE_DESC = Buffer.from([TYPE_TAG.BOOLEAN ^ 0xff, 0x01 ^ 0xff]);
const BUF_BOOL_FALSE_DESC = Buffer.from([TYPE_TAG.BOOLEAN ^ 0xff, 0x00 ^ 0xff]);

/** Bounded LRU cache for split field paths on the hot read/index/rules path. */
const FIELD_PATH_CACHE_MAX = 4_096;
const FIELD_PATH_CACHE = new Map<string, readonly string[] | null>();

function getParsedFieldPath(fieldPath: string): readonly string[] | null {
  if (fieldPath.length === 0 || fieldPath.length > MAX_FIELD_PATH_LENGTH) return null;
  const cached = FIELD_PATH_CACHE.get(fieldPath);
  if (cached !== undefined) {
    FIELD_PATH_CACHE.delete(fieldPath);
    FIELD_PATH_CACHE.set(fieldPath, cached);
    return cached;
  }
  const parts = fieldPath.split(".");
  let valid: readonly string[] | null = parts;
  if (parts.length > MAX_FIELD_PATH_DEPTH) {
    valid = null;
  } else {
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i]!;
      if (p.length === 0 || DANGEROUS_PATH_SEGMENTS.has(p)) {
        valid = null;
        break;
      }
    }
  }
  if (FIELD_PATH_CACHE.size >= FIELD_PATH_CACHE_MAX) {
    const oldest = FIELD_PATH_CACHE.keys().next();
    if (oldest.done !== true) FIELD_PATH_CACHE.delete(oldest.value);
  }
  FIELD_PATH_CACHE.set(fieldPath, valid);
  return valid;
}

/** Normalizes both `{path, dir}` and legacy `{field, direction}` index specs. */
export function normalizeIndexFieldSpec(field: IndexFieldSpecLike): IndexFieldSpec {
  const path = field.path ?? field.field;
  if (typeof path !== "string" || path.length === 0) {
    throw new VellumError("INVALID_ARGUMENT", "Composite index field requires a non-empty path");
  }
  const rawDir = field.dir ?? field.direction ?? "asc";
  const dirText = String(rawDir).toLowerCase();
  return { path, dir: dirText === "desc" ? "desc" : dirText === "text" ? "text" : "asc" };
}

export interface DocumentRecordForIndex {
  documentId: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

/**
 * Encodes an IEEE-754 float64 into 8 order-preserving big-endian bytes:
 * - Negative numbers: flip all 64 bits (`^ 0xFFFFFFFFFFFFFFFFn`)
 * - Zero / Positive numbers: flip the sign bit (`^ 0x8000000000000000n`)
 */
export function encodeSortableFloat64(num: number): Buffer {
  const normalized = Object.is(num, -0) ? 0 : Number(num);
  const buf = Buffer.allocUnsafe(8);
  buf.writeDoubleBE(normalized, 0);
  let bits = buf.readBigUInt64BE(0);
  if ((bits & 0x8000000000000000n) !== 0n) {
    bits = ~bits & 0xffffffffffffffffn;
  } else {
    bits = bits ^ 0x8000000000000000n;
  }
  buf.writeBigUInt64BE(bits, 0);
  return buf;
}

/**
 * Encodes a signed 64-bit integer into 8 order-preserving big-endian bytes.
 */
export function encodeSortableInt64(bigIntVal: bigint | number | string): Buffer {
  const bi = BigInt(bigIntVal);
  const unsigned = (bi ^ (1n << 63n)) & 0xffffffffffffffffn;
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigUInt64BE(unsigned, 0);
  return buf;
}

/**
 * Encodes byte sequence with a type tag prefix, null-byte escaping (`0x00` -> `0x00 0xFF`)
 * and `0x00 0x00` terminator in a single buffer allocation.
 */
function encodeTaggedEscapedBytes(tag: number, rawBuf: Buffer): Buffer {
  let zeroCount = 0;
  for (let i = 0; i < rawBuf.length; i += 1) {
    if (rawBuf[i] === 0x00) zeroCount += 1;
  }
  const out = Buffer.allocUnsafe(1 + rawBuf.length + zeroCount + 2);
  out[0] = tag;
  let offset = 1;
  for (let i = 0; i < rawBuf.length; i += 1) {
    const b = rawBuf[i]!;
    if (b === 0x00) {
      out[offset++] = 0x00;
      out[offset++] = 0xff;
    } else {
      out[offset++] = b;
    }
  }
  out[offset++] = 0x00;
  out[offset] = 0x00;
  return out;
}

/**
 * Encodes a single Wire Format value into an order-preserving binary segment.
 */
export function encodeSingleSortKeyValue(value: unknown, direction: SortDirection = "asc"): Buffer {
  const desc = direction === "desc";

  // Zero-allocation fast paths for common primitives
  if (value === undefined) {
    return desc ? BUF_MISSING_DESC : BUF_MISSING;
  }
  if (value === null) {
    return desc ? BUF_NULL_DESC : BUF_NULL;
  }
  if (typeof value === "boolean") {
    if (desc) return value ? BUF_BOOL_TRUE_DESC : BUF_BOOL_FALSE_DESC;
    return value ? BUF_BOOL_TRUE : BUF_BOOL_FALSE;
  }

  let encoded: Buffer;

  if (typeof value === "number") {
    encoded = Buffer.allocUnsafe(9);
    encoded[0] = TYPE_TAG.NUMBER;
    encodeSortableFloat64(value).copy(encoded, 1);
  } else if (typeof value === "string") {
    encoded = encodeTaggedEscapedBytes(TYPE_TAG.STRING, Buffer.from(value, "utf8"));
  } else if (typeof value === "object" && !Array.isArray(value) && hasOwn.call(value, "$t")) {
    const tagged = value as { $t: string; $v?: unknown; $ms?: unknown };
    switch (tagged.$t) {
      case "int": {
        try {
          const num = Number(BigInt(tagged.$v as string));
          encoded = Buffer.allocUnsafe(9);
          encoded[0] = TYPE_TAG.NUMBER;
          encodeSortableFloat64(num).copy(encoded, 1);
        } catch {
          return desc ? BUF_MISSING_DESC : BUF_MISSING;
        }
        break;
      }
      case "ts": {
        const ms = typeof tagged.$ms === "number" ? tagged.$ms : Date.parse(tagged.$v as string);
        if (!Number.isFinite(ms)) {
          return desc ? BUF_MISSING_DESC : BUF_MISSING;
        }
        encoded = Buffer.allocUnsafe(9);
        encoded[0] = TYPE_TAG.TIMESTAMP;
        encodeSortableInt64(Math.trunc(ms)).copy(encoded, 1);
        break;
      }
      case "ref":
        encoded = encodeTaggedEscapedBytes(TYPE_TAG.REFERENCE, Buffer.from(String(tagged.$v ?? ""), "utf8"));
        break;
      case "bytes":
        encoded = encodeTaggedEscapedBytes(TYPE_TAG.BYTES, Buffer.from(String(tagged.$v ?? ""), "base64"));
        break;
      case "geo": {
        const geo = tagged.$v as { lat: number; lng: number } | undefined;
        if (!geo || typeof geo.lat !== "number" || typeof geo.lng !== "number") {
          return desc ? BUF_MISSING_DESC : BUF_MISSING;
        }
        encoded = Buffer.allocUnsafe(17);
        encoded[0] = TYPE_TAG.GEOPOINT;
        encodeSortableFloat64(geo.lat).copy(encoded, 1);
        encodeSortableFloat64(geo.lng).copy(encoded, 9);
        break;
      }
      default:
        return desc ? BUF_MISSING_DESC : BUF_MISSING;
    }
  } else {
    return desc ? BUF_MISSING_DESC : BUF_MISSING;
  }

  if (desc) {
    for (let i = 0; i < encoded.length; i += 1) {
      encoded[i] = encoded[i]! ^ 0xff;
    }
  }
  return encoded;
}

/**
 * Extracts a nested field value from a document's `data` using dot-notation (e.g. "profile.age").
 * Strictly enforces own-property access and blocks prototype-chain traversal.
 */
export function getFieldByPath(data: unknown, fieldPath: string): unknown {
  if (!data || typeof data !== "object" || typeof fieldPath !== "string") return undefined;
  const parts = getParsedFieldPath(fieldPath);
  if (parts === null) return undefined;

  let current: unknown = data;
  for (let i = 0; i < parts.length; i += 1) {
    if (current === null || current === undefined || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    const rec = current as Record<string, unknown>;
    if (hasOwn.call(rec, "$t") && rec["$t"] === "map" && rec["$v"] && typeof rec["$v"] === "object") {
      current = rec["$v"];
    }
    const currentObj = current as Record<string, unknown>;
    const part = parts[i]!;
    if (!hasOwn.call(currentObj, part)) {
      return undefined;
    }
    current = currentObj[part];
  }
  return current;
}

/**
 * Computes composite `sort_key BYTEA` Buffer for a document given index field specifications.
 */
export function encodeCompositeSortKey(
  docRecord: DocumentRecordForIndex,
  indexFields: IndexFieldSpec[]
): Buffer {
  const segments = new Array<Buffer>(indexFields.length);
  for (let i = 0; i < indexFields.length; i += 1) {
    const f = normalizeIndexFieldSpec(indexFields[i]!);
    let val: unknown;
    if (f.path === "__name__" || f.path === "documentId") {
      val = docRecord.documentId;
    } else if (f.path === "createdAt") {
      val = { $t: "ts", $v: docRecord.createdAt, $ms: Date.parse(docRecord.createdAt) };
    } else if (f.path === "updatedAt") {
      val = { $t: "ts", $v: docRecord.updatedAt, $ms: Date.parse(docRecord.updatedAt) };
    } else {
      val = getFieldByPath(docRecord.data, f.path);
    }
    // A full-text field has no order: the entry key is empty and the tsvector carries the search.
    segments[i] = f.dir === "text" ? Buffer.alloc(0) : encodeSingleSortKeyValue(val, f.dir);
  }
  return Buffer.concat(segments);
}

/**
 * The text a full-text index searches for one document: the field's string value, with arrays and
 * objects flattened to their string leaves. Returns null when the field has no text.
 */
export function fullTextIndexText(docRecord: DocumentRecordForIndex, indexFields: IndexFieldSpec[]): string | null {
  const f = normalizeIndexFieldSpec(indexFields[0]!);
  const parts: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || v === null || v === undefined) return;
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v));
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  if (f.path === FULL_TEXT_ALL_PATH) {
    // Whole-document index: serves `search` (every string/number leaf plus the document id).
    parts.push(docRecord.documentId);
    walk(docRecord.data, 0);
  } else {
    walk(getFieldByPath(docRecord.data, f.path), 0);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Compares two Wire Format values using canonical sort order (-1, 0, 1).
 */
export function compareWireValues(a: unknown, b: unknown, dir: SortDirection = "asc"): number {
  const bufA = encodeSingleSortKeyValue(a, dir);
  const bufB = encodeSingleSortKeyValue(b, dir);
  return Buffer.compare(bufA, bufB);
}

function wireValuesEqualInternal(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (depth > MAX_EQUALITY_DEPTH) return false;

  if (
    typeof a === "number" &&
    typeof b === "object" &&
    b !== null &&
    hasOwn.call(b, "$t") &&
    (b as { $t?: unknown }).$t === "int"
  ) {
    return Number.isInteger(a) && BigInt(Math.trunc(a)).toString() === (b as { $v: string }).$v;
  }
  if (
    typeof b === "number" &&
    typeof a === "object" &&
    a !== null &&
    hasOwn.call(a, "$t") &&
    (a as { $t?: unknown }).$t === "int"
  ) {
    return Number.isInteger(b) && BigInt(Math.trunc(b)).toString() === (a as { $v: string }).$v;
  }
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!wireValuesEqualInternal(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;

    if (hasOwn.call(objA, "$t") && hasOwn.call(objB, "$t")) {
      if (objA["$t"] !== objB["$t"]) return false;
      if (objA["$t"] === "ts") {
        const msA = typeof objA["$ms"] === "number" ? objA["$ms"] : Date.parse(objA["$v"] as string);
        const msB = typeof objB["$ms"] === "number" ? objB["$ms"] : Date.parse(objB["$v"] as string);
        return msA === msB;
      }
      if (objA["$t"] === "geo") {
        const geoA = objA["$v"] as { lat: number; lng: number } | undefined;
        const geoB = objB["$v"] as { lat: number; lng: number } | undefined;
        return Boolean(geoA && geoB && geoA.lat === geoB.lat && geoA.lng === geoB.lng);
      }
      return wireValuesEqualInternal(objA["$v"], objB["$v"], depth + 1);
    }

    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i += 1) {
      const k = keysA[i]!;
      if (!hasOwn.call(objB, k) || !wireValuesEqualInternal(objA[k], objB[k], depth + 1)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Deep equality check for Wire Format values.
 */
export function wireValuesEqual(a: unknown, b: unknown): boolean {
  return wireValuesEqualInternal(a, b, 0);
}
