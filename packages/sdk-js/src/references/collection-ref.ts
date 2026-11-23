/**
 * @vellumdb/sdk-js - CollectionReference
 *
 * Extends `QueryBuilder<T>` with document addressing (`doc()`, `add()`),
 * typed converter attachment (`withConverter<U>()`), and collection lifecycle
 * operations (`create()`, `info()`, `clear()`, `drop()`/`delete()`, `import()`, `export()`).
 */

import { encodePathSegment } from "../core/safe-json.js";
import type {
  CollectionInfo,
  CollectionReferenceInterface,
  CreateCollectionOptions,
  DocDataConverter,
  DocumentCreateOptions,
  DocumentReferenceInterface,
  ExportResult,
  ImportDocumentInput,
  ImportResult,
  RequestOptions,
} from "../types.js";
import { DocumentReference, type DocumentReferenceContext } from "./document-ref.js";
import { QueryBuilder, type QueryBuilderContext } from "./query-builder.js";

export interface CollectionReferenceContext extends QueryBuilderContext, DocumentReferenceContext {
  createCollection(name: string, options?: CreateCollectionOptions): Promise<CollectionInfo>;
  getCollectionInfo(name: string, options?: RequestOptions): Promise<CollectionInfo | null>;
  clearCollection(name: string, options?: RequestOptions): Promise<{ deletedCount: number; freedBytes: number }>;
  deleteCollection(
    name: string,
    options?: RequestOptions
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }>;
  importDocuments(
    collection: string,
    docs: ImportDocumentInput[],
    options?: { mode?: "upsert" | "insert_only"; signal?: AbortSignal }
  ): Promise<ImportResult>;
  exportDocuments(
    collection: string,
    options?: { limit?: number; cursor?: string | null; signal?: AbortSignal }
  ): Promise<ExportResult>;
}

function generateAutoDocId(): string {
  const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID().replace(/-/g, "");
  }
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export class CollectionReference<T = Record<string, unknown>>
  extends QueryBuilder<T>
  implements CollectionReferenceInterface<T>
{
  private readonly colCtx: CollectionReferenceContext;

  public constructor(
    ctx: CollectionReferenceContext,
    collectionPath: string,
    converter: DocDataConverter<T> | null = null
  ) {
    super(ctx, collectionPath, { converter });
    this.colCtx = ctx;
    Object.freeze(this);
  }

  public doc(docId: string): DocumentReferenceInterface<T> {
    encodePathSegment(docId, "document id");
    return new DocumentReference<T>(this.colCtx, `${this.collectionPath}/${docId}`, this.converter);
  }

  /** Create a new document in this collection with an auto-generated ID. */
  public async add(data: T, options: DocumentCreateOptions = {}): Promise<DocumentReferenceInterface<T>> {
    const ref = this.doc(generateAutoDocId());
    await ref.create(data, options);
    return ref;
  }

  public override withConverter<U>(converter: DocDataConverter<U>): CollectionReferenceInterface<U>;
  public override withConverter(converter: null): CollectionReferenceInterface<Record<string, unknown>>;
  public override withConverter<U>(
    converter: DocDataConverter<U> | null
  ): CollectionReferenceInterface<U> | CollectionReferenceInterface<Record<string, unknown>> {
    if (converter === null) {
      return new CollectionReference<Record<string, unknown>>(this.colCtx, this.collectionPath, null);
    }
    return new CollectionReference<U>(this.colCtx, this.collectionPath, converter);
  }

  public create(options: CreateCollectionOptions = {}): Promise<CollectionInfo> {
    return this.colCtx.createCollection(this.collectionPath, options);
  }

  public info(options: RequestOptions = {}): Promise<CollectionInfo | null> {
    return this.colCtx.getCollectionInfo(this.collectionPath, options);
  }

  public clear(options: RequestOptions = {}): Promise<{ deletedCount: number; freedBytes: number }> {
    return this.colCtx.clearCollection(this.collectionPath, options);
  }

  public drop(
    options: RequestOptions = {}
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }> {
    return this.colCtx.deleteCollection(this.collectionPath, options);
  }

  /** Alias of `drop()` for deleting this collection and all of its documents. */
  public delete(
    options: RequestOptions = {}
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }> {
    return this.drop(options);
  }

  public import(
    docs: ImportDocumentInput[],
    options: { mode?: "upsert" | "insert_only"; signal?: AbortSignal } = {}
  ): Promise<ImportResult> {
    return this.colCtx.importDocuments(this.collectionPath, docs, options);
  }

  public export(
    options: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {}
  ): Promise<ExportResult> {
    return this.colCtx.exportDocuments(this.collectionPath, options);
  }
}
