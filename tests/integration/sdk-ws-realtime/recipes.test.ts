/**
 * Track E recipes over a real RFC 6455 server and the real JS SDK (in-memory data plane):
 * Recipe 2 (missing-document lifecycle, JS), 3C (forced-disconnect soak), 4.2 (1,000-sub fan-out over
 * pooled sockets) and the same-identity token refresh (no spurious "Authentication session changed").
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVellumPlatform } from "../../../apps/api/src/index.js";
import { attachRealtimeWebSocketServer } from "../../../apps/api/src/ws-rfc6455.js";
import { CustomerDashboardService } from "../../../apps/dashboard/src/index.js";
import { createClient } from "../../../packages/sdk-js/src/index.js";
import type { DocumentSnapshot, RealtimeSnapshot } from "../../../packages/sdk-js/src/index.js";
import { compileRulesDsl } from "@vellum/authorization";
import { decryptPrivateKey, generateEd25519KeyPair, signEndUserAccessToken } from "@vellum/auth";

const RULES = `rules_version = '2';
match /chats/{c}/messages/{m} {
  allow get: if request.auth != null && request.auth.uid in resource.data.memberIds;
  allow list: if request.auth != null;
  allow write: if false;
}
match /soak/{d} { allow read: if true; allow write: if false; }
match /idle/{d} { allow read: if true; allow write: if false; }
match /fan/{d} { allow read: if true; allow write: if false; }`;

let httpServer: http.Server;
let port = 0;
let platform: ReturnType<typeof createVellumPlatform>;
let projectId = "";
let serverKey = "";
let publicKey = "";
const sockets = new Set<Socket>();
let tokenFor: (uid: string, jti?: string) => string;

const drop = () => { for (const s of sockets) s.destroy(); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor ${label} timed out after ${timeoutMs}ms`);
    await wait(10);
  }
}

beforeAll(async () => {
  platform = createVellumPlatform();
  const dashboard = new CustomerDashboardService({ platform });
  const user = platform.controlStore.createUser({ email: "rec@vellum.dev", name: "Rec", platformRole: "customer" });
  const org = platform.controlStore.createOrganization({ slug: "rec-org", name: "Rec", billingEmail: "rec@vellum.dev", ownerUserId: user.id });
  const { project } = platform.controlStore.createProject({ organizationId: org.id, slug: "rec-proj", name: "Rec", actorUserId: user.id });
  projectId = project.id;
  platform.controlStore.publishSecurityRuleset({
    projectId, createdBy: user.id, rulesAst: compileRulesDsl(RULES).ast as unknown as Record<string, unknown>,
  });
  serverKey = dashboard.createProjectApiKey({ projectId, name: "srv", keyType: "server", scopes: ["documents:read", "documents:write"], actorUserId: user.id }).plaintextKeyOnce;
  publicKey = dashboard.createProjectApiKey({ projectId, name: "pub", keyType: "public", scopes: ["documents:read", "documents:write"], actorUserId: user.id }).plaintextKeyOnce;
  const keyPair = generateEd25519KeyPair();
  platform.controlStore.upsertAuthConfig({
    projectId, jwtKeyId: keyPair.keyId, jwtPublicKeyPem: keyPair.publicKeyPem, jwtPrivateKeyEncrypted: keyPair.privateKeyEncrypted,
  });
  tokenFor = (uid, jti = `jti-${uid}-${Math.random()}`) => {
    const now = Math.floor(Date.now() / 1000);
    return signEndUserAccessToken(
      { iss: `https://api.vellum.dev/v1/projects/${projectId}/auth`, sub: uid, jti, aud: projectId, email: `${uid}@example.test`,
        email_verified: true, is_anonymous: false, claims: {}, iat: now, exp: now + 3600, auth_time: now },
      decryptPrivateKey(keyPair.privateKeyEncrypted), keyPair.keyId
    );
  };
  httpServer = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  httpServer.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  attachRealtimeWebSocketServer(httpServer, platform.realtimeHub, { maxConnectionsPerIp: 200 });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  drop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  platform.metering.stop();
});

function makeClient(apiKey: string, getAuthToken?: () => string | null, extra: Record<string, unknown> = {}) {
  return createClient({
    projectId, apiKey,
    endpoint: `http://127.0.0.1:${port}`,
    customFetch: (url, init) => platform.fetch(new Request(url, init)),
    realtimeTransport: "websocket",
    realtimeTransportOptions: { heartbeatIntervalMs: 60_000, connectTimeoutMs: 5000, randomFn: () => 0, ...(extra["transport"] as object | undefined) },
    ...(getAuthToken ? { getAuthToken } : {}),
  });
}

describe("Recipe 2 (JS): missing-document doc.onSnapshot lifecycle under member-scoped get rules", () => {
  it("case A: an unauthenticated caller is denied", async () => {
    const anon = makeClient(publicKey);
    const errors: unknown[] = [];
    const snaps: DocumentSnapshot[] = [];
    const off = anon.collection("chats/c1/messages").doc("does_not_exist").onSnapshot((s) => snaps.push(s), (e) => errors.push(e));
    await waitFor(() => errors.length > 0, 8000, "anon error");
    expect((errors[0] as { code?: string }).code).toBe("PERMISSION_DENIED");
    expect(snaps).toHaveLength(0);
    off();
    anon.dispose();
  }, 15_000);

  it("case B: exists:false first, no outsider leak, then v1 once, v2, then exists:false on delete", async () => {
    const alice = makeClient(publicKey, () => tokenFor("alice"));
    const srv = makeClient(serverKey);
    const errors: unknown[] = [];

    // Outsider create must not reach Alice.
    const leakSnaps: DocumentSnapshot[] = [];
    const offLeak = alice.collection("chats/c1/messages").doc("missing_life_1").onSnapshot((s) => leakSnaps.push(s), (e) => errors.push(e));
    await waitFor(() => leakSnaps.length > 0, 8000, "first snapshot");
    expect(leakSnaps[0]!.exists).toBe(false);
    await srv.collection("chats/c1/messages").doc("missing_life_1").create({ memberIds: ["bob"], text: "secret" });
    await wait(600);
    expect(leakSnaps.filter((s) => s.exists)).toHaveLength(0);
    offLeak();

    // Authorized create, update, delete.
    const snaps: DocumentSnapshot[] = [];
    const ref = alice.collection("chats/c1/messages").doc("missing_life_2");
    const off = ref.onSnapshot((s) => snaps.push(s), (e) => errors.push(e));
    await waitFor(() => snaps.length > 0, 8000, "missing_life_2 first");
    expect(snaps[0]!.exists).toBe(false);
    await srv.collection("chats/c1/messages").doc("missing_life_2").create({ memberIds: ["alice"], text: "hi" });
    await waitFor(() => snaps.some((s) => s.exists && s.version === 1), 8000, "v1");
    await srv.collection("chats/c1/messages").doc("missing_life_2").update({ text: "hi2" });
    await waitFor(() => snaps.some((s) => s.exists && s.version === 2), 8000, "v2");
    await srv.collection("chats/c1/messages").doc("missing_life_2").delete();
    await waitFor(() => snaps.at(-1)!.exists === false && snaps.length >= 4, 8000, "deleted");
    expect(snaps.filter((s) => s.exists && s.version === 1)).toHaveLength(1);
    expect(errors).toHaveLength(0);
    off();
    alice.dispose();
    srv.dispose();
  }, 30_000);

  it("a document that expires by TTL ends with exists:false and no error", async () => {
    const alice = makeClient(publicKey, () => tokenFor("alice"));
    const srv = makeClient(serverKey);
    const errors: unknown[] = [];
    const snaps: DocumentSnapshot[] = [];
    await srv.collection("chats/c1/messages").doc("ttl_life").create({ memberIds: ["alice"] }, { ttlSeconds: 2 });
    const off = alice.collection("chats/c1/messages").doc("ttl_life").onSnapshot((s) => snaps.push(s), (e) => errors.push(e));
    await waitFor(() => snaps.some((s) => s.exists), 8000, "exists");
    await waitFor(() => snaps.at(-1)!.exists === false, 10_000, "ttl exists:false");
    expect(errors).toHaveLength(0);
    off();
    alice.dispose();
    srv.dispose();
  }, 30_000);
});

describe("same-identity token refresh keeps subscriptions alive", () => {
  it("refreshing Alice's token does not emit SESSION_CHANGED; switching to Bob does", async () => {
    let token = tokenFor("alice", "a1");
    const alice = makeClient(publicKey, () => token);
    const srv = makeClient(serverKey);
    const errors: Array<{ code?: string }> = [];
    const snaps: DocumentSnapshot[] = [];
    await srv.collection("chats/c1/messages").doc("refresh_doc").create({ memberIds: ["alice"], n: 0 });
    const off = alice.collection("chats/c1/messages").doc("refresh_doc").onSnapshot((s) => snaps.push(s), (e) => errors.push(e as { code?: string }));
    await waitFor(() => snaps.some((s) => s.exists), 8000, "initial");
    alice.auth.setCustomToken(tokenFor("alice", "a2"));
    await wait(300);
    await srv.collection("chats/c1/messages").doc("refresh_doc").update({ n: 1 });
    await waitFor(() => snaps.some((s) => s.exists && s.version === 2), 8000, "update after refresh");
    expect(errors).toHaveLength(0);
    alice.auth.setCustomToken(tokenFor("bob", "b1"));
    await waitFor(() => errors.length > 0, 5000, "identity switch error");
    expect(errors[0]!.code).toBe("SESSION_CHANGED");
    void token; token = "";
    off();
    alice.dispose();
    srv.dispose();
  }, 30_000);
});

describe("Recipe 3C: forced disconnects under write load", () => {
  it("100/100 messages in strict order, no duplicates, across 3 server-side drops", async () => {
    const srv = makeClient(serverKey);
    const reader = makeClient(serverKey);
    const seen: number[] = [];
    const off = reader.collection("soak").onSnapshot((snap: RealtimeSnapshot) => {
      for (const c of snap.changes) {
        if (c.type !== "removed") seen.push(Number((c.doc.data() as { n: number }).n));
      }
    });
    await wait(300);
    for (let i = 0; i < 100; i += 1) {
      await srv.collection("soak").doc(`m${String(i).padStart(3, "0")}`).create({ n: i });
      if (i === 25 || i === 50 || i === 75) drop();
      await wait(40);
    }
    await waitFor(() => new Set(seen).size >= 100, 20_000, "100 delivered");
    expect([...new Set(seen)].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(seen).toHaveLength(100); // no duplicates
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // strict order
    off();
    reader.dispose();
    srv.dispose();
  }, 60_000);
});

describe("Recipe 4.2: 1,000 subscriptions over pooled sockets", () => {
  it("delivers 1,000/1,000 events on 40 sockets of 25 subscriptions", async () => {
    const reader = makeClient(serverKey, undefined, { transport: { maxSockets: 40 } });
    const srv = makeClient(serverKey);
    const got = new Set<number>();
    const offs: Array<() => void> = [];
    for (let i = 0; i < 1000; i += 1) {
      offs.push(reader.collection("fan").doc(`d${i}`).onSnapshot((s) => { if (s.exists) got.add(i); }));
    }
    await waitFor(() => sockets.size >= 40, 30_000, "40 sockets");
    await wait(1500);
    expect(sockets.size).toBeLessThanOrEqual(40);
    // The server key is limited to 100 requests/sec: write in slices of 80 per second.
    for (let from = 0; from < 1000; from += 80) {
      await Promise.all(Array.from({ length: Math.min(80, 1000 - from) }, (_, k) => srv.collection("fan").doc(`d${from + k}`).create({ i: from + k })));
      await wait(1050);
    }
    const started = Date.now();
    await waitFor(() => got.size === 1000, 30_000, "1000 delivered");
    expect(Date.now() - started).toBeLessThan(30_000);
    offs.forEach((f) => f());
    reader.dispose();
    srv.dispose();
  }, 180_000);
});

describe("Recipe 3A: idle-to-write latency (WS and SSE)", () => {
  for (const transport of ["websocket", "sse"] as const) {
    it(`${transport}: first write after 46s idle arrives in < 2s, then alternating A<->B writes with idle gaps, 0 stalls > 3s`, async () => {
      const mk = () => createClient({
        projectId, apiKey: serverKey,
        endpoint: transport === "sse" ? "http://127.0.0.1:9" : `http://127.0.0.1:${port}`,
        customFetch: (url, init) => platform.fetch(new Request(url, init)),
        realtimeTransport: transport,
        realtimeTransportOptions: { heartbeatIntervalMs: 15_000, connectTimeoutMs: 5000 },
      });
      const a = mk();
      const b = mk();
      const writer = mk();
      const col = `idle`;
      const seenA = new Map<string, number>();
      const seenB = new Map<string, number>();
      const offA = a.collection(col).onSnapshot((snap: RealtimeSnapshot) => { for (const c of snap.changes) if (c.type !== "removed") seenA.set(c.doc.id, Date.now()); });
      const offB = b.collection(col).onSnapshot((snap: RealtimeSnapshot) => { for (const c of snap.changes) if (c.type !== "removed") seenB.set(c.doc.id, Date.now()); });
      await wait(1000);
      await wait(46_000); // idle: keepalives only
      const prefix = `${transport}_`;
      const latencies: number[] = [];
      const send = async (id: string, target: Map<string, number>) => {
        const t0 = Date.now();
        await writer.collection(col).doc(prefix + id).create({ id });
        await waitFor(() => target.has(prefix + id), 10_000, `delivery of ${id}`);
        latencies.push(target.get(prefix + id)! - t0);
      };
      await send("first", seenB);
      expect(latencies[0]!).toBeLessThan(2000);
      for (let i = 0; i < 9; i += 1) {
        await wait(1500 + (i % 3) * 1000);
        await send(`m${i}`, i % 2 === 0 ? seenA : seenB);
      }
      expect(latencies).toHaveLength(10);
      expect(Math.max(...latencies)).toBeLessThan(3000);
      offA(); offB();
      a.dispose(); b.dispose(); writer.dispose();
    }, 120_000);
  }
});
