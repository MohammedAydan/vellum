/**
 * @vellum/security - Append-only hash-chain primitives.
 *
 * Shared by the security audit log and the billing ledger. Both planes use
 * domain-separated HKDF keys so that a key derived for one chain can never be
 * replayed against the other.
 *
 * Zero external runtime dependencies: only `node:crypto` is used.
 */

import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** Domain separation labels for the two append-only ledgers. */
export type ChainDomain = "security-audit-v1" | "billing-ledger-v1";

const CHAIN_SALT = "vellum-chain-salt-v1";
const CHAIN_KEY_BYTES = 32;
const GENESIS_PREV_HASH = "0".repeat(64);
const MAX_SERIALIZE_DEPTH = 64;

/**
 * Constant-time comparison for arbitrary secret or token strings.
 * Compares SHA-256 digests so timing does not leak secret length, then
 * verifies exact byte equality when lengths match.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  const digestsMatch = timingSafeEqual(digestA, digestB);
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return digestsMatch && timingSafeEqual(bufA, bufB);
}

/**
 * Derive a 32-byte chain key from the master key, bound to a single ledger.
 */
export function deriveChainKey(masterKey: string | Buffer, domain: ChainDomain): Buffer {
  // hkdfSync returns an ArrayBuffer in current Node typings; Buffer.from copies it.
  return Buffer.from(hkdfSync("sha256", masterKey, CHAIN_SALT, domain, CHAIN_KEY_BYTES));
}

function serializeNode(obj: unknown, depth: number, active: WeakSet<object>): string {
  if (obj === null || obj === undefined) {
    return "null";
  }

  switch (typeof obj) {
    case "string":
    case "boolean": {
      const encoded = JSON.stringify(obj);
      return encoded === undefined ? "null" : encoded;
    }
    case "bigint": {
      // JSON.stringify throws on bigint; serialize as a quoted decimal string.
      return JSON.stringify(obj.toString());
    }
    case "number": {
      return Number.isFinite(obj) ? JSON.stringify(obj) : "null";
    }
    case "object": {
      break;
    }
    default: {
      // function / symbol have no deterministic JSON representation.
      return "null";
    }
  }

  if (obj instanceof Date) {
    return Number.isNaN(obj.getTime()) ? "null" : JSON.stringify(obj.toISOString());
  }

  if (depth >= MAX_SERIALIZE_DEPTH) {
    return JSON.stringify("[MaxDepth]");
  }

  if (active.has(obj)) {
    return JSON.stringify("[Circular]");
  }

  active.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const item of obj) {
        parts.push(serializeNode(item, depth + 1, active));
      }
      return `[${parts.join(",")}]`;
    }

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      const value: unknown = record[key];
      parts.push(`${JSON.stringify(key)}:${serializeNode(value, depth + 1, active)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    active.delete(obj);
  }
}

/**
 * Deterministic JSON serialization with lexicographically sorted object keys
 * at every level. Arrays keep their insertion order. `undefined` maps to
 * `null` everywhere so the function is total and always returns a string.
 * Non-finite numbers also map to `null`, matching JSON semantics.
 * Circular references and excessive nesting are handled safely without throwing.
 */
export function canonicalSerialize(obj: unknown): string {
  return serializeNode(obj, 0, new WeakSet<object>());
}

/** HMAC-SHA256 of the canonical chain message, encoded as lowercase hex. */
export function computeChainHash(
  key: Buffer,
  seq: number,
  prevHash: string,
  timestampIso: string,
  payload: unknown,
): string {
  const message = `${seq}|${prevHash}|${timestampIso}|${canonicalSerialize(payload)}`;
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export interface ChainRow {
  seq: number;
  prevHash: string;
  entryHash: string;
  timestampIso: string;
  payload: unknown;
}

export interface ChainVerification {
  valid: boolean;
  totalChecked: number;
  firstCorruptedSeq: number | null;
  reason: string | null;
}

/**
 * Constant-time comparison of two hex digests. Malformed, odd-length or
 * non-hex input is reported as a mismatch instead of throwing.
 */
function hexEqual(expectedHex: string, actualHex: string): boolean {
  if (typeof actualHex !== "string" || typeof expectedHex !== "string") {
    return false;
  }
  if (actualHex.length !== expectedHex.length || actualHex.length === 0 || actualHex.length % 2 !== 0) {
    return false;
  }
  if (!/^[0-9a-fA-F]+$/.test(actualHex) || !/^[0-9a-fA-F]+$/.test(expectedHex)) {
    return false;
  }
  try {
    const expected = Buffer.from(expectedHex, "hex");
    const actual = Buffer.from(actualHex, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Verify every row in sequence order. Stops at the first broken link and
 * reports how many rows were fully verified before it.
 */
export function verifyHashChain(key: Buffer, rows: readonly ChainRow[]): ChainVerification {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  let expectedPrevHash = GENESIS_PREV_HASH;

  for (let index = 0; index < ordered.length; index++) {
    const row: ChainRow | undefined = ordered[index];
    if (row === undefined) {
      continue;
    }

    if (!hexEqual(expectedPrevHash, row.prevHash)) {
      return {
        valid: false,
        totalChecked: index,
        firstCorruptedSeq: row.seq,
        reason: "prev_hash_mismatch",
      };
    }

    const computedHash = computeChainHash(
      key,
      row.seq,
      row.prevHash,
      row.timestampIso,
      row.payload,
    );
    if (!hexEqual(computedHash, row.entryHash)) {
      return {
        valid: false,
        totalChecked: index,
        firstCorruptedSeq: row.seq,
        reason: "entry_hash_mismatch",
      };
    }

    expectedPrevHash = row.entryHash;
  }

  return {
    valid: true,
    totalChecked: ordered.length,
    firstCorruptedSeq: null,
    reason: null,
  };
}
