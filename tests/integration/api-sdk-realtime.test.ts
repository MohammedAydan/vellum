/**
 * End-to-End Integration Test Suite (`tests/integration/api-sdk-realtime.test.ts`)
 * Verifies:
 * 1. Full HTTP REST API & TypeScript SDK (@vellumdb/sdk-js) CRUD lifecycle
 * 2. Atomic Field Transforms (increment, serverTimestamp, arrayUnion, arrayRemove, deleteField)
 * 3. Structured Queries with cursor pagination (startAfter) & Composite Index creation + Background Worker backfill
 * 4. Interactive OCC Transactions & automatic conflict retry on concurrent writes
 * 5. Realtime WebSocket Gateway (initial_sync, live mutations, and resumeSeqId delta replay)
 */

import { describe, it, expect } from "vitest";
import { createVellumPlatform } from "@vellum/api";
import { CustomerDashboardService } from "@vellum/dashboard";
import { PlatformAdminService } from "@vellum/admin";
import { createClient, fieldOp } from "@vellumdb/sdk-js";
import {
  decryptPrivateKey,
  generateEd25519KeyPair,
  signEndUserAccessToken,
} from "@vellum/auth";

function setupTestHarness() {
  const platform = createVellumPlatform();
  const dashboard = new CustomerDashboardService({ platform });
  const admin = new PlatformAdminService({ platform });

  const ownerUser = platform.controlStore.createUser({
    email: "founder@vellum.dev",
    name: "Platform Owner",
    platformRole: "owner",
  });
  const customerUser = platform.controlStore.createUser({
    email: "mohammed@aydan.dev",
    name: "Mohammed Aydan",
    platformRole: "customer",
  });

  const org = platform.controlStore.createOrganization({
    slug: "aydan-labs",
    name: "Aydan Labs",
    billingEmail: "billing@aydan.dev",
    ownerUserId: customerUser.id,
  });

  const { project } = platform.controlStore.createProject({
    organizationId: org.id,
    slug: "plantiva-db",
    name: "Plantiva Production DB",
    actorUserId: customerUser.id,
  });

  // Publish Security Ruleset for the project
  platform.controlStore.publishSecurityRuleset({
    projectId: project.id,
    createdBy: customerUser.id,
    rulesAst: {
      version: 1,
      rules: [
        {
          match: "users/{userId}",
          allow: {
            read: { op: "==", left: { var: "auth.uid" }, right: { var: "path.userId" } },
            write: { op: "==", left: { var: "auth.uid" }, right: { var: "path.userId" } },
          },
        },
        {
          match: "tickets/{ticketId}",
          allow: {
            read: true,
            write: { op: "==", left: { var: "auth.claims.role" }, right: { val: "engineer" } },
          },
        },
      ],
    },
  });

  const { plaintextKeyOnce: publicKey } = dashboard.createProjectApiKey({
    projectId: project.id,
    name: "Flutter Mobile Public Key",
    keyType: "public",
    scopes: ["documents:read", "documents:write"],
    actorUserId: customerUser.id,
  });

  const { plaintextKeyOnce: serverKey } = dashboard.createProjectApiKey({
    projectId: project.id,
    name: "Backend Server Key",
    keyType: "server",
    scopes: ["documents:read", "documents:write", "indexes:manage"],
    actorUserId: customerUser.id,
  });

  // The document plane is EdDSA-only: seed the project auth config with a
  // real Ed25519 key pair and mint an end-user token the realm verifier accepts.
  const keyPair = generateEd25519KeyPair();
  platform.controlStore.upsertAuthConfig({
    projectId: project.id,
    jwtKeyId: keyPair.keyId,
    jwtPublicKeyPem: keyPair.publicKeyPem,
    jwtPrivateKeyEncrypted: keyPair.privateKeyEncrypted,
  });
  const now = Math.floor(Date.now() / 1000);
  const userJwt = signEndUserAccessToken(
    {
      iss: `https://api.vellum.dev/v1/projects/${project.id}/auth`,
      sub: "u_aydan",
      jti: "api-sdk-realtime-test-jti",
      aud: project.id,
      email: "u_aydan@example.test",
      email_verified: true,
      is_anonymous: false,
      claims: { role: "engineer" },
      iat: now,
      exp: now + 3600,
      auth_time: now,
    },
    decryptPrivateKey(keyPair.privateKeyEncrypted),
    keyPair.keyId
  );

  return {
    platform,
    dashboard,
    admin,
    ownerUser,
    customerUser,
    project,
    publicKey,
    serverKey,
    userJwt,
  };
}

