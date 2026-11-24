/**
 * @vellumdb/sdk-js - CollectionReference
 *
 * Extends `QueryBuilder<T>` with document addressing (`doc()`, `add()`),
 * typed converter attachment (`withConverter<U>()`), and collection lifecycle
 * operations (`create()`, `info()`, `clear()`, `drop()`/`delete()`, `import()`, `export()`).
 */

import { reference } from "../core/reference.js";
import { generateAutoDocId } from "../core/auto-id.js";
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
import { DocumentReference, replaceDocumentReferences, type DocumentReferenceContext } from "./document-ref.js";
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

/** One group of related documents for `addWithRelated`. */
export interface RelatedWrite {
  /** Collection the related documents are created in. */
  collection: string;
  /** Documents to create (they may contain DocumentReference values). */
  docs: Record<string, unknown>[];
  /** Optional field on each child that references the new parent document. */
  parentField?: string;
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

  /**
   * Address a document. Without an argument a unique ID is generated locally
   * (no network request); the document is created on the first `set()`.
   */
  public doc(docId?: string): DocumentReferenceInterface<T> {
    const auto = docId === undefined;
    const id = auto ? generateAutoDocId() : docId;
    encodePathSegment(id, "document id");
    return new DocumentReference<T>(this.colCtx, `${this.collectionPath}/${id}`, this.converter, auto);
  }

  /** Create a new document in this collection with an auto-generated ID. */
  public async add(data: T, options: DocumentCreateOptions = {}): Promise<DocumentReferenceInterface<T>> {
    const ref = this.doc();
    await ref.create(data, options);
    return ref;
  }

  /**
   * Create a document and its related documents in ONE atomic request.
   *
   * `related` maps a field on the parent to the child collection and docs. The
   * parent gets `field: [ref, ...]`, and each child gets a `parentField`
   * reference back to the parent when `parentField` is set. Either everything
   * is written or nothing is.
   */
  public async addWithRelated(
    data: T,
    related: Record<string, RelatedWrite>,
    options: RequestOptions = {}
  ): Promise<DocumentReferenceInterface<T>> {
    const parent = this.doc();
    const parentData: Record<string, unknown> = { ...(replaceDocumentReferences(data) as Record<string, unknown>) };
    const writes: Array<{ type: "set"; path: string; data: Record<string, unknown> }> = [];
    for (const [field, spec] of Object.entries(related)) {
      encodePathSegment(spec.collection, "related collection");
      const refs: unknown[] = [];
      for (const childData of spec.docs) {
        const childPath = `${spec.collection}/${generateAutoDocId()}`;
        refs.push(reference(childPath));
        writes.push({
          type: "set",
          path: childPath,
          data: {
            ...(replaceDocumentReferences(childData) as Record<string, unknown>),
            ...(spec.parentField ? { [spec.parentField]: reference(parent.path) } : {}),
          },
        });
      }
      parentData[field] = refs;
    }
    writes.unshift({ type: "set", path: parent.path, data: parentData });
    if (writes.length > 500) {
      throw new Error("@vellumdb/sdk-js: addWithRelated supports at most 500 documents per call");
    }
    await this.colCtx.request("POST", "/batchWrite", { writes }, {}, true, options.signal);
    for (const w of writes) this.colCtx.invalidateDocCache(w.path);
    return parent;
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
