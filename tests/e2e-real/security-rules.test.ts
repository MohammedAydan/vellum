/**
 * Real Backend E2E Test - Declarative Security Rules AST Evaluation
 * Validates against real Node.js HTTP server and real Neon PostgreSQL:
 * 1. Rule `auth.uid == path.userId`: matching JWT allows 200, mismatched JWT rejects 403
 * 2. Unauthenticated request with public key rejected 403
 * 3. Rule with `request.data`: authorId matching auth.uid allows write, mismatch rejects 403
 * 4. Rule with `resource.data`: owner update allows 200, non-owner update rejects 403
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { startNodeApiServer } from "../../apps/api/src/node-server.js";
import { createRawPgClient, loadEnvFiles } from "../../packages/database-control/src/index.js";
import { withTenantData } from "./tenant-data-sql.js";
import {
  decryptPrivateKey,
  generateEd25519KeyPair,
  signEndUserAccessToken,
  type Ed25519KeyPair,
} from "../../packages/auth/src/index.js";

let signingKeyPair: Ed25519KeyPair | null = null;

/** Mint a canonical EdDSA end-user JWT for this project. */
function signForServer(uid: string): string {
  if (!signingKeyPair) throw new Error("Signing key pair is not initialized");
  const now = Math.floor(Date.now() / 1000);
  return signEndUserAccessToken(
    {
      iss: `https://api.vellum.dev/v1/projects/${projectId}/auth`,
      sub: uid,
      aud: projectId,
      email: `${uid}@example.com`,
      email_verified: true,
      is_anonymous: false,
      claims: {},
      jti: `sec-rules-${uid}-${now}`,
      iat: now,
      exp: now + 3600,
      auth_time: now,
    },
    decryptPrivateKey(signingKeyPair.privateKeyEncrypted),
    signingKeyPair.keyId
  );
}

process.env.PHASE5_REAL = "1";

const prefix = `sec_${Date.now()}_`;
let server: Awaited<ReturnType<typeof startNodeApiServer>>;
let baseUrl = "";
let projectId = "";
let organizationId = "";
let serverKey = "";
let publicKey = "";
let dataClient: Awaited<ReturnType<typeof createRawPgClient>>;
let controlClient: Awaited<ReturnType<typeof createRawPgClient>>;

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(url, init);
  return { status: response.status, body: (await response.json()) as T, headers: response.headers };
}

