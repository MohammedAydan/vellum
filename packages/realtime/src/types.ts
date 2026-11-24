/**
 * @vellum/realtime - Types and Interfaces
 * Specification Section 9.1 & 9.2
 */

import type { IncludeSpec } from "@vellum/document-engine";
import type { ClientFrame, ResumeCompleteFrame, ServerFrame } from "@vellum/api-contract";
import type { NormalizedQuery } from "@vellum/query-engine";
import type { ApiKeyRecord, AuthContext, SecurityRulesetRecord } from "@vellum/authorization";
import type { StorageAdapter, OutboxEvent } from "@vellum/storage";

export type { ClientFrame, ServerFrame, ResumeCompleteFrame };

export interface SubscriptionRecord {
  subId: string;
  includes?: IncludeSpec[] | undefined;
  path: string | null;
  normalizedQuery: NormalizedQuery | null;
  matchedPaths: Set<string>;
  /** Exact seqIds already delivered to this subscription (notify + poll dedupe). */
  seenSeqIds: Set<string>;
  /**
   * True while `resumeSeqId` replay is walking the outbox. Live events that
   * arrive during the walk are buffered so the client always observes strictly
   * ascending `seq_id` order (replay first, then live) instead of an interleaved
   * or reversed stream.
   */
  replaying?: boolean | undefined;
  /** Live events deferred until replay completes, flushed in ascending seq order. */
  pendingLiveEvents?: OutboxEvent[] | undefined;
}

/** `resume_complete` is now part of the shared api-contract ServerFrame union. */
export type RealtimeServerFrame = ServerFrame;

export interface ConnectionSession {
  connectionId: string;
  authenticated: boolean;
  projectId: string | null;
  apiKeyRecord: ApiKeyRecord | null;
  authContext: AuthContext;
  subscriptions: Map<string, SubscriptionRecord>;
  outboundBufferedBytes: number;
  closed: boolean;
  sendFrame: (frame: ServerFrame) => void;
}

export interface ConnectionSessionHandle {
  connectionId: string;
  handleClientFrame: (rawFrame: unknown) => Promise<void> | void;
  setSimulatedBackpressureBytes: (bytes: number) => void;
  close: () => void;
}

/**
 * Shape accepted from the control plane's project lookup. Both a bare project
 * record and a `{ project }` wrapper are supported so the gateway stays
 * compatible with either control-store result shape.
 */
export type ProjectLookupResult =
  | { project: { id: string; name?: string | undefined } }
  | { id: string; name?: string | undefined }
  | null;

export interface ControlStoreForRealtime {
  getProject(projectId: string): ProjectLookupResult;
  getApiKeyByPrefix?(prefix: string): ApiKeyRecord | null;
  /** Ed25519 public key for the project's end-user access tokens. */
  getAuthConfig?(projectId: string): { jwtPublicKeyPem: string } | null;
  getActiveRuleset(projectId: string): SecurityRulesetRecord | null;
  /** Durable metering; PostgreSQL-backed stores return a promise. */
  incrementUsage(
    projectId: string,
    usage: {
      realtimeMessagesSent?: number;
    }
  ): unknown | Promise<unknown>;
}

export interface RealtimeHubOptions {
  apiKeyPepper?: string | undefined;
  controlStore: ControlStoreForRealtime;
  dataStore: StorageAdapter;
  jwtSecret?: string | undefined;
}

export interface CompactRealtimeEvent {
  projectId: string;
  collectionPath: string;
  path: string;
  seqId: string;
}

export interface PubSubBus {
  publishCommittedBatch(projectId: string, events: OutboxEvent[]): Promise<void>;
  subscribeTenantChannel(
    projectId: string,
    onMessage: (event: CompactRealtimeEvent) => void
  ): () => void;
}
