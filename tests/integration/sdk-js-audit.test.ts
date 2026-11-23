import { describe, expect, it } from "vitest";
import { createClient } from "../../packages/sdk-js/src/index.js";
import { createVellumPlatform } from "../../apps/api/src/index.js";
import { startNodeApiServer } from "../../apps/api/src/node-server.js";
import { CustomerDashboardService } from "../../apps/dashboard/src/index.js";

async function harness() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({ slug: "sdk-audit", name: "SDK Audit", billingEmail: "test@example.test" });
  const { project } = await platform.controlStore.createProject({ organizationId: org.id, slug: "sdk-audit", name: "SDK Audit" });
  const dashboard = new CustomerDashboardService({ platform });
  const { plaintextKeyOnce: publicKey } = dashboard.createProjectApiKey({ projectId: project.id, name: "Public", keyType: "public", scopes: ["documents:read", "documents:write"] });
  await platform.controlStore.publishSecurityRuleset({ projectId: project.id, rulesAst: { version: 1, rules: [{ match: "private/{doc}", allow: { read: { op: "==", left: { var: "auth.uid" }, right: { var: "resource.data.owner" } }, write: { op: "!=", left: { var: "auth.uid" }, right: { val: null } } } }] } });
  const server = await startNodeApiServer({ port: 0, platform });
  const db = createClient({ endpoint: `http://127.0.0.1:${server.port}`, projectId: project.id, apiKey: publicKey, cache: { enabled: true }, dedupeReads: true });
  return { db, platform, project, server };
}

describe("SDK project isolation against real application", () => {
  it("never returns A's cached document after switching to B", async () => {
    const { db, server } = await harness();
    try {
      const a = await db.signUpWithEmailAndPassword("a@example.test", "Str0ng!Passw0rd", { displayName: "User A" });
      const ref = db.doc("private/shared");
      await ref.set({ owner: a.id, content: "A only" });
      expect((await ref.get()).data()).toMatchObject({ content: "A only" });
      await db.signOut();
      await db.signUpWithEmailAndPassword("b@example.test", "Str0ng!Passw0rd", { displayName: "User B" });
      await expect(ref.get({ bypassCache: true })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(ref.get()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    } finally { db.dispose(); await server.stop(); }
  });

  it("sends a valid JSON body when clearing a collection", async () => {
    const { db: publicDb, platform, project, server } = await harness();
    const dashboard = new CustomerDashboardService({ platform });
    const { plaintextKeyOnce: apiKey } = dashboard.createProjectApiKey({ projectId: project.id, name: "Server", keyType: "server", scopes: ["documents:read", "documents:write"] });
    const db = createClient({ endpoint: `http://127.0.0.1:${server.port}`, projectId: project.id, apiKey });
    try {
      await db.doc("items/one").set({ value: 1 });
      await expect(db.collection("items").clear()).resolves.toMatchObject({ deletedCount: 1 });
    } finally { publicDb.dispose(); db.dispose(); await server.stop(); }
  });
});
