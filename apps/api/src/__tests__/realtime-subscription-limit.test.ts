import { afterEach, describe, expect, it } from "vitest";
import { createVellumPlatform } from "../index.js";

const platforms: ReturnType<typeof createVellumPlatform>[] = [];
afterEach(() => {
  for (const p of platforms.splice(0)) p.metering.stop();
});

describe("per-connection subscription limit", () => {
  it("accepts 25 subscriptions and refuses the 26th with SUBSCRIPTION_LIMIT_EXCEEDED", async () => {
    const p = createVellumPlatform();
    platforms.push(p);
    const org = await p.controlStore.createOrganization({ name: "Lim", slug: `lim-${Date.now()}`, planId: "pro", billingEmail: "t@example.test" });
    const { project } = await p.controlStore.createProject({ organizationId: org.id, name: "Lim", slug: "lim" });
    const keyRes = await p.fetch(new Request(`http://localhost/v1/projects/${project.id}/api-keys`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "secret", keyType: "secret" }),
    }));
    const { rawKey } = (await keyRes.json()) as { rawKey: string };
    const frames: Array<Record<string, unknown>> = [];
    const session = p.realtimeHub.createConnectionSession((f) => frames.push(f as unknown as Record<string, unknown>));
    await session.handleClientFrame({ type: "auth", projectId: project.id, apiKey: rawKey });
    for (let i = 0; i < 26; i += 1) {
      await session.handleClientFrame({ type: "subscribe", subId: `s${i}`, query: { collectionPath: `c${i}` } });
    }
    const errors = frames.filter((f) => f["type"] === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "SUBSCRIPTION_LIMIT_EXCEEDED", subId: "s25" });
    expect(frames.filter((f) => f["type"] === "initial_sync")).toHaveLength(25);
    session.close();
  });
});
