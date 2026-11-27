import { describe, it, expect, beforeEach } from "vitest";
import { RealtimeGatewayHub } from "../hub.js";
import {
  assertValidNotifyChannel,
  assertValidNotifyPayload,
  createPgNotifyBus,
  quoteNotifyChannel,
} from "../pg-notify-pubsub.js";
import { type OutboxEvent } from "@vellum/storage";
import { DataPlaneStore } from "@vellum/storage/adapters";
import {
  decryptPrivateKey,
  generateEd25519KeyPair,
  signEndUserAccessToken,
} from "@vellum/auth";
import { hashApiKey, signEndUserJwt, type ApiKeyRecord } from "@vellum/authorization";
import type { ServerFrame } from "@vellum/api-contract";

const TENANT = {
  projectId: "11111111-1111-1111-1111-111111111111",
};

const RAW_API_KEY = "pk_1234567890abcdef1234567890abcdef";

class MockControlStore {
  public apiKeysByPrefix = new Map<string, ApiKeyRecord>();
  public realtimeMessagesSent = 0;
  public authConfig: { jwtPublicKeyPem: string } | null = null;

  constructor() {
    const keyPrefix = RAW_API_KEY.slice(0, 16);
    this.apiKeysByPrefix.set(keyPrefix, {
      id: "key_1",
      projectId: TENANT.projectId,
      name: "Default Key",
      keyType: "server",
      keyPrefix,
      secretHash: hashApiKey(RAW_API_KEY),
      scopes: ["documents:read", "documents:write", "*"],
      rateLimitRps: 1000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    });
  }

  getProject(projectId: string) {
    return { project: { id: projectId, name: "Test Project" } };
  }

  getAuthConfig() {
    return this.authConfig;
  }

  getActiveRuleset() {
    return null;
  }

  incrementUsage(_projectId: string, usage: { realtimeMessagesSent?: number }) {
    if (usage.realtimeMessagesSent) {
      this.realtimeMessagesSent += usage.realtimeMessagesSent;
    }
  }
}

describe("@vellum/realtime - PostgreSQL NOTIFY bus (unit surface)", () => {
  it("validates and safely quotes NOTIFY channels and payloads", () => {
    expect(quoteNotifyChannel("vellum_outbox")).toBe('"vellum_outbox"');
    expect(quoteNotifyChannel('rt:"weird"')).toBe('"rt:""weird"""');
    expect(() => assertValidNotifyChannel("")).toThrow();
    expect(() => assertValidNotifyChannel("a\u0000b")).toThrow();
    expect(() => assertValidNotifyChannel("x".repeat(64))).toThrow();
    expect(() => assertValidNotifyPayload("ok")).not.toThrow();
    expect(() => assertValidNotifyPayload("x".repeat(8000))).toThrow();
  });

  it("creates a lazy bus that is safe to close without connecting", async () => {
    const bus = createPgNotifyBus({ connectionString: "postgresql://localhost/unused" });
    expect(typeof bus.publish).toBe("function");
    expect(typeof bus.subscribe).toBe("function");
    expect(typeof bus.close).toBe("function");
    await expect(bus.close()).resolves.toBeUndefined();
  });
});

