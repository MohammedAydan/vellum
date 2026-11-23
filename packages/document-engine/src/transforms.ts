/**
 * @vellum/document-engine - Atomic Field Transforms ($op)
 * Applies declarative atomic transforms: serverTimestamp, inc, arrayUnion, arrayRemove, deleteField
 */

import { VellumError, wireValuesEqual } from "@vellum/core";
import { assertSafeFieldKey } from "./path-utils.js";

// Shared security helpers are part of this module's public surface as well.
export { assertSafeFieldKey, FORBIDDEN_FIELD_KEYS } from "./path-utils.js";

/**
 * Legacy wrapper kept only to preserve the historical `INVALID_FIELD_NAME`
 * error code observed by callers of `applyFieldTransforms` for reserved keys.
 * All validation itself is delegated to the shared `assertSafeFieldKey`; the
 * new shared helper (used by path writes and internal writers) reports
 * `INVALID_ARGUMENT` per the locked engine-hardening decision. Both codes map
 * to HTTP 400, so this is a code-level compatibility shim, not a security
 * boundary of its own.
 */
function assertSafePatchFieldKey(key: string): void {
  try {
    assertSafeFieldKey(key);
  } catch (error) {
    if (error instanceof VellumError && error.code === "INVALID_ARGUMENT") {
      throw new VellumError(
        "INVALID_FIELD_NAME",
        `Field name '${key}' is reserved and cannot be used in a document patch`,
        { field: key }
      );
    }
    throw error;
  }
}

/** Hard ceiling on `elements` for arrayUnion / arrayRemove transforms. */
const MAX_ARRAY_TRANSFORM_ELEMENTS = 10_000;

/** Hard ceiling on recursive object/array nesting during transform evaluation. */
const MAX_TRANSFORM_DEPTH = 64;

/** Maximum decimal string length accepted for a tagged integer `$v` value. */
const MAX_TAGGED_INT_CHARS = 1024;

