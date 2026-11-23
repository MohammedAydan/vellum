import { describe, expect, it } from "vitest";
import { generateProjectApiKey } from "@vellum/authorization";
import { createVellumPlatform } from "../../index.js";

/**
 * Regression: document writes whose body is not a JSON object (a bare string,
 * array, or number) must be rejected with 400 INVALID_ARGUMENT. The routes
 * used to resolve data as `body.data ?? body`, so a bare string body was
 * persisted as a character-keyed object ({"0":"j","1":"u",...}), silently
 * corrupting the document.
 */
async function fixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({
    name: "Shape Org",
    slug: "shape-org",
    billingEmail: "ops@example.com",
  });
  const { project } = await platform.controlStore.createProject({
    organizationId: org.id,
    name: "Shape App",
    slug: "shape-app",
  });
  const key = generateProjectApiKey({ keyType: "server" });
  await platform.controlStore.registerApiKey({
    projectId: project.id,
    name: "server key",
    keyType: "server",
    keyPrefix: key.keyPrefix,
    secretHash: key.secretHash,
  });
  const write = (method: string, path: string, rawBody: string) =>
    platform.fetch(
      new Request(`http://localhost/v1/projects/${project.id}/documents/${path}`, {
        method,
        headers: { "content-type": "application/json", "x-vellum-api-key": key.fullKey },
        body: rawBody,
      })
    );
  return { platform, write };
}

describe("document data shape validation", () => {
  it("rejects bare string, array and number bodies on create/set/update", async () => {
    const { write } = await fixture();
    for (const [method, path, raw] of [
      ["PUT", "fuzz/tc", '"just a string"'],
      ["PUT", "fuzz/tc2", "[1,2,3]"],
      ["PUT", "fuzz/tc3", "42"],
      ["POST", "fuzz/tc4", '"bare"'],
      ["PATCH", "fuzz/tc5", "[0]"],
    ] as const) {
      const res = await write(method, path, raw);
      expect(res.status, `${method} ${path}`).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("INVALID_ARGUMENT");
    }
  });

  it("still accepts an object body and the {data:{...}} envelope", async () => {
    const { write } = await fixture();
    const plain = await write("PUT", "fuzz/ok1", JSON.stringify({ a: 1 }));
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { data?: unknown }).data).toEqual({ a: 1 });
    const enveloped = await write("PUT", "fuzz/ok2", JSON.stringify({ data: { b: 2 } }));
    expect(enveloped.status).toBe(200);
    expect(((await enveloped.json()) as { data?: unknown }).data).toEqual({ b: 2 });
  });
});