describe("@vellum/realtime - Realtime Gateway Hub", () => {
  let hub: RealtimeGatewayHub;
  let dataStore: DataPlaneStore;
  let controlStore: MockControlStore;

  beforeEach(() => {
    dataStore = new DataPlaneStore();
    controlStore = new MockControlStore();
    hub = new RealtimeGatewayHub({
      controlStore,
      dataStore,
    });
  });

  it("handles ping/pong and authentication lifecycle", async () => {
    const receivedFrames: ServerFrame[] = [];
    const session = hub.createConnectionSession((frame) => {
      receivedFrames.push(frame);
    });

    // Ping
    await session.handleClientFrame({ type: "ping", ts: 12345 });
    expect(receivedFrames).toHaveLength(1);
    expect(receivedFrames[0]?.type).toBe("pong");
    if (receivedFrames[0]?.type === "pong") {
      expect(receivedFrames[0].ts).toBe(12345);
      expect(typeof receivedFrames[0].serverTs).toBe("number");
    }

    // Authenticate
    await session.handleClientFrame({
      type: "auth",
      projectId: TENANT.projectId,
      apiKey: RAW_API_KEY,
    });

    expect(receivedFrames).toHaveLength(2);
    expect(receivedFrames[1]?.type).toBe("auth_ack");
    if (receivedFrames[1]?.type === "auth_ack") {
      expect(receivedFrames[1].status).toBe("authenticated");
    }
  });

  it("verifies end-user WS tokens as EdDSA and rejects legacy HS256 tokens", async () => {
    const keyPair = generateEd25519KeyPair();
    controlStore.authConfig = { jwtPublicKeyPem: keyPair.publicKeyPem };
    const now = Math.floor(Date.now() / 1000);
    const token = signEndUserAccessToken(
      {
        iss: `https://api.vellum.dev/v1/projects/${TENANT.projectId}/auth`,
        sub: "enduser-1",
        aud: TENANT.projectId,
        jti: "jti-1",
        email: null,
        email_verified: false,
        is_anonymous: false,
        claims: { role: "moderator" },
        iat: now,
        exp: now + 600,
        auth_time: now,
      },
      decryptPrivateKey(keyPair.privateKeyEncrypted),
      keyPair.keyId
    );

    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((frame) => frames.push(frame));
    await session.handleClientFrame({
      type: "auth",
      projectId: TENANT.projectId,
      apiKey: RAW_API_KEY,
      authToken: token,
    });
    expect(frames.some((frame) => frame.type === "auth_ack")).toBe(true);
    // AuthContext is used by rules evaluation; verify it carries the claims.
    const authenticated = hub.connections.get(session.connectionId);
    expect(authenticated?.authContext.uid).toBe("enduser-1");
    expect(authenticated?.authContext.claims["role"]).toBe("moderator");

    // An HS256 token signed with the legacy shared secret must never be
    // accepted as an end-user access token on the WS handshake.
    const legacySession = hub.createConnectionSession(() => {});
    await expect(
      legacySession.handleClientFrame({
        type: "auth",
        projectId: TENANT.projectId,
          apiKey: RAW_API_KEY,
        authToken: signEndUserJwt({ sub: "enduser-1", exp: now + 600 }),
      })
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("subscribes to a document, receives snapshot and live updates", async () => {
    // Seed document in storage
    await dataStore.putDocument(TENANT, {
      projectId: TENANT.projectId,
      path: "posts/p1",
      collectionPath: "posts",
      collectionGroup: "posts",
      documentId: "p1",
      pathDepth: 2,
      data: { title: "Post 1" },
      sizeBytes: 50,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    });

    const receivedFrames: ServerFrame[] = [];
    const session = hub.createConnectionSession((frame) => {
      receivedFrames.push(frame);
    });

    await session.handleClientFrame({
      type: "auth",
      projectId: TENANT.projectId,
      apiKey: RAW_API_KEY,
    });

    // Subscribe to posts/p1
    await session.handleClientFrame({
      type: "subscribe",
      subId: "sub_1",
      path: "posts/p1",
    });

    // Expect auth_ack (index 0) and initial_sync (index 1)
    const initialSync = receivedFrames.find((f): f is Extract<ServerFrame, { type: "initial_sync" }> => f.type === "initial_sync");
    expect(initialSync).toBeDefined();
    expect(initialSync?.documents).toHaveLength(1);
    expect(initialSync?.documents[0]?.path).toBe("posts/p1");

    // Now notify of a committed update
    await hub.notifyCommittedEvents(TENANT.projectId, [
      {
        seqId: "2",
        projectId: TENANT.projectId,
        collectionPath: "posts",
        path: "posts/p1",
        documentId: "p1",
        opType: "updated",
        version: 2,
        beforeData: { title: "Post 1" },
        afterData: { title: "Post 1 Updated" },
        committedAt: new Date().toISOString(),
      },
    ]);

    const liveMutations = receivedFrames.filter((f): f is Extract<ServerFrame, { type: "mutation" }> => f.type === "mutation");
    expect(liveMutations).toHaveLength(1);
    expect(liveMutations[0]?.operation).toBe("update");
    expect(liveMutations[0]?.document.path).toBe("posts/p1");
  });

  it("keeps resume replay strictly ordered when live fan-out arrives mid-walk", async () => {
    const receivedFrames: ServerFrame[] = [];
    const session = hub.createConnectionSession((frame) => {
      receivedFrames.push(frame);
    });

    await session.handleClientFrame({
      type: "auth",
      projectId: TENANT.projectId,
      apiKey: RAW_API_KEY,
    });

    const outboxEvent = (seq: number, title: string): OutboxEvent => ({
      seqId: String(seq),
      projectId: TENANT.projectId,
      collectionPath: "posts",
      path: "posts/p1",
      documentId: "p1",
      opType: "updated",
      version: seq,
      beforeData: { title: "previous" },
      afterData: { title },
      committedAt: new Date().toISOString(),
    });

    // Hold the historical outbox query open so a live event can race the replay.
    let releaseReplay: (events: OutboxEvent[]) => void = () => {};
    const replayGate = new Promise<OutboxEvent[]>((resolve) => {
      releaseReplay = resolve;
    });
    const originalQuery = dataStore.queryOutboxSince.bind(dataStore);
    let queries = 0;
    dataStore.queryOutboxSince = async (ctx, afterSeqId = "0") => {
      queries += 1;
      if (queries === 1) return replayGate;
      return originalQuery(ctx, afterSeqId);
    };

    // Pretend seq 12 was already fanned out, so notify() is a plain delivery.
    hub.watermarks.set(TENANT.projectId, 12n);

    const subscribePromise = session.handleClientFrame({
      type: "subscribe",
      subId: "sub_resume",
      path: "posts/p1",
      resumeSeqId: 9,
    });

    // Wait until the subscription is registered (indexing happens before the
    // gated replay read), so the racing live event has a candidate to buffer for.
    for (let i = 0; i < 100; i += 1) {
      const sess = [...hub.connections.values()][0];
      if (sess && sess.subscriptions.has("sub_resume")) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    // Live delivery for a newer row lands while replay is still awaiting.
    await hub.notifyCommittedEvents(TENANT.projectId, [
      outboxEvent(12, "Live 12"),
    ]);

    releaseReplay([outboxEvent(10, "Replay 10"), outboxEvent(11, "Replay 11")]);
    await subscribePromise;

    const mutations = receivedFrames.filter(
      (f): f is Extract<ServerFrame, { type: "mutation" }> => f.type === "mutation"
    );
    expect(mutations.map((m) => m.seqId)).toEqual([10, 11, 12]);
    expect(mutations.map((m) => m.document.data["title"])).toEqual([
      "Replay 10",
      "Replay 11",
      "Live 12",
    ]);

    const completionIndex = receivedFrames.findIndex((f) => f.type === "resume_complete");
    expect(completionIndex).toBeGreaterThan(1);
    expect(receivedFrames[completionIndex]).toMatchObject({
      type: "resume_complete",
      subId: "sub_resume",
      seqId: "11",
      count: 2,
      truncated: false,
    });
    // The replay boundary is announced before the deferred live event.
    expect(receivedFrames[completionIndex + 1]).toMatchObject({ type: "mutation", seqId: 12 });
  });

  it("enforces slow consumer disconnect on outbound buffer overflow", async () => {
    const receivedFrames: ServerFrame[] = [];
    const session = hub.createConnectionSession((frame) => {
      receivedFrames.push(frame);
    });

    // Set buffer near limit (1 MiB = 1048576)
    session.setSimulatedBackpressureBytes(1048570);

    // Sending a frame exceeds limit
    await session.handleClientFrame({ type: "ping", ts: 99999 });

    expect(receivedFrames).toHaveLength(1);
    expect(receivedFrames[0]?.type).toBe("error");
    if (receivedFrames[0]?.type === "error") {
      expect(receivedFrames[0].code).toBe("SLOW_CONSUMER_DISCONNECT");
    }
  });
});
