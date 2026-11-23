/**
 * @vellum/query-engine - HMAC-SHA256 Signed Opaque Cursor Codec (Section 7.3)
 *
 * Security hardening:
 * - Constant-time HMAC-SHA256 and shape-hash verification (`crypto.timingSafeEqual`).
 * - Strict token size ceiling (`MAX_CURSOR_TOKEN_BYTES`) enforced before base64url decode.
 * - Strict hex validation on `sig` (64 hex chars) and `sortKey` (even-length hex).
 * - Whitelisted payload reconstruction: rejects unknown/unauthenticated properties
 *   and prevents prototype pollution.
 * - Optional key-rotation support (`string | readonly string[]`) while preserving
 *   full single-string backward compatibility.
 */

import crypto from "node:crypto";
import { VellumError } from "@vellum/core";
import type { CursorPayload, CursorSecretInput, WhereClause, OrderByClause } from "./types.js";

export const DEFAULT_CURSOR_SECRET = process.env["CURSOR_SECRET"] ?? "vellum_cursor_secret_v1";

/** Maximum encoded cursor token length in bytes (prevents decode/JSON memory DoS). */
export const MAX_CURSOR_TOKEN_BYTES = 16_384;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const EVEN_HEX_RE = /^(?:[0-9a-f]{2})+$/i;
const ALLOWED_CURSOR_KEYS = new Set(["qHash", "vals", "docId", "sortKey", "sig"]);

/**
 * Recursively canonicalizes plain-object key order inside filter values so
 * semantically identical nested map predicates hash identically regardless of
 * JSON property insertion order. Top-level query shape order is untouched for
 * full backward compatibility with v1 hashes.
 */
function canonicalizeValueForHash(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeValueForHash);
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const out: Record<string, unknown> = Object.create(null);
  for (const k of keys) {
    out[k] = canonicalizeValueForHash(rec[k]);
  }
  return out;
}

function canonicalizeClauseForHash(clause: WhereClause): WhereClause {
  return {
    field: clause.field,
    op: clause.op,
    value: canonicalizeValueForHash(clause.value),
  };
}

