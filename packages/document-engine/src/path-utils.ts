/**
 * @vellum/document-engine - Safe field-path utilities
 *
 * Shared, dependency-free helpers for validating and writing dot-path field
 * names. Kept separate from `transforms.ts` so every engine subsystem
 * (transforms, relation projection, internal writers) uses the exact same
 * prototype-pollution / NUL-byte guard semantics.
 */

import { VellumError } from "@vellum/core";

/**
 * Keys that are prototype-pollution / constructor-gadget vectors when a patch
 * is merged into a plain JS object. Rejected (never silently stripped) at
 * every level of a path so a caller cannot lose data without noticing.
 */
export const FORBIDDEN_FIELD_KEYS = new Set<string>(["__proto__", "constructor", "prototype"]);

/** Maximum nesting depth allowed for a dot-separated field path. */
const MAX_FIELD_PATH_DEPTH = 64;

/** Maximum byte/character length allowed for a dot-separated field path. */
const MAX_FIELD_PATH_LENGTH = 2048;

/** Maximum entries retained in the parsed field-path LRU/FIFO cache. */
const MAX_PARSED_PATH_CACHE_SIZE = 2048;

/** Maximum input string length accepted by `toIsoDate` before failing closed. */
const MAX_ISO_DATE_INPUT_LENGTH = 128;

/** Bounded cache of validated, pre-split dot-path segments. */
const parsedPathCache = new Map<string, readonly string[]>();

/**
 * Asserts that a single field-path segment is safe to use as an object key.
 *
 * @throws {VellumError} `INVALID_ARGUMENT` when the key is a forbidden key or
 * contains a NUL (`\u0000`) byte.
 */
export function assertSafeFieldKey(key: string): void {
  if (typeof key !== "string" || FORBIDDEN_FIELD_KEYS.has(key) || key.includes("\u0000")) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Field name '${String(key)}' is reserved or contains a null byte and cannot be used in a document patch`,
      { field: String(key) }
    );
  }
}

/**
 * Parses and validates a dot-separated field path into an immutable array of
 * safe segments, caching valid results in a bounded map to eliminate repeated
 * `split(".")` allocations and validation loops on hot paths.
 *
 * @throws {VellumError} `INVALID_ARGUMENT` when the path is empty, too long,
 * too deeply nested, contains empty segments, or includes a forbidden/NUL key.
 */
export function parseFieldPath(fieldPath: string): readonly string[] {
  if (typeof fieldPath !== "string" || fieldPath.length === 0) {
    throw new VellumError("INVALID_ARGUMENT", "Field path must be a non-empty string");
  }
  const cached = parsedPathCache.get(fieldPath);
  if (cached !== undefined) {
    return cached;
  }
  if (fieldPath.length > MAX_FIELD_PATH_LENGTH) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Field path length (${fieldPath.length}) exceeds maximum of ${MAX_FIELD_PATH_LENGTH} characters`,
      { maxLength: MAX_FIELD_PATH_LENGTH }
    );
  }

  const segments = fieldPath.split(".");
  if (segments.length > MAX_FIELD_PATH_DEPTH) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `Field path depth (${segments.length}) exceeds maximum of ${MAX_FIELD_PATH_DEPTH} levels`,
      { depth: segments.length, maxDepth: MAX_FIELD_PATH_DEPTH }
    );
  }

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment.length === 0) {
      throw new VellumError(
        "INVALID_ARGUMENT",
        `Field path '${fieldPath}' contains an empty segment`,
        { field: fieldPath }
      );
    }
    assertSafeFieldKey(segment);
  }

  const frozen = Object.freeze(segments);
  if (parsedPathCache.size >= MAX_PARSED_PATH_CACHE_SIZE) {
    const oldest = parsedPathCache.keys().next();
    if (!oldest.done) {
      parsedPathCache.delete(oldest.value);
    }
  }
  parsedPathCache.set(fieldPath, frozen);
  return frozen;
}

/**
 * Returns true only for values that are safe to use as an intermediate merge
 * container: a plain object (Object.prototype) or a null-prototype object we
 * created ourselves. Arrays, Dates, class instances and tagged wire values are
 * deliberately rejected so we never assign through an unexpected setter.
 */
function isSafeContainer(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/**
 * Writes `value` at a dot-separated `fieldPath` on `target`.
 *
 * - Every segment is validated upfront via {@link parseFieldPath} before any
 *   mutation occurs on `target` (atomic on invalid paths).
 * - Missing or unsafe intermediate segments are created as null-prototype
 *   objects (`Object.create(null)`), so no inherited setter can ever be
 *   reached through the traversal.
 * - The final assignment uses `Object.defineProperty` with explicit
 *   value/writable/enumerable/configurable flags.
 * - Existence checks always use `Object.prototype.hasOwnProperty.call`;
 *   `Object.prototype` itself is never mutated.
 */
export function setPath(
  target: Record<string, unknown>,
  fieldPath: string,
  value: unknown
): void {
  const segments = parseFieldPath(fieldPath);
  const lastIndex = segments.length - 1;
  let container = target;

  for (let i = 0; i < lastIndex; i += 1) {
    const segment = segments[i]!;
    if (
      !Object.prototype.hasOwnProperty.call(container, segment) ||
      !isSafeContainer(container[segment])
    ) {
      Object.defineProperty(container, segment, {
        value: Object.create(null) as Record<string, unknown>,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    container = container[segment] as Record<string, unknown>;
  }

  Object.defineProperty(container, segments[lastIndex]!, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Safely coerces a string, finite number, or Date into an ISO-8601 string.
 * Returns `null` for every other/invalid input and never throws.
 */
export function toIsoDate(v: unknown): string | null {
  try {
    if (v === null || v === undefined) {
      return null;
    }
    if (v instanceof Date) {
      return Number.isNaN(v.getTime()) ? null : v.toISOString();
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        return null;
      }
      const fromNumber = new Date(v);
      return Number.isNaN(fromNumber.getTime()) ? null : fromNumber.toISOString();
    }
    if (typeof v === "string") {
      if (v.length === 0 || v.length > MAX_ISO_DATE_INPUT_LENGTH || v.trim() === "") {
        return null;
      }
      const ms = Date.parse(v);
      if (!Number.isFinite(ms)) {
        return null;
      }
      return new Date(ms).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}
