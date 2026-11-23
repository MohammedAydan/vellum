import type { ReferencedByRequest, ReferencedByResult } from "../referenced-by.js";
/**
 * @vellum/document-engine - Canonical Document Engine Port Contract
 */

import type { QuerySpec, WhereClause } from "@vellum/query-engine";
import type {
  CollectionRecord,
  CollectionWithStats,
  CreateCollectionInput,
  ListCollectionsOptions,
  UpdateCollectionInput,
} from "@vellum/storage";
import type { IncludeSpec } from "../relations.js";
import type {
  AggregateRequest,
  AggregateResult,
  BatchMutation,
  BatchWriteResult,
  DeleteResult,
  EngineContext,
  ExportCollectionDocumentsOptions,
  ExportCollectionDocumentsResult,
  ExportedCollectionDocument,
  ImportCollectionDocumentsOptions,
  ImportCollectionDocumentsResult,
  PublicDocument,
  QueryResult,
  TransactionBeginResult,
} from "../types.js";

/**
 * Inbound port matching `DocumentEngine`'s public operations across document
 * CRUD, atomic batches, OCC transactions, queries, aggregations, and
 * collection lifecycle management.
 */
export interface DocumentEnginePort {
  referencedBy(ctx: EngineContext & { request: ReferencedByRequest }): Promise<ReferencedByResult>;
  getDocument(
    ctx: EngineContext & { path: string; include?: IncludeSpec[] | undefined }
  ): Promise<PublicDocument>;

  createDocument(
    ctx: EngineContext & { path: string; data: Record<string, unknown> }
  ): Promise<PublicDocument>;

  setDocument(
    ctx: EngineContext & {
      path: string;
      data: Record<string, unknown>;
      merge?: boolean | undefined;
      ifVersion?: number | null | undefined;
    }
  ): Promise<PublicDocument>;

  updateDocument(
    ctx: EngineContext & {
      path: string;
      data: Record<string, unknown>;
      ifVersion?: number | null | undefined;
    }
  ): Promise<PublicDocument>;

  deleteDocument(
    ctx: EngineContext & {
      path: string;
      ifVersion?: number | null | undefined;
    }
  ): Promise<DeleteResult>;

  batchWrite(ctx: EngineContext & { writes: BatchMutation[] }): Promise<BatchWriteResult>;

  beginTransaction(ctx: EngineContext): Promise<TransactionBeginResult>;

  commitTransaction(
    ctx: EngineContext & { transactionToken: string; writes: BatchMutation[] }
  ): Promise<BatchWriteResult>;

  rollbackTransaction(ctx: EngineContext & { transactionToken: string }): Promise<void>;

  cleanupExpiredTransactions(ctx: EngineContext): Promise<number>;

  executeQuery(ctx: EngineContext & { querySpec: QuerySpec }): Promise<QueryResult>;

  aggregateDocuments(ctx: EngineContext & { request: AggregateRequest }): Promise<AggregateResult>;

  deleteWhere(
    ctx: EngineContext & {
      collectionPath: string;
      where?: WhereClause[] | undefined;
      or?: WhereClause[][] | undefined;
      limit?: number | undefined;
    }
  ): Promise<{ deletedCount: number }>;

  getDocuments(
    ctx: EngineContext & {
      paths: string[];
      include?: IncludeSpec[] | undefined;
      select?: string[] | undefined;
    }
  ): Promise<PublicDocument[]>;

  exportCollectionDocumentsStream(
    ctx: EngineContext,
    name: string,
    opts?: ExportCollectionDocumentsOptions | undefined
  ): AsyncIterable<ExportedCollectionDocument>;

  restoreDocument(
    ctx: EngineContext & { path: string; ifVersion: number }
  ): Promise<PublicDocument>;

  listCollections(
    ctx: EngineContext,
    opts?: ListCollectionsOptions
  ): Promise<{ collections: CollectionWithStats[]; nextCursor: string | null }>;

  getCollection(ctx: EngineContext, name: string): Promise<CollectionWithStats | null>;

  createCollection(ctx: EngineContext, input: CreateCollectionInput): Promise<CollectionRecord>;

  updateCollection(
    ctx: EngineContext,
    name: string,
    patch: UpdateCollectionInput
  ): Promise<CollectionWithStats>;

  clearCollection(
    ctx: EngineContext,
    name: string
  ): Promise<{ deletedCount: number; freedBytes: number }>;

  deleteCollection(
    ctx: EngineContext,
    name: string
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }>;

  importCollectionDocuments(
    ctx: EngineContext,
    name: string,
    docs: Record<string, unknown>[],
    opts?: ImportCollectionDocumentsOptions & { limit?: number | undefined }
  ): Promise<ImportCollectionDocumentsResult>;

  exportCollectionDocuments(
    ctx: EngineContext,
    name: string,
    opts?: ExportCollectionDocumentsOptions
  ): Promise<ExportCollectionDocumentsResult>;
}
