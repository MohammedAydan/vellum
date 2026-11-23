/**
 * @vellum/core - Canonical Document & Collection Path Parser
 * Matches Specification Section 6.1 and System Limits Section 2.3.
 */

import { SYSTEM_LIMITS } from "./limits.js";
import { VellumError } from "./errors.js";

const RESERVED_SEGMENT_REGEX = /^__.*__$/;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
const WHITESPACE_REGEX = /\s/;
const ENCODED_TRAVERSAL_REGEX = /(?:%2e%2e|%2f|%5c|%00)/i;

/** Collection names are flat registry keys: no `/`, no `..`, 1..128 chars. */
const COLLECTION_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_COLLECTION_PREFIX = "__internal__";

/** Upper bound on raw path length before splitting to prevent memory DoS. */
const MAX_RAW_PATH_LENGTH =
  SYSTEM_LIMITS.MAX_PATH_DEPTH * SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES + SYSTEM_LIMITS.MAX_PATH_DEPTH;

/** Max length for a segment where UTF-8 byte length is guaranteed <= MAX_PATH_SEGMENT_BYTES. */
const FAST_UTF8_CHAR_LIMIT = Math.floor(SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES / 3);

/** Bounded zero-timer LRU caches for hot-path parsing. */
const PATH_CACHE_MAX_ENTRIES = 4_096;
const DOC_PATH_CACHE = new Map<string, DocumentPathResult>();
const COL_PATH_CACHE = new Map<string, CollectionPathResult>();

function lruGet<V>(cache: Map<string, V>, key: string): V | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function lruSet<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= PATH_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/**
 * Validates and normalizes a user-facing collection registry name.
 *
 * Unlike `parseCollectionPath` this deals with the flat `name` column of
 * `project_collections` (which cannot contain `/`). Every rejection raises
 * `INVALID_ARGUMENT` so callers can map it straight to an HTTP 400 without a
 * separate error-translation layer.
 */
export function validateCollectionName(name: string): string {
  if (typeof name !== "string") {
    throw new VellumError("INVALID_ARGUMENT", "Collection name must not be empty", { name });
  }
  if (name.length > 256) {
    throw new VellumError("INVALID_ARGUMENT", "Collection name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", {
      name: name.slice(0, 128),
    });
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new VellumError("INVALID_ARGUMENT", "Collection name must not be empty", { name });
  }
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) {
    throw new VellumError("INVALID_ARGUMENT", "Collection name must not start or end with '/'", {
      name: trimmed,
    });
  }
  if (trimmed.includes("..")) {
    throw new VellumError("INVALID_ARGUMENT", "Collection name must not contain '..'", { name: trimmed });
  }
  if (WHITESPACE_REGEX.test(trimmed) || CONTROL_CHAR_REGEX.test(trimmed)) {
    throw new VellumError("INVALID_ARGUMENT", "Collection name must not contain whitespace or control characters", {
      name: trimmed,
    });
  }
  if (trimmed.toLowerCase().startsWith(RESERVED_COLLECTION_PREFIX)) {
    throw new VellumError("INVALID_ARGUMENT", "Collection name uses the reserved '__internal__' prefix", {
      name: trimmed,
    });
  }
  if (!COLLECTION_NAME_REGEX.test(trimmed)) {
    throw new VellumError("INVALID_ARGUMENT", "Collection name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", {
      name: trimmed,
    });
  }
  return trimmed;
}

export interface DocumentPathResult {
  path: string;
  collectionPath: string;
  collectionGroup: string;
  documentId: string;
  pathDepth: number;
  segments: string[];
}

export interface CollectionPathResult {
  collectionPath: string;
  collectionGroup: string;
  depth: number;
  segments: string[];
}

/**
 * Validates an individual path segment.
 */
export function validatePathSegment(segment: string, fullPath: string): void {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new VellumError("INVALID_DOCUMENT_PATH", `Path contains an empty segment: '${fullPath}'`, { path: fullPath });
  }
  if (segment === "." || segment === ".." || ENCODED_TRAVERSAL_REGEX.test(segment)) {
    throw new VellumError("INVALID_DOCUMENT_PATH", `Reserved relative path segment '${segment}' is not allowed`, {
      path: fullPath,
      segment,
    });
  }
  if (RESERVED_SEGMENT_REGEX.test(segment)) {
    throw new VellumError(
      "INVALID_DOCUMENT_PATH",
      `Reserved system segment '${segment}' matching __.*__ is not allowed`,
      { path: fullPath, segment }
    );
  }
  if (CONTROL_CHAR_REGEX.test(segment)) {
    throw new VellumError("INVALID_DOCUMENT_PATH", `Path segment contains control characters`, { path: fullPath });
  }
  if (segment.length > FAST_UTF8_CHAR_LIMIT) {
    const byteLen = Buffer.byteLength(segment, "utf8");
    if (byteLen > SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES) {
      throw new VellumError(
        "INVALID_DOCUMENT_PATH",
        `Path segment exceeds maximum length of ${SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES} bytes`,
        { path: fullPath, byteLength: byteLen }
      );
    }
  }
}

