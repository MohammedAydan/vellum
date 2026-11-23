/**
 * @vellumdb/sdk-js - Prototype-pollution safe JSON parsing, defensive cloning,
 * and URL path segment validation/encoding.
 *
 * Zero external dependencies; uses only standard ECMAScript & Web APIs.
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CLONE_DEPTH = 64;

/** True when a property key could be used for prototype pollution. */
export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively strip prototype-pollution keys (`__proto__`, `constructor`,
 * `prototype`) and produce a defensive deep copy of plain objects and arrays.
 */
export function sanitizeAndClone<T>(value: T, depth = 0, seen?: WeakSet<object>): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_CLONE_DEPTH) {
    return value;
  }
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value as object)) {
    return value;
  }

  if (Array.isArray(value)) {
    visited.add(value);
    const out = value.map((item) => sanitizeAndClone(item, depth + 1, visited));
    visited.delete(value);
    return out as unknown as T;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  visited.add(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[key] = sanitizeAndClone(value[key], depth + 1, visited);
  }
  visited.delete(value);
  return out as T;
}

/**
 * Parse JSON while stripping `__proto__`, `constructor`, and `prototype` keys
 * at every nesting level.
 */
export function safeJsonParse<T = unknown>(text: string): T {
  const parsed = JSON.parse(text, (key: string, value: unknown) => {
    if (FORBIDDEN_KEYS.has(key)) return undefined;
    return value;
  }) as unknown;
  return sanitizeAndClone(parsed) as T;
}

/**
 * Validate a single collection or document ID path segment against traversal,
 * control characters, and query/fragment injection, then return its URI-encoded
 * form.
 */
export function encodePathSegment(segment: string, label = "path segment"): string {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new Error(`@vellumdb/sdk-js: invalid ${label} (must be a non-empty string)`);
  }
  if (
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("?") ||
    segment.includes("#") ||
    /[\x00-\x1f\x7f]/.test(segment)
  ) {
    throw new Error(`@vellumdb/sdk-js: invalid ${label} (disallowed traversal or control characters)`);
  }
  // Reject percent-encoded traversal tricks like %2e%2e or %2f or %5c.
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Non-percent-encoded literal '%' is still safely encoded by encodeURIComponent below.
  }
  if (
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(decoded)
  ) {
    throw new Error(`@vellumdb/sdk-js: invalid ${label} (disallowed encoded traversal characters)`);
  }
  return encodeURIComponent(segment);
}

/**
 * Validate and encode a slash-delimited document or collection path
 * (e.g. `"users/doc_1"` -> `"users/doc_1"`, `"users/a b"` -> `"users/a%20b"`),
 * rejecting empty segments, leading/trailing slashes, `..`/`.` traversal,
 * backslashes, query/fragment injection (`?`, `#`), and control characters.
 */
export function encodeResourcePath(rawPath: string, label = "resource path"): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error(`@vellumdb/sdk-js: invalid ${label} (must be a non-empty string)`);
  }
  if (rawPath.startsWith("/") || rawPath.endsWith("/") || rawPath.includes("//")) {
    throw new Error(`@vellumdb/sdk-js: invalid ${label} (empty path segment)`);
  }
  const segments = rawPath.split("/");
  return segments.map((seg) => encodePathSegment(seg, label)).join("/");
}