function assertArrayTransformSize(op: unknown, elements: unknown[], field: string): void {
  if (elements.length > MAX_ARRAY_TRANSFORM_ELEMENTS) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Field transform '${String(op)}' accepts at most ${MAX_ARRAY_TRANSFORM_ELEMENTS} elements`,
      { field, op: String(op), count: elements.length }
    );
  }
}

/**
 * Clones a value while avoiding `structuredClone` overhead on immutable
 * primitives. Also validates all nested plain-object keys against prototype
 * pollution and NUL bytes and enforces `MAX_TRANSFORM_DEPTH`.
 */
function sanitizeAndCloneValue(value: unknown, depth: number): unknown {
  if (depth > MAX_TRANSFORM_DEPTH) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Document nesting depth exceeds maximum of ${MAX_TRANSFORM_DEPTH} levels`,
      { maxDepth: MAX_TRANSFORM_DEPTH }
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i += 1) {
      out[i] = sanitizeAndCloneValue(value[i], depth + 1);
    }
    return out;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return structuredClone(value);
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i]!;
    assertSafePatchFieldKey(k);
    Object.defineProperty(out, k, {
      value: sanitizeAndCloneValue(src[k], depth + 1),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Computes a deterministic structural bucket key for O(1) average-case
 * deduplication and membership checks in `arrayUnion` / `arrayRemove`.
 * Bucket collisions are always verified with `wireValuesEqual` so semantics
 * remain 100% identical to the reference linear scan.
 */
function wireBucketKey(value: unknown, depth = 0): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "undefined") return "undef";
  if (t === "boolean") return value ? "b:1" : "b:0";
  if (t === "number") {
    if (Number.isNaN(value)) return "n:NaN";
    // Normalize -0 and +0 to the same bucket to match wireValuesEqual / SameValueZero.
    return `n:${Object.is(value, -0) ? 0 : (value as number)}`;
  }
  if (t === "string") return `s:${value as string}`;
  if (t === "bigint") return `bi:${(value as bigint).toString()}`;
  if (depth >= 8) return "obj:deep";
  if (Array.isArray(value)) {
    let acc = `a[${value.length}]:`;
    const limit = Math.min(value.length, 16);
    for (let i = 0; i < limit; i += 1) {
      if (i > 0) acc += ",";
      acc += wireBucketKey(value[i], depth + 1);
    }
    return acc;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "o:{}";
  keys.sort();
  let acc = `o{${keys.length}}:`;
  const limit = Math.min(keys.length, 16);
  for (let i = 0; i < limit; i += 1) {
    const k = keys[i]!;
    if (i > 0) acc += ",";
    acc += `${k}=${wireBucketKey(obj[k], depth + 1)}`;
  }
  return acc;
}

function isPrimitiveValue(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/**
 * Fast O(N + M) membership index backed by `wireValuesEqual`.
 * Primitives (when no tagged objects could alias them) are checked in O(1),
 * and objects/arrays are bucketed by structural signature with `wireValuesEqual`
 * verification on bucket hits.
 */
class WireValueSet {
  private readonly buckets = new Map<string, unknown[]>();
  private readonly primitiveKeys = new Set<string>();
  private hasObjectEntries = false;

  public add(value: unknown): boolean {
    const key = wireBucketKey(value);
    if (isPrimitiveValue(value) && !this.hasObjectEntries) {
      if (this.primitiveKeys.has(key)) {
        return false;
      }
      this.primitiveKeys.add(key);
      const existing = this.buckets.get(key);
      if (existing) {
        existing.push(value);
      } else {
        this.buckets.set(key, [value]);
      }
      return true;
    }
    if (!isPrimitiveValue(value)) {
      this.hasObjectEntries = true;
    }
    const bucket = this.buckets.get(key);
    if (bucket) {
      for (let i = 0; i < bucket.length; i += 1) {
        if (wireValuesEqual(bucket[i], value)) {
          return false;
        }
      }
      bucket.push(value);
      return true;
    }
    this.buckets.set(key, [value]);
    return true;
  }

  public has(value: unknown): boolean {
    const key = wireBucketKey(value);
    if (isPrimitiveValue(value) && !this.hasObjectEntries) {
      return this.primitiveKeys.has(key);
    }
    const bucket = this.buckets.get(key);
    if (!bucket) return false;
    for (let i = 0; i < bucket.length; i += 1) {
      if (wireValuesEqual(bucket[i], value)) {
        return true;
      }
    }
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function applyFieldTransformsInternal(
  result: Record<string, unknown>,
  patchObj: Record<string, unknown>,
  txTimestampIso: string,
  txMs: number,
  depth: number
): Record<string, unknown> {
  if (depth > MAX_TRANSFORM_DEPTH) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Document patch nesting depth exceeds maximum of ${MAX_TRANSFORM_DEPTH} levels`,
      { maxDepth: MAX_TRANSFORM_DEPTH }
    );
  }

  const keys = Object.keys(patchObj);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    const incomingVal = patchObj[key];
    // Guards the direct assignment below AND every nested merge performed by
    // the recursive call later in this loop.
    assertSafePatchFieldKey(key);

    const hasOwnCurrent = Object.prototype.hasOwnProperty.call(result, key);
    const current = hasOwnCurrent ? result[key] : undefined;

    if (
      incomingVal &&
      typeof incomingVal === "object" &&
      !Array.isArray(incomingVal) &&
      Object.prototype.hasOwnProperty.call(incomingVal, "$op")
    ) {
      const transform = incomingVal as Record<string, unknown>;
      const op = transform["$op"];
      switch (op) {
        case "serverTimestamp":
          if (!Number.isFinite(txMs)) {
            throw new VellumError(
              "INVALID_ARGUMENT",
              "Invalid transaction timestamp for serverTimestamp transform",
              { field: key }
            );
          }
          result[key] = { $t: "ts", $v: txTimestampIso, $ms: txMs };
          break;
        case "deleteField":
          delete result[key];
          break;
        case "inc":
        case "increment": {
          let by = 0;
          if (transform["by"] !== undefined) {
            if (typeof transform["by"] !== "number" || !Number.isFinite(transform["by"])) {
              throw new VellumError(
                "INVALID_ARGUMENT",
                `Field transform '${String(op)}' requires a finite numeric 'by' value`,
                { field: key }
              );
            }
            by = transform["by"];
          } else if (transform["value"] !== undefined) {
            if (typeof transform["value"] !== "number" || !Number.isFinite(transform["value"])) {
              throw new VellumError(
                "INVALID_ARGUMENT",
                `Field transform '${String(op)}' requires a finite numeric 'value'`,
                { field: key }
              );
            }
            by = transform["value"];
          }

          const isTaggedInt =
            current !== null &&
            typeof current === "object" &&
            !Array.isArray(current) &&
            Object.prototype.hasOwnProperty.call(current, "$t") &&
            (current as Record<string, unknown>)["$t"] === "int";

          if (isTaggedInt) {
            // A tagged int is an exact arbitrary-precision value: fractional
            // or unsafe integer increments are rejected.
            if (!Number.isSafeInteger(by)) {
              throw new VellumError(
                "INVALID_ARGUMENT",
                `Cannot apply a non-integer increment ($op='${String(op)}') to tagged integer field '${key}'`,
                { field: key, by }
              );
            }
            const rawVal = (current as Record<string, unknown>)["$v"];
            let nextBi: bigint;
            try {
              if (typeof rawVal === "string") {
                const trimmed = rawVal.trim();
                if (trimmed === "" || trimmed.length > MAX_TAGGED_INT_CHARS) {
                  throw new TypeError("invalid tagged integer wire string");
                }
                nextBi = BigInt(trimmed) + BigInt(by);
              } else if (typeof rawVal === "number") {
                if (!Number.isSafeInteger(rawVal)) {
                  throw new TypeError("unsafe numeric tagged integer");
                }
                nextBi = BigInt(rawVal) + BigInt(by);
              } else if (typeof rawVal === "bigint") {
                nextBi = rawVal + BigInt(by);
              } else {
                throw new TypeError("unsupported tagged integer wire value");
              }
            } catch {
              throw new VellumError("FAILED_PRECONDITION", "Corrupted integer field value", {
                field: key,
              });
            }
            result[key] = { $t: "int", $v: nextBi.toString() };
          } else {
            // null / undefined both mean "no value yet": start from zero.
            const base = current === undefined || current === null ? 0 : current;
            if (typeof base === "number") {
              if (!Number.isFinite(base)) {
                throw new VellumError(
                  "FAILED_PRECONDITION",
                  `Cannot apply numeric increment ($op='inc') to non-finite field '${key}'`,
                  { field: key }
                );
              }
              const next = base + by;
              if (!Number.isFinite(next)) {
                throw new VellumError(
                  "INVALID_ARGUMENT",
                  `Numeric increment ($op='${String(op)}') on field '${key}' overflowed finite bounds`,
                  { field: key }
                );
              }
              result[key] = next;
            } else {
              throw new VellumError(
                "FAILED_PRECONDITION",
                `Cannot apply numeric increment ($op='inc') to non-numeric field '${key}'`,
                { field: key }
              );
            }
          }
          break;
        }
        case "arrayUnion": {
          const currentArr = Array.isArray(current) ? [...(current as unknown[])] : [];
          const elements = Array.isArray(transform["elements"]) ? transform["elements"] : [];
          assertArrayTransformSize(op, elements, key);
          const seen = new WireValueSet();
          for (let j = 0; j < currentArr.length; j += 1) {
            seen.add(currentArr[j]);
          }
          for (let j = 0; j < elements.length; j += 1) {
            const el = elements[j];
            if (seen.add(el)) {
              currentArr.push(sanitizeAndCloneValue(el, depth + 1));
            }
          }
          result[key] = currentArr;
          break;
        }
        case "arrayRemove": {
          const currentArr = Array.isArray(current) ? (current as unknown[]) : [];
          const elements = Array.isArray(transform["elements"]) ? transform["elements"] : [];
          assertArrayTransformSize(op, elements, key);
          if (currentArr.length === 0 || elements.length === 0) {
            result[key] = currentArr.slice();
            break;
          }
          const toRemove = new WireValueSet();
          for (let j = 0; j < elements.length; j += 1) {
            toRemove.add(elements[j]);
          }
          const filtered: unknown[] = [];
          for (let j = 0; j < currentArr.length; j += 1) {
            const existingEl = currentArr[j];
            if (!toRemove.has(existingEl)) {
              filtered.push(existingEl);
            }
          }
          result[key] = filtered;
          break;
        }
        default:
          throw new VellumError("INVALID_ARGUMENT", `Unknown field transform '$op': '${String(op)}'`);
      }
    } else if (
      isPlainRecord(incomingVal) &&
      !Object.prototype.hasOwnProperty.call(incomingVal, "$t") &&
      isPlainRecord(current) &&
      !Object.prototype.hasOwnProperty.call(current, "$t")
    ) {
      // `current` is already part of the root-cloned `result` tree, so we can
      // merge directly into it without a redundant deep clone per level.
      result[key] = applyFieldTransformsInternal(
        current,
        incomingVal,
        txTimestampIso,
        txMs,
        depth + 1
      );
    } else {
      result[key] = sanitizeAndCloneValue(incomingVal, depth + 1);
    }
  }

  return result;
}

/**
 * Applies a declarative patch with **deep-merge** semantics. Callers opt into
 * this path with `set { merge: true }`; a plain (non-merging) `set` replaces the
 * whole document and never invokes this helper.
 *
 * Merge rules:
 * - **Nested objects** are merged recursively, one key at a time. Recursion
 *   happens only when both the existing and incoming values are plain,
 *   non-tagged objects and neither is an array.
 * - **Terminal tagged values** (objects carrying the `$t` wire tag, e.g.
 *   `{ $t: "int", $v }` or `{ $t: "ts", $v }`) are atomic: they are replaced
 *   wholesale via deep clone, never merged into.
 * - **Arrays are replaced** wholesale via deep clone. Use the
 *   `arrayUnion` / `arrayRemove` `$op` transforms for additive/subtractive
 *   updates (deduplicated with `wireValuesEqual`, max 10,000 elements).
 * - **`null` is a value**: it overwrites the field with `null`; it does NOT
 *   delete the field. Use the `deleteField` `$op` to remove a key entirely.
 * - **`deleteField`** removes the key (including when reached through the
 *   recursive nested merge).
 *
 * Every key at every recursion level — including newly inserted sub-objects
 * and `arrayUnion` elements — is checked with `assertSafeFieldKey` before any
 * assignment, blocking prototype-pollution and NUL-byte injection.
 */
export function applyFieldTransforms(
  existingObj: Record<string, unknown> | null | undefined,
  patchObj: Record<string, unknown>,
  txTimestampIso: string
): Record<string, unknown> {
  const txMs = Date.parse(txTimestampIso);
  const result: Record<string, unknown> = existingObj ? structuredClone(existingObj) : {};
  return applyFieldTransformsInternal(result, patchObj, txTimestampIso, txMs, 0);
}