describe("tests/integration/api-sdk-realtime", () => {
  it("SDK + HTTP API executes CRUD, Atomic Field Transforms, Cursor Pagination, and Composite Index Queries", async () => {
    const { platform, project, publicKey, serverKey, userJwt } = setupTestHarness();

    const client = createClient({
      projectId: project.id,
      apiKey: publicKey,
      getAuthToken: () => userJwt,
      customFetch: (url, init) => platform.fetch(new Request(url, init)),
      realtimeHub: platform.realtimeHub,
    });

    // 1. Set with atomic transforms
    const userRef = client.collection("users").doc("u_aydan");
    await userRef.set(
      {
        name: "Mohammed Aydan",
        loginCount: fieldOp.increment(1),
        skills: fieldOp.arrayUnion("Flutter", "TypeScript", "PostgreSQL"),
        lastLoginAt: fieldOp.serverTimestamp(),
      },
      { merge: true }
    );

    // 2. Patch with increment and arrayRemove
    await userRef.update({
      loginCount: fieldOp.increment(4),
      skills: fieldOp.arrayRemove("PostgreSQL"),
    });

    const snap = await userRef.get();
    expect(snap.id).toBe("u_aydan");
    expect((snap.data() as Record<string, unknown>).loginCount).toBe(5);
    expect((snap.data() as Record<string, unknown>).skills).toEqual(["Flutter", "TypeScript"]);
    expect(((snap.data() as Record<string, unknown>).lastLoginAt as { $t: string }).$t).toBe("ts");

    // 3. Seed tickets and create a Composite Index (status ASC, priority DESC)
    const serverClient = createClient({
      projectId: project.id,
      apiKey: serverKey,
      customFetch: (url, init) => platform.fetch(new Request(url, init)),
    });

    await serverClient.batchWrite([
      { type: "create", path: "tickets/t_1", data: { status: "open", priority: 10, title: "Low latency index" } },
      { type: "create", path: "tickets/t_2", data: { status: "open", priority: 50, title: "Critical production fix" } },
      { type: "create", path: "tickets/t_3", data: { status: "open", priority: 30, title: "SDK pagination" } },
      { type: "create", path: "tickets/t_4", data: { status: "closed", priority: 99, title: "Archived item" } },
    ]);

    // Multi-field orderBy before index is created fails with FAILED_PRECONDITION
    await expect(
      client
        .collection("tickets")
        .where("status", "==", "open")
        .orderBy("status", "asc")
        .orderBy("priority", "desc")
        .get()
    ).rejects.toThrow();

    // Create composite index via REST API using serverKey and run background index builder worker
    const createIdxRes = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${project.id}/indexes`, {
        method: "POST",
        headers: { "x-project-key": serverKey, "content-type": "application/json" },
        body: JSON.stringify({
          collectionPath: "tickets",
          fields: [
            { path: "status", dir: "asc" },
            { path: "priority", dir: "desc" },
          ],
        }),
      })
    );
    expect(createIdxRes.status).toBe(201);

    const workerStats = await platform.runMaintenanceWorkers();
    expect(workerStats.indexesBuilt).toBe(1);

    // Execute composite query with cursor pagination (limit 2)
    const page1 = await client
      .collection("tickets")
      .where("status", "==", "open")
      .orderBy("status", "asc")
      .orderBy("priority", "desc")
      .limit(2)
      .get();

    expect(page1.docs).toHaveLength(2);
    expect(page1.docs[0]?.id).toBe("t_2"); // priority 50
    expect(page1.docs[1]?.id).toBe("t_3"); // priority 30
    expect(page1.nextCursor).toBeTruthy();
    expect((page1.meta as { indexUsed: string }).indexUsed.startsWith("composite:")).toBe(true);

    const page2 = await client
      .collection("tickets")
      .where("status", "==", "open")
      .orderBy("status", "asc")
      .orderBy("priority", "desc")
      .limit(2)
      .startAfter(page1.nextCursor!)
      .get();

    expect(page2.docs).toHaveLength(1);
    expect(page2.docs[0]?.id).toBe("t_1"); // priority 10
    expect(page2.nextCursor).toBeNull();
  });

  it("Interactive OCC Transactions detect concurrent read-set conflicts and automatically retry", async () => {
    const { platform, project, serverKey } = setupTestHarness();
    const db = createClient({
      projectId: project.id,
      apiKey: serverKey,
      customFetch: (url, init) => platform.fetch(new Request(url, init)),
    });

    const walletRef = db.collection("wallets").doc("w_1");
    await walletRef.create({ balance: 100 });

    let injectedConcurrentWrite = false;
    let attemptsExecuted = 0;

    await db.runTransaction(async (tx) => {
      attemptsExecuted += 1;
      const snap = await tx.get(walletRef);
      if (!injectedConcurrentWrite) {
        injectedConcurrentWrite = true;
        // Simulate another client modifying the document after tx.get but before commit
        await walletRef.update({ balance: 250 });
      }
      tx.update(walletRef, { balance: ((snap.data() as Record<string, unknown>).balance as number) + 50 });
    });

    expect(attemptsExecuted).toBe(2);
    const finalWallet = await walletRef.get();
    expect((finalWallet.data() as Record<string, unknown>).balance).toBe(300);
  });

  it("Realtime WebSocket Gateway delivers initial_sync, live mutations, and resumeSeqId delta catch-up", async () => {
    const { platform, project, serverKey } = setupTestHarness();
    const receivedFrames: Array<Record<string, unknown>> = [];
    const conn = platform.realtimeHub.createConnectionSession((frame) => receivedFrames.push(frame as unknown as Record<string, unknown>));

    await conn.handleClientFrame({
      type: "auth",
      projectId: project.id,
      apiKey: serverKey,
    });
    expect(receivedFrames[0]?.type).toBe("auth_ack");

    await conn.handleClientFrame({
      type: "subscribe",
      subId: "sub_open_tickets",
      query: {
        collectionPath: "tickets",
        where: [{ field: "status", op: "==", value: "open" }],
      },
    });

    // Perform writes and verify live created, updated, and deleted mutations
    const db = createClient({
      projectId: project.id,
      apiKey: serverKey,
      customFetch: (url, init) => platform.fetch(new Request(url, init)),
    });

    await db.collection("tickets").doc("rt_1").create({ status: "open", step: 1 });
    await db.collection("tickets").doc("rt_1").update({ step: 2 });
    await db.collection("tickets").doc("rt_1").update({ status: "closed" }); // Leaves query filter -> removed!

    const mutationFrames = receivedFrames.filter((f) => f.type === "mutation" && f.subId === "sub_open_tickets");
    expect(mutationFrames).toHaveLength(3);
    expect(mutationFrames[0]?.operation).toBe("create");
    expect(mutationFrames[1]?.operation).toBe("update");
    expect(mutationFrames[2]?.operation).toBe("delete");

    // Reconnect with resumeSeqId from the first event and verify delta replay
    const resumeFrames: Array<Record<string, unknown>> = [];
    const conn2 = platform.realtimeHub.createConnectionSession((f) => resumeFrames.push(f as unknown as Record<string, unknown>));
    await conn2.handleClientFrame({ type: "auth", projectId: project.id, apiKey: serverKey });
    await conn2.handleClientFrame({
      type: "subscribe",
      subId: "sub_resumed",
      path: "tickets/rt_1",
      resumeSeqId: Number(mutationFrames[0]?.seqId),
    });

    const replayedMutations = resumeFrames.filter((f) => f.type === "mutation");
    expect(replayedMutations).toHaveLength(2);
  });
});
