import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { VellumError } from "@vellum/core";
import type { DocumentRecord, TxHandle } from "@vellum/storage";
import type { PublicDocument } from "./types.js";

export interface ReferencedByRequest {
  targetPath: string;
  collection?: string | undefined;
  field?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}
export interface ReferencedByResult {
  documents: PublicDocument[];
  nextCursor: string | null;
}

const CURSOR_TTL_MS = 60 * 60 * 1000;
export const MAX_REFERENCED_BY_LIMIT = 100;
export const MAX_REFERENCED_BY_CANDIDATES = 1000;

/** Encrypt, not just sign: a continuation can point past unreadable rows. */
function encodeCursor(after: string, scope: string, secret: string): string {
  const key = createHash("sha256").update(`referencedBy:v1:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(scope));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ after, expires: Date.now() + CURSOR_TTL_MS }), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function decodeCursor(token: string, scope: string, secret: string): string {
  try {
    if (typeof token !== "string" || token.length > 32768 || !/^[\w-]+$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length < 30) throw new Error();
    const key = createHash("sha256").update(`referencedBy:v1:${secret}`).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
    if (typeof payload.after !== "string" || typeof payload.expires !== "number" || payload.expires < Date.now()) throw new Error();
    return payload.after;
  } catch {
    throw new VellumError("INVALID_ARGUMENT", "Invalid or expired referencedBy cursor");
  }
}

export async function scanReferencedBy(options: {
  request: ReferencedByRequest;
  tx: Pick<TxHandle, "referencedByPage">;
  scope: string;
  secret: string;
  canRead: (row: DocumentRecord) => boolean;
  format: (row: DocumentRecord) => PublicDocument;
}): Promise<ReferencedByResult & { scanned: number }> {
  const { request, tx, scope, secret, canRead, format } = options;
  if (!tx.referencedByPage) throw new VellumError("INTERNAL_ERROR", "Storage adapter does not support referencedBy pagination");
  const limit = request.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REFERENCED_BY_LIMIT) {
    throw new VellumError("INVALID_ARGUMENT", "referencedBy limit must be an integer from 1 to 100");
  }
  let after = request.cursor === undefined ? null : decodeCursor(request.cursor, scope, secret);
  let scanned = 0;
  const documents: PublicDocument[] = [];
  while (scanned < MAX_REFERENCED_BY_CANDIDATES) {
    const take = Math.min(100, MAX_REFERENCED_BY_CANDIDATES - scanned);
    const rows = await tx.referencedByPage({ ...request, afterPath: after, limit: take });
    for (const row of rows) {
      // Leave lookahead unread/unsent. The next request must reauthorize it.
      if (canRead(row)) {
        if (documents.length === limit) return { documents, scanned, nextCursor: encodeCursor(after!, scope, secret) };
        documents.push(format(row));
      }
      scanned++;
      after = row.path;
    }
    if (rows.length < take) return { documents, scanned, nextCursor: null };
  }
  return { documents, scanned, nextCursor: after ? encodeCursor(after, scope, secret) : null };
}