/**
 * Parses and validates a canonical document path (even number of segments between 2 and 10).
 */
export function parseDocumentPath(rawPath: string): DocumentPathResult {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > MAX_RAW_PATH_LENGTH) {
    throw new VellumError("INVALID_DOCUMENT_PATH", `Invalid document path: '${String(rawPath).slice(0, 128)}'`, {
      path: typeof rawPath === "string" ? rawPath.slice(0, 128) : rawPath,
    });
  }

  const cached = lruGet(DOC_PATH_CACHE, rawPath);
  if (cached !== undefined) {
    return {
      path: cached.path,
      collectionPath: cached.collectionPath,
      collectionGroup: cached.collectionGroup,
      documentId: cached.documentId,
      pathDepth: cached.pathDepth,
      segments: cached.segments.slice(),
    };
  }

  if (rawPath.startsWith("/") || rawPath.endsWith("/")) {
    throw new VellumError("INVALID_DOCUMENT_PATH", `Invalid document path: '${rawPath}'`, { path: rawPath });
  }
  const segments = rawPath.split("/");
  if (segments.length < 2 || segments.length > SYSTEM_LIMITS.MAX_PATH_DEPTH || segments.length % 2 !== 0) {
    throw new VellumError(
      "INVALID_DOCUMENT_PATH",
      `Document path '${rawPath}' must have an even number of segments between 2 and ${SYSTEM_LIMITS.MAX_PATH_DEPTH}`,
      { path: rawPath, depth: segments.length }
    );
  }
  for (let i = 0; i < segments.length; i += 1) {
    validatePathSegment(segments[i]!, rawPath);
  }
  const documentId = segments[segments.length - 1]!;
  const collectionSegments = segments.slice(0, -1);
  const collectionPath = collectionSegments.join("/");
  const collectionGroup = collectionSegments[collectionSegments.length - 1]!;
  const result: DocumentPathResult = {
    path: rawPath,
    collectionPath,
    collectionGroup,
    documentId,
    pathDepth: segments.length,
    segments,
  };
  lruSet(DOC_PATH_CACHE, rawPath, result);
  return {
    ...result,
    segments: segments.slice(),
  };
}

/**
 * Parses and validates a canonical collection path (odd number of segments between 1 and 9).
 */
export function parseCollectionPath(rawCollectionPath: string): CollectionPathResult {
  if (
    typeof rawCollectionPath !== "string" ||
    rawCollectionPath.length === 0 ||
    rawCollectionPath.length > MAX_RAW_PATH_LENGTH
  ) {
    throw new VellumError(
      "INVALID_DOCUMENT_PATH",
      `Invalid collection path: '${String(rawCollectionPath).slice(0, 128)}'`,
      {
        path: typeof rawCollectionPath === "string" ? rawCollectionPath.slice(0, 128) : rawCollectionPath,
      }
    );
  }

  const cached = lruGet(COL_PATH_CACHE, rawCollectionPath);
  if (cached !== undefined) {
    return {
      collectionPath: cached.collectionPath,
      collectionGroup: cached.collectionGroup,
      depth: cached.depth,
      segments: cached.segments.slice(),
    };
  }

  if (rawCollectionPath.startsWith("/") || rawCollectionPath.endsWith("/")) {
    throw new VellumError("INVALID_DOCUMENT_PATH", `Invalid collection path: '${rawCollectionPath}'`, {
      path: rawCollectionPath,
    });
  }
  const segments = rawCollectionPath.split("/");
  if (segments.length < 1 || segments.length >= SYSTEM_LIMITS.MAX_PATH_DEPTH || segments.length % 2 !== 1) {
    throw new VellumError(
      "INVALID_DOCUMENT_PATH",
      `Collection path '${rawCollectionPath}' must have an odd number of segments between 1 and ${
        SYSTEM_LIMITS.MAX_PATH_DEPTH - 1
      }`,
      { path: rawCollectionPath, depth: segments.length }
    );
  }
  for (let i = 0; i < segments.length; i += 1) {
    validatePathSegment(segments[i]!, rawCollectionPath);
  }
  const result: CollectionPathResult = {
    collectionPath: rawCollectionPath,
    collectionGroup: segments[segments.length - 1]!,
    depth: segments.length,
    segments,
  };
  lruSet(COL_PATH_CACHE, rawCollectionPath, result);
  return {
    ...result,
    segments: segments.slice(),
  };
}
