import { VellumError, getFieldByPath } from "@vellum/core";
import { parseReference, resolveIncludes, type IncludeSpec } from "@vellum/document-engine";
import { authorizeOperation, type ApiKeyRecord, type AuthContext, type SecurityRulesetRecord } from "@vellum/authorization";
import type { DocumentRecord, StorageAdapter, TxHandle } from "@vellum/storage";

export const MAX_REALTIME_REFERENCE_PATHS = 1000;
export type RealtimeDocument = {
  path: string; data: Record<string, unknown>;
  _included?: Record<string, unknown>; _redactedRefs?: string[];
};

export function validateRealtimeIncludes(specs: IncludeSpec[]): void {
  if (specs.length > 10 || specs.some((s) => s.include?.length)) {
    throw new VellumError("INVALID_ARGUMENT", "Realtime includes allow at most 10 specs and depth 1");
  }
}

/** One unioned batch per live event, never one database query per subscriber. */
export async function fetchRealtimeReferences(
  projectId: string, parents: RealtimeDocument[], specs: IncludeSpec[], store: StorageAdapter, tx?: TxHandle
): Promise<ReadonlyMap<string, DocumentRecord>> {
  const paths = new Set<string>();
  const uniqueSpecs = new Map(specs.map((spec) => [JSON.stringify([spec.field, spec.collection ?? null]), spec]));
  for (const parent of parents) for (const spec of uniqueSpecs.values()) {
    const raw = getFieldByPath(parent.data, spec.field);
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const path = parseReference(value, spec);
      if (path && path !== parent.path) paths.add(path);
      if (paths.size > MAX_REALTIME_REFERENCE_PATHS) throw new VellumError("RESPONSE_TOO_LARGE", "Realtime includes exceed 1000 unique reference paths");
    }
  }
  if (!paths.size) return new Map();
  const load = async (handle: TxHandle) => {
    const keys = [...paths].sort();
    const rows = handle.batchGetDocuments ? await handle.batchGetDocuments(keys) : (await Promise.all(keys.map((p) => handle.getDocument(p)))).filter((d): d is DocumentRecord => d !== null);
    if (Buffer.byteLength(JSON.stringify(rows), "utf8") > 1_048_576) throw new VellumError("RESPONSE_TOO_LARGE", "Realtime references exceed 1 MiB");
    return new Map(rows.map((row) => [row.path, row]));
  };
  return tx ? load(tx) : store.withTransaction({ projectId }, load);
}

/** A fresh clone and a fresh authorization check for every subscriber. */
export async function enrichRealtimeDocument<T extends RealtimeDocument>(
  document: T, includes: IncludeSpec[], references: ReadonlyMap<string, DocumentRecord>,
  apiKeyRecord: ApiKeyRecord, authContext: AuthContext, rulesetRecord: SecurityRulesetRecord | null
): Promise<T> {
  const result = structuredClone(document);
  const publicReference = (row: DocumentRecord) => ({
    path: row.path, collectionPath: row.collectionPath, collectionGroup: row.collectionGroup,
    documentId: row.documentId, data: structuredClone(row.data), version: row.version,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  });
  await resolveIncludes<RealtimeDocument>({
    docs: [result], includes,
    getDocument: async (path) => {
      const row = references.get(path); return row ? publicReference(row) : null;
    },
    getDocumentBatch: async (paths) => paths.flatMap((path) => {
      const row = references.get(path); return row ? [publicReference(row)] : [];
    }),
    canRead: (row) => {
      try {
        authorizeOperation({ apiKeyRecord, authContext, rulesetRecord, operation: "get", path: row.path, resourceData: row.data });
        return true;
      } catch { return false; }
    },
  });
  // Exact hidden target paths are not additional realtime metadata.
  delete (result as T & { _redactedRefPaths?: unknown })._redactedRefPaths;
  return result;
}
