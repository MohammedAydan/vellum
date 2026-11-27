import { afterEach, describe, expect, it } from "vitest";
import { createVellumPlatform } from "../index.js";

/**
 * Per-route payload key budgets. The shared 500-key request cap is right for
 * auth/control-plane payloads, but document-plane routes carry user documents
 * and rules routes carry a full rules AST, so each class gets its own budget
 * with an accurate error. Regression coverage for the console Rules Studio
 * "Total object keys in the request exceed 500" failure on /rules/simulate.
 */

const platforms: ReturnType<typeof createVellumPlatform>[] = [];
afterEach(() => {
  for (const p of platforms.splice(0)) p.metering.stop();
});

async function fixture() {
  const p = createVellumPlatform();
  platforms.push(p);
  const org = await p.controlStore.createOrganization({
    name: "Budgets",
    slug: `budgets-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    planId: "pro",
    billingEmail: "test@example.test",
  });
  const { project } = await p.controlStore.createProject({ organizationId: org.id, name: "Budgets", slug: "budgets" });
  const makeKey = async (keyType: string) => {
    const res = await p.fetch(
      new Request(`http://localhost/v1/projects/${project.id}/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: keyType, keyType }),
      })
    );
    const { rawKey } = (await res.json()) as { rawKey: string };
    return rawKey;
  };
  const secret = await makeKey("secret");
  const server = await makeKey("server");
  const post = (path: string, body: unknown, key = secret, method = "POST") =>
    p.fetch(
      new Request(`http://localhost/v1/projects/${project.id}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-project-key": key },
        body: JSON.stringify(body),
      })
    );
  return { post, secret, server };
}

/** A realistic ruleset AST: 200 rules x ~4 keys lands past the old 500-key cap. */
const bigAst = () => ({
  version: 1,
  rules: Array.from({ length: 200 }, (_, i) => ({
    match: `c${i}/{docId}`,
    allow: { read: true, write: false },
  })),
});

const fields = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`f${k}`, k]));

describe("per-route payload key budgets", () => {
  it("simulates a realistic ruleset (console Rules Studio Request panel)", async () => {
    const { post } = await fixture();
    const res = await post("/rules/simulate", {
      rulesAst: bigAst(),
      operation: "get",
      path: "c0/doc1",
      auth: null,
      resourceData: null,
      incomingData: null,
    });
    expect(res.status).toBeLessThan(300);
  });

  it("decompiles a realistic ruleset", async () => {
    const { post } = await fixture();
    const res = await post("/rules/decompile", { rulesAst: bigAst() });
    expect(res.status).toBeLessThan(300);
  });

  it("writes a single document past the old 500-key cap", async () => {
    const { post, secret } = await fixture();
    const res = await post("/documents/items/big", { data: fields(800) }, secret, "PUT");
    expect(res.status).toBeLessThan(300);
  });

  it("rejects a single document past the 10,000-key budget with an accurate message", async () => {
    const { post, secret } = await fixture();
    const res = await post("/documents/items/huge", { data: fields(10_001) }, secret, "PUT");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Split large documents");
  });

  it("imports a collection whose documents total past the old 500-key cap", async () => {
    const { post, server } = await fixture();
    const documents = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, data: fields(10) }));
    const res = await post("/collections/items/import", { documents, mode: "upsert" }, server);
    expect(res.status).toBeLessThan(300);
  });

  it("imports 100 auth users in one request (total past the old 500-key cap)", async () => {
    const { post, server } = await fixture();
    const users = Array.from({ length: 100 }, (_, i) => ({
      email: `user${i}@example.test`,
      emailVerified: false,
      displayName: `User ${i}`,
      photoUrl: null,
    }));
    const res = await post("/auth/admin/users:import", { users }, server);
    expect(res.status).toBeLessThan(300);
  });

  it("keeps the 500-key cap on ordinary request bodies", async () => {
    const { post } = await fixture();
    const res = await post("/query", fields(600));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Total object keys");
  });
});
