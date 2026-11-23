/**
 * @vellumdb/sdk-js - Immutable Document & Query Snapshots
 *
 * Snapshot metadata objects (`id`, `path`, `version`, `exists`, `redactedRefs`)
 * are frozen (`Object.freeze`) so callers cannot tamper with SDK snapshot state,
 * while `.data()` returns a fresh prototype-safe defensive clone on every call.
 */

import { isRecord } from "../auth/jwt-utils.js";
import { sanitizeAndClone } from "../core/safe-json.js";
import type {
  DocDataConverter,
  DocumentSnapshot,
  IncludeSpec,
  IncludeSpecInput,
  QuerySnapshot,
} from "../types.js";

export interface WireDocument {
  documentId?: string;
  path: string;
  version: number;
  data?: unknown;
  _included?: Record<string, unknown>;
  _redactedRefs?: string[];
}

/** Normalize a relation include, expanding `'field'` to `{ field: 'field' }`. */
export function normalizeInclude(relation: string | IncludeSpecInput | unknown): IncludeSpec {
  if (typeof relation === "string") return { field: relation };
  if (!isRecord(relation)) return { field: "" };
  const out: IncludeSpec = { field: typeof relation["field"] === "string" ? relation["field"] : "" };
  if (typeof relation["collection"] === "string") out.collection = relation["collection"];
  if (typeof relation["as"] === "string") out.as = relation["as"];
  if (Array.isArray(relation["select"])) {
    out.select = relation["select"].filter((field): field is string => typeof field === "string");
  }
  if (Array.isArray(relation["include"]) && relation["include"].length > 0) {
    out.include = relation["include"].map(normalizeInclude);
  }
  return out;
}

/** Parse an untrusted wire document (e.g. from realtime frames) into a frozen snapshot. */
export function parseWireDocument(value: unknown): DocumentSnapshot<Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  const raw = sanitizeAndClone(value) as Partial<WireDocument>;
  if (typeof raw.path !== "string" || raw.path.length === 0) return null;
  const id = typeof raw.documentId === "string" ? raw.documentId : (raw.path.split("/").pop() ?? "");
  const version = typeof raw.version === "number" ? raw.version : 0;
  const data: Record<string, unknown> = isRecord(raw.data) ? sanitizeAndClone(raw.data) : {};
  const snapshot: DocumentSnapshot<Record<string, unknown>> = {
    id,
    path: raw.path,
    version,
    exists: true,
    data: () => sanitizeAndClone(data),
    raw: Object.freeze(raw),
    ...(raw._included !== undefined ? { included: sanitizeAndClone(raw._included) } : {}),
    ...(raw._redactedRefs !== undefined ? { redactedRefs: Object.freeze([...raw._redactedRefs]) as string[] } : {}),
  };
  return Object.freeze(snapshot);
}

/** Apply an optional `DocDataConverter<T>` to a raw document snapshot, returning a frozen typed snapshot. */
export function applyConverterToSnapshot<T>(
  rawSnapshot: DocumentSnapshot<Record<string, unknown>>,
  converter: DocDataConverter<T> | null
): DocumentSnapshot<T> {
  if (!converter) {
    return rawSnapshot as unknown as DocumentSnapshot<T>;
  }
  const converted: DocumentSnapshot<T> = {
    id: rawSnapshot.id,
    path: rawSnapshot.path,
    version: rawSnapshot.version,
    exists: rawSnapshot.exists,
    data: () => converter.fromDoc(rawSnapshot),
    raw: rawSnapshot.raw,
    ...(rawSnapshot.included !== undefined ? { included: rawSnapshot.included } : {}),
    ...(rawSnapshot.redactedRefs !== undefined ? { redactedRefs: rawSnapshot.redactedRefs } : {}),
  };
  return Object.freeze(converted);
}

/** Build an immutable, frozen `DocumentSnapshot<T>` from a wire document payload. */
export function buildDocumentSnapshot<T = Record<string, unknown>>(
  wire: WireDocument,
  converter: DocDataConverter<T> | null = null
): DocumentSnapshot<T> {
  const cloned = sanitizeAndClone(wire);
  const id =
    typeof cloned.documentId === "string"
      ? cloned.documentId
      : (cloned.path.split("/").pop() ?? "");
  const version = typeof cloned.version === "number" ? cloned.version : 0;
  const rawSnapshot: DocumentSnapshot<Record<string, unknown>> = Object.freeze({
    id,
    path: cloned.path,
    version,
    exists: true,
    data: () => sanitizeAndClone(cloned.data) as Record<string, unknown>,
    raw: Object.freeze(sanitizeAndClone(cloned)),
    ...(cloned._included !== undefined ? { included: sanitizeAndClone(cloned._included) } : {}),
    ...(cloned._redactedRefs !== undefined
      ? { redactedRefs: Object.freeze([...cloned._redactedRefs]) as string[] }
      : {}),
  });
  return applyConverterToSnapshot(rawSnapshot, converter);
}

/** Build an immutable, frozen `QuerySnapshot<T>` from wire query results. */
export function buildQuerySnapshot<T = Record<string, unknown>>(
  documents: readonly WireDocument[],
  nextCursor: string | null,
  meta: unknown,
  converter: DocDataConverter<T> | null = null
): QuerySnapshot<T> {
  return Object.freeze({
    docs: documents.map((d) => buildDocumentSnapshot(d, converter)),
    nextCursor,
    meta: sanitizeAndClone(meta),
  });
}