function resolveSecrets(secretInput: CursorSecretInput): string[] {
  const list = typeof secretInput === "string" ? [secretInput] : Array.from(secretInput);
  const valid = list.filter((s) => typeof s === "string" && s.length > 0);
  if (valid.length === 0) {
    throw new VellumError("INVALID_ARGUMENT", "Cursor secret must be a non-empty string");
  }
  return valid;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function computeQueryShapeHash({
  projectId,
  collectionPath,
  where,
  orderBy,
  or,
  search,
}: {
  projectId: string;
  collectionPath: string;
  search?: string | undefined;
  where: WhereClause[];
  orderBy: OrderByClause[];
  /** V2 disjunctive groups — part of the query shape so cursors cannot be replayed across different OR filters. */
  or?: WhereClause[][] | undefined;
}): string {
  const normalizedWhere = where.map(canonicalizeClauseForHash);
  const normalizedOrderBy = orderBy.map((o) => ({ field: o.field, dir: o.dir }));
  const normalizedOr = Array.isArray(or)
    ? or.map((group) => group.map(canonicalizeClauseForHash))
    : [];

  const canonical = JSON.stringify({
    projectId,
    collectionPath,
    where: normalizedWhere,
    orderBy: normalizedOrderBy,
    or: normalizedOr,
    ...(search ? { search } : {}),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function encodeQueryCursor(
  { qHash, vals, docId, sortKey }: CursorPayload,
  cursorSecret: string = DEFAULT_CURSOR_SECRET
): string {
  if (typeof cursorSecret !== "string" || cursorSecret.length === 0) {
    throw new VellumError("INVALID_ARGUMENT", "Cursor secret must be a non-empty string");
  }
  if (typeof qHash !== "string" || qHash.length === 0 || typeof docId !== "string" || !Array.isArray(vals)) {
    throw new VellumError("INVALID_CURSOR", "Cursor payload requires valid qHash, vals array, and docId");
  }
  if (sortKey !== undefined && (typeof sortKey !== "string" || !EVEN_HEX_RE.test(sortKey))) {
    throw new VellumError("INVALID_CURSOR", "Cursor sortKey must be a valid non-empty even-length hex string");
  }

  const body = { qHash, vals, docId, ...(sortKey === undefined ? {} : { sortKey }) };
  const serializedBody = JSON.stringify(body);
  const sig = crypto.createHmac("sha256", cursorSecret).update(serializedBody).digest("hex");
  const token = Buffer.from(JSON.stringify({ ...body, sig }), "utf8").toString("base64url");

  if (token.length > MAX_CURSOR_TOKEN_BYTES) {
    throw new VellumError(
      "INVALID_CURSOR",
      `Encoded cursor token exceeds maximum allowed size of ${MAX_CURSOR_TOKEN_BYTES} bytes`
    );
  }
  return token;
}

export function decodeAndVerifyQueryCursor(
  cursorToken: unknown,
  expectedQHash: string,
  cursorSecret: CursorSecretInput = DEFAULT_CURSOR_SECRET
): CursorPayload {
  if (typeof cursorToken !== "string" || cursorToken.length === 0) {
    throw new VellumError("INVALID_CURSOR", "Cursor token must be a non-empty string");
  }
  if (cursorToken.length > MAX_CURSOR_TOKEN_BYTES) {
    throw new VellumError(
      "INVALID_CURSOR",
      `Cursor token exceeds maximum allowed size of ${MAX_CURSOR_TOKEN_BYTES} bytes`
    );
  }
  if (!BASE64URL_RE.test(cursorToken)) {
    throw new VellumError("INVALID_CURSOR", "Malformed base64url cursor token");
  }

  const secrets = resolveSecrets(cursorSecret);

  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(Buffer.from(cursorToken, "base64url").toString("utf8"));
  } catch {
    throw new VellumError("INVALID_CURSOR", "Malformed base64url cursor token");
  }

  if (!rawParsed || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
    throw new VellumError("INVALID_CURSOR", "Cursor token payload must be a JSON object");
  }

  const parsed = rawParsed as Record<string, unknown>;

  // Reject unauthenticated / injected properties (including prototype-polluting keys).
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_CURSOR_KEYS.has(key)) {
      throw new VellumError("INVALID_CURSOR", "Cursor token payload contains unexpected properties");
    }
  }

  if (
    typeof parsed["qHash"] !== "string" ||
    parsed["qHash"].length === 0 ||
    !Array.isArray(parsed["vals"]) ||
    typeof parsed["docId"] !== "string" ||
    typeof parsed["sig"] !== "string"
  ) {
    throw new VellumError("INVALID_CURSOR", "Cursor token payload is missing required fields");
  }

  if (parsed["sortKey"] !== undefined) {
    if (typeof parsed["sortKey"] !== "string" || !EVEN_HEX_RE.test(parsed["sortKey"])) {
      throw new VellumError("INVALID_CURSOR", "Cursor sortKey must be a hex string when present");
    }
  }

  if (!SHA256_HEX_RE.test(parsed["sig"])) {
    throw new VellumError("INVALID_CURSOR", "Cursor HMAC signature verification failed");
  }

  const body = {
    qHash: parsed["qHash"],
    vals: parsed["vals"],
    docId: parsed["docId"],
    ...(parsed["sortKey"] === undefined ? {} : { sortKey: parsed["sortKey"] }),
  };
  const serializedBody = JSON.stringify(body);
  const sigBuf = Buffer.from(parsed["sig"], "hex");

  let verified = false;
  for (const secret of secrets) {
    const expectedSigBuf = crypto.createHmac("sha256", secret).update(serializedBody).digest();
    if (sigBuf.length === expectedSigBuf.length && crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    throw new VellumError("INVALID_CURSOR", "Cursor HMAC signature verification failed");
  }

  if (typeof expectedQHash !== "string" || !constantTimeStringEqual(parsed["qHash"], expectedQHash)) {
    throw new VellumError(
      "INVALID_CURSOR",
      "Cursor query shape hash does not match current query filters or sort order"
    );
  }

  // Return a clean, freshly constructed object with only authenticated properties.
  const result: CursorPayload = {
    qHash: parsed["qHash"],
    vals: parsed["vals"],
    docId: parsed["docId"],
    sig: parsed["sig"],
  };
  if (parsed["sortKey"] !== undefined) {
    result.sortKey = parsed["sortKey"];
  }
  return result;
}