describe("Real Security Rules AST against Real HTTP + Neon PostgreSQL", () => {
  beforeAll(async () => {
    loadEnvFiles([path.resolve(".env.phase5.local"), path.resolve(".env")]);
    server = await startNodeApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;

    // 1. Provision organization and project
    const org = await json<{ id: string }>(`${baseUrl}/v1/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Security Rules Org", slug: `${prefix}org`.replace(/_/g, "-"), planTier: "pro" }),
    });
    expect(org.status).toBe(201);
    organizationId = org.body.id;

    const project = await json<{ project: { id: string } }>(`${baseUrl}/v1/organizations/${org.body.id}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Security Rules Project", slug: `${prefix}proj`.replace(/_/g, "-") }),
    });
    expect(project.status).toBe(201);
    projectId = project.body.project.id;

    // 2. Issue a server key (for setup) and a public key (for rules enforcement)
    const serverKeyRes = await json<{ rawKey: string }>(`${baseUrl}/v1/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Server Key", keyType: "secret" }),
    });
    expect(serverKeyRes.status).toBe(201);
    serverKey = serverKeyRes.body.rawKey;

    const publicKeyRes = await json<{ rawKey: string }>(`${baseUrl}/v1/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Public Key", keyType: "publishable" }),
    });
    expect(publicKeyRes.status).toBe(201);
    publicKey = publicKeyRes.body.rawKey;
    expect(publicKey.startsWith("pk_")).toBe(true);

    // 3. Publish active Security Ruleset AST to control plane
    const rulesAst = {
      version: 1,
      rules: [
        {
          match: `${prefix}users/{userId}`,
          allow: {
            read: {
              op: "==",
              left: { var: "auth.uid" },
              right: { var: "path.userId" },
            },
            write: {
              op: "==",
              left: { var: "auth.uid" },
              right: { var: "path.userId" },
            },
          },
        },
        {
          match: `${prefix}posts/{postId}`,
          allow: {
            create: {
              op: "==",
              left: { var: "request.data.authorId" },
              right: { var: "auth.uid" },
            },
            get: true,
            update: {
              op: "all",
              conditions: [
                {
                  op: "==",
                  left: { var: "resource.data.authorId" },
                  right: { var: "auth.uid" },
                },
                {
                  op: "==",
                  left: { var: "request.data.authorId" },
                  right: { var: "resource.data.authorId" },
                },
              ],
            },
            delete: {
              op: "==",
              left: { var: "resource.data.authorId" },
              right: { var: "auth.uid" },
            },
          },
        },
      ],
    };

    const rulesetRes = await json<{ id: string; version: number }>(
      `${baseUrl}/v1/projects/${projectId}/rulesets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rulesAst }),
      }
    );
    expect(rulesetRes.status).toBe(201);
    expect(rulesetRes.body.version).toBe(1);

    controlClient = createRawPgClient({
      connectionString: process.env.CONTROL_DATABASE_URL_DIRECT || process.env.CONTROL_DATABASE_URL || "",
      applicationName: "vellum-e2e-sec-control",
    });
    dataClient = createRawPgClient({
      connectionString: process.env.DATA_DATABASE_URL_DIRECT || process.env.DATA_DATABASE_URL || "",
      applicationName: "vellum-e2e-sec-data",
    });
    await controlClient.connect();
    await dataClient.connect();

    // The document plane is EdDSA-only: provision the project's signing key
    // in control_db so both the API verifier and this test use the same Ed25519 pair.
    signingKeyPair = generateEd25519KeyPair();
    await controlClient.query(
      `INSERT INTO project_auth_configs (
         project_id, jwt_key_id, jwt_public_key_pem, jwt_private_key_encrypted
       ) VALUES ($1::uuid, $2, $3, $4)
       ON CONFLICT (project_id) DO UPDATE SET
         jwt_key_id=EXCLUDED.jwt_key_id,
         jwt_public_key_pem=EXCLUDED.jwt_public_key_pem,
         jwt_private_key_encrypted=EXCLUDED.jwt_private_key_encrypted,
         updated_at=now()`,
      [projectId, signingKeyPair.keyId, signingKeyPair.publicKeyPem, signingKeyPair.privateKeyEncrypted]
    );
    // The API keeps a hydrated control-plane mirror; refresh it so the new
    // auth config (and its public key) is visible to the document plane.
    await server.platform.controlStore.refresh?.();
  }, 30_000);

  afterAll(async () => {
    if (dataClient) {
      await withTenantData(dataClient, projectId, async (tx) => {
        await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM realtime_outbox WHERE project_id = $1::uuid", [projectId]);
      });
      await dataClient.end();
    }
    if (controlClient) {
      if (projectId) {
        await controlClient.query("DELETE FROM audit_logs WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM api_keys WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM security_rulesets WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM project_auth_configs WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
      await controlClient.query("DELETE FROM audit_logs WHERE organization_id = $1", [organizationId]);
      await controlClient.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await controlClient.end();
    }
    if (server) await server.stop();
  }, 30_000);

  it("auth.uid == path.userId: matching JWT allows 200, mismatched JWT rejects 403", async () => {
    const userAlicePath = `${prefix}users/user_alice`;
    const aliceUrl = `${baseUrl}/v1/projects/${projectId}/documents/${userAlicePath}`;

    // Seed document using server key
    const seed = await json(aliceUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-project-key": serverKey },
      body: JSON.stringify({ data: { name: "Alice Wonderland", email: "alice@example.com" } }),
    });
    expect(seed.status).toBe(200);

    const aliceJwt = signForServer("user_alice");
    const bobJwt = signForServer("user_bob");

    // 1. Matching JWT: Alice accesses her own profile -> 200 OK
    const aliceRead = await json<{ data: { name: string } }>(aliceUrl, {
      headers: {
        "x-project-key": publicKey,
        authorization: `Bearer ${aliceJwt}`,
      },
    });
    expect(aliceRead.status).toBe(200);
    expect(aliceRead.body.data.name).toBe("Alice Wonderland");

    // 2. Mismatched JWT: Bob attempts to read Alice's profile -> 403 PERMISSION_DENIED
    const bobRead = await json<{ error: { code: string; message: string } }>(aliceUrl, {
      headers: {
        "x-project-key": publicKey,
        authorization: `Bearer ${bobJwt}`,
      },
    });
    expect(bobRead.status).toBe(403);
    expect(bobRead.body.error.code).toBe("PERMISSION_DENIED");

    // 3. Unauthenticated request with public key -> 403 PERMISSION_DENIED
    const anonRead = await json<{ error: { code: string } }>(aliceUrl, {
      headers: {
        "x-project-key": publicKey,
      },
    });
    expect(anonRead.status).toBe(403);
    expect(anonRead.body.error.code).toBe("PERMISSION_DENIED");
  });

  it("request.data and resource.data rules: validate authorId ownership on create and update", async () => {
    const postPath = `${prefix}posts/post_101`;
    const postUrl = `${baseUrl}/v1/projects/${projectId}/documents/${postPath}`;

    const aliceJwt = signForServer("user_alice");
    const bobJwt = signForServer("user_bob");

    // 1. Create with mismatched request.data (Bob JWT, but tries to set authorId: user_alice) -> 403
    const spoofCreate = await json<{ error: { code: string } }>(postUrl, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-project-key": publicKey,
        authorization: `Bearer ${bobJwt}`,
      },
      body: JSON.stringify({ data: { title: "Spoofed Post", authorId: "user_alice" } }),
    });
    expect(spoofCreate.status).toBe(403);
    expect(spoofCreate.body.error.code).toBe("PERMISSION_DENIED");

    // 2. Create with matching request.data (Alice JWT, authorId: user_alice) -> 200 OK
    const legitCreate = await json<{ version: number }>(postUrl, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-project-key": publicKey,
        authorization: `Bearer ${aliceJwt}`,
      },
      body: JSON.stringify({ data: { title: "Alice First Post", authorId: "user_alice" } }),
    });
    expect(legitCreate.status).toBe(200);
    expect(legitCreate.body.version).toBe(1);

    // 3. Update with mismatched resource.data (Bob tries to update Alice's post) -> 403
    const bobUpdate = await json<{ error: { code: string } }>(postUrl, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-project-key": publicKey,
        authorization: `Bearer ${bobJwt}`,
      },
      body: JSON.stringify({ data: { title: "Defaced Title", authorId: "user_alice" } }),
    });
    expect(bobUpdate.status).toBe(403);
    expect(bobUpdate.body.error.code).toBe("PERMISSION_DENIED");

    // 4. Update with matching resource.data (Alice updates her post) -> 200 OK
    const aliceUpdate = await json<{ version: number }>(postUrl, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-project-key": publicKey,
        authorization: `Bearer ${aliceJwt}`,
      },
      body: JSON.stringify({ data: { title: "Alice Updated Post", authorId: "user_alice" } }),
    });
    expect(aliceUpdate.status).toBe(200);
    expect(aliceUpdate.body.version).toBe(2);

    // 5. Verify document in PostgreSQL reflects Alice's update
    const readBack = await json<{ data: { title: string; authorId: string } }>(postUrl, {
      headers: { "x-project-key": serverKey },
    });
    expect(readBack.status).toBe(200);
    expect(readBack.body.data.title).toBe("Alice Updated Post");
    expect(readBack.body.data.authorId).toBe("user_alice");
  });
});
