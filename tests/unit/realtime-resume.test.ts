/** resume replay confirmation, cap, isolation and dedupe. */

import { describe, it, expect } from "vitest";
import { DataPlaneStore } from "@vellum/storage/adapters";
import type { OutboxEvent, TenantContext } from "@vellum/storage";
import { hashApiKey, type ApiKeyRecord } from "@vellum/authorization";
import { RealtimeGatewayHub, MAX_REPLAY_EVENTS } from "@vellum/realtime";
import type { ServerFrame } from "@vellum/api-contract";

const TENANT: TenantContext = {
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const OTHER: TenantContext = {
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const RAW_API_KEY = "pk_1234567890abcdef1234567890abcdef";

class ControlStore {
  public readonly apiKeysByPrefix = new Map<string, ApiKeyRecord>();
  constructor() {
    const prefix = RAW_API_KEY.slice(0, 16);
    this.apiKeysByPrefix.set(prefix, {
      id: "key_resume",
      projectId: TENANT.projectId,
      name: "Resume Test Key",
      keyType: "server",
      keyPrefix: prefix,
      secretHash: hashApiKey(RAW_API_KEY),
      scopes: ["*"],
      rateLimitRps: 1000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    });
  }
  getProject(projectId: string) {
    return {
      project: { id: projectId, name: "P" },
    };
  }
  getActiveRuleset(): unknown {
    return null;
  }
  incrementUsage(): void {}
}

function outboxEvent(ctx: TenantContext, seq: number, path: string): OutboxEvent {
  return {
    seqId: String(seq),
    projectId: ctx.projectId,
    collectionPath: "messages",
    path,
    documentId: path.split("/").pop() ?? path,
    opType: "created",
    version: 1,
    beforeData: null,
    afterData: { seq },
    committedAt: new Date().toISOString(),
  };
}

function mutations(frames: ServerFrame[]): Extract<ServerFrame, { type: "mutation" }>[] {
  return frames.filter((f): f is Extract<ServerFrame, { type: "mutation" }> => f.type === "mutation");
}

describe("realtime resumeSeqId replay", () => {
  it("replays only the authenticated tenant's events and sends resume_complete", async () => {
    const store = new DataPlaneStore();
    const a1 = await store.appendOutbox(TENANT, {
      collectionPath: "messages", path: "messages/a1", documentId: "a1",
      opType: "created", version: 1, beforeData: null, afterData: { seq: 1 },
    });
    await store.appendOutbox(OTHER, {
      collectionPath: "messages", path: "messages/other", documentId: "other",
      opType: "created", version: 1, beforeData: null, afterData: { seq: 2 },
    });
    const a3 = await store.appendOutbox(TENANT, {
      collectionPath: "messages", path: "messages/a1", documentId: "a1",
      opType: "updated", version: 2, beforeData: null, afterData: { seq: 3 },
    });

    const hub = new RealtimeGatewayHub({ controlStore: new ControlStore(), dataStore: store });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((frame) => frames.push(frame));
    await session.handleClientFrame({
      type: "auth", projectId: TENANT.projectId, apiKey: RAW_API_KEY,
    });
    await session.handleClientFrame({
      type: "subscribe", subId: "sub_resume", path: "messages/a1", resumeSeqId: 0,
    });

    // `resume_complete` is an additive frame (see packages/realtime/src/types.ts).
    const wideFrames = frames as unknown as Array<{
      type: string;
      seqId?: string;
      count?: number;
      truncated?: boolean;
    }>;
    const complete = wideFrames.find((f) => f.type === "resume_complete");
    expect(complete).toBeDefined();
    expect(complete?.count).toBe(2);
    expect(complete?.seqId).toBe(a3.seqId);
    expect(complete?.truncated).toBe(false);

    const replayed = mutations(frames);
    expect(replayed.map((m) => m.document.path)).toEqual(["messages/a1", "messages/a1"]);
    expect(replayed.every((m) => m.document.path !== "messages/other")).toBe(true);

    // A live event already replayed must not be delivered twice.
    await hub.notifyCommittedEvents(TENANT.projectId, [
      outboxEvent(TENANT, Number(a1.seqId), "messages/a1"),
    ]);
    expect(mutations(frames)).toHaveLength(2);

    // A genuinely new event is still delivered once.
    const a4 = await store.appendOutbox(TENANT, {
      collectionPath: "messages", path: "messages/a1", documentId: "a1",
      opType: "updated", version: 2, beforeData: null, afterData: { seq: 4 },
    });
    await hub.notifyCommittedEvents(TENANT.projectId, [
      outboxEvent(TENANT, Number(a4.seqId), "messages/a1"),
    ]);
    expect(mutations(frames)).toHaveLength(3);
  });

  it("exposes a 5,000-event replay ceiling", () => {
    expect(MAX_REPLAY_EVENTS).toBe(5_000);
  });
});
