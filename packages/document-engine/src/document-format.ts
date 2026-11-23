/** Defensive public document formatting and dot-path projection. */
import { getFieldByPath } from "@vellum/core";
import type { DocumentRecord } from "@vellum/storage";
import { setPath, toIsoDate } from "./path-utils.js";
import type { PublicDocument } from "./types.js";

export function projectDocumentFields(
  data: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (typeof field !== "string" || field.length === 0) continue;
    // The compiler emits a flat map keyed by the full dot path; fall back to
    // walking the raw nested document for callers that pass unprojected data.
    const value = Object.prototype.hasOwnProperty.call(data, field) ? data[field] : getFieldByPath(data, field);
    if (value === undefined) continue;
    // `getFieldByPath` uses `in`, so prototype members such as `toString` can
    // surface here. They are never document data and are not structured-cloneable.
    if (typeof value === "function" || typeof value === "symbol") continue;
    let cloned: unknown;
    try {
      cloned = structuredClone(value);
    } catch {
      continue;
    }
    setPath(projected, field, cloned);
  }
  return projected;
}

export function formatPublicDocument(row: DocumentRecord, selectedFields?: string[] | null): PublicDocument {
  let data: Record<string, unknown>;
  if (Array.isArray(selectedFields) && selectedFields.length > 0) {
    // `projectDocumentFields` builds a fresh object and clones every selected
    // value once, so no second outer clone is needed.
    data = projectDocumentFields(row.data, selectedFields);
  } else {
    data = structuredClone(row.data);
  }
  return {
    path: row.path,
    collectionPath: row.collectionPath,
    collectionGroup: row.collectionGroup,
    documentId: row.documentId,
    data,
    sizeBytes: row.sizeBytes,
    version: row.version,
    status: "ok",
    expiresAt: toIsoDate(row.expiresAt),
    // Safe coercion: a malformed timestamp degrades to "" instead of throwing.
    createdAt: toIsoDate(row.createdAt) ?? "",
    updatedAt: toIsoDate(row.updatedAt) ?? "",
  };
}

