import { afterEach, describe, expect, it } from "vitest";
import { createVellumPlatform } from "../index.js";

const platforms: ReturnType<typeof createVellumPlatform>[] = [];
afterEach(() => {
  for (const p of platforms.splice(0)) p.metering.stop();
});

async function fixture() {
  const p = createVellumPlatform();
  platforms.push(p);
  const org = await p.controlStore.createOrganization({
    name: "Batch",
    slug: `batch-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    planId: "pro",
    billingEmail: "test@example.test",
  });
  const { project } = await p.controlStore.createProject({ organizationId: org.id, name: "Batch", slug: "batch" });
  const keyRes = await p.fetch(
    new Request(`http://localhost/v1/projects/${project.id}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "secret", keyType: "secret" }),
    })
  );
  const { rawKey } = (await keyRes.json()) as { rawKey: string };
  const post = (path: string, body: unknown, method = "POST") =>
    p.fetch(
      new Request(`http://localhost/v1/projects/${project.id}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-project-key": rawKey },
        body: JSON.stringify(body),
      })
    );
  const batch = (writes: unknown[]) =>
    p.fetch(
      new Request(`http://localhost/v1/projects/${project.id}/batchWrite`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-project-key": rawKey },
        body: JSON.stringify({ writes }),
      })
    );
  return { batch, post };
}

const op = (i: number, fields: number) => ({
  type: "set",
  path: `items/i${i}`,
  data: Object.fromEntries(Array.from({ length: fields }, (_, k) => [`f${k}`, k])),
});

describe("batch bodies get a per-document key budget", () => {
  it("accepts a full batch of 100 ordinary documents (was 'Total object keys exceed 500')", async () => {
    const { batch } = await fixture();
    const res = await batch(Array.from({ length: 100 }, (_, i) => op(i, 8)));
    expect(res.status).toBeLessThan(300);
  });

  it("still rejects one document that has too many keys", async () => {
    const { batch } = await fixture();
    const res = await batch([op(0, 600), op(1, 1)]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("object keys");
  });

  it("still rejects a single-write body over the budget", async () => {
    const { batch } = await fixture();
    const res = await batch([op(0, 600)]);
    expect(res.status).toBe(400);
  });

  it("accepts a full batch sent as `operations`", async () => {
    const { post } = await fixture();
    const res = await post("/batchWrite", { operations: Array.from({ length: 100 }, (_, i) => op(i, 8)) });
    expect(res.status).toBeLessThan(300);
  });

  it("does not let a fake `writes` array lift the key cap on other routes", async () => {
    const { post } = await fixture();
    const junk = Object.fromEntries(Array.from({ length: 800 }, (_, k) => [`j${k}`, k]));
    const res = await post("/documents/items/x", { data: junk, writes: [{}, {}, {}, {}] }, "PUT");
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("object keys");
  });

  it("counts junk next to the writes of a batch against the original cap", async () => {
    const { post } = await fixture();
    const junk = Object.fromEntries(Array.from({ length: 800 }, (_, k) => [`j${k}`, k]));
    const res = await post("/batchWrite", { writes: [op(0, 1), op(1, 1)], ...junk });
    expect(res.status).toBe(400);
  });
});
