/**
 * Integration: TypeScript SDK realtime over Server-Sent Events (default transport),
 * served by the in-process API. No WebSocket upgrade is involved.
 */
import { describe, expect, it } from "vitest";
import { createVellumPlatform } from "../../apps/api/src/index.js";
import { CustomerDashboardService } from "../../apps/dashboard/src/index.js";
import { createClient } from "../../packages/sdk-js/src/index.js";
import { resetRealtimeFallbackCache } from "../../packages/sdk-js/src/index.js";
import type { DocumentSnapshot } from "../../packages/sdk-js/src/index.js";

function harness(transport: "auto" | "sse" = "sse") {
  const platform = createVellumPlatform();
  const dashboard = new CustomerDashboardService({ platform });
  const user = platform.controlStore.createUser({ email: "sse@vellum.dev", name: "SSE", platformRole: "customer" });
  const org = platform.controlStore.createOrganization({
    slug: "sse-org",
    name: "SSE Org",
    billingEmail: "sse@vellum.dev",
    ownerUserId: user.id,
  });
  const { project } = platform.controlStore.createProject({
    organizationId: org.id,
    slug: "sse-proj",
    name: "SSE Project",
    actorUserId: user.id,
  });
  const { plaintextKeyOnce: apiKey } = dashboard.createProjectApiKey({
    projectId: project.id,
    name: "SSE Server Key",
    keyType: "server",
    scopes: ["documents:read", "documents:write"],
    actorUserId: user.id,
  });
  const client = createClient({
    projectId: project.id,
    apiKey,
    endpoint: "http://127.0.0.1:9",
    realtimeTransport: transport,
    customFetch: (url, init) => platform.fetch(new Request(url, init)),
    realtimeTransportOptions: { heartbeatIntervalMs: 60_000, connectTimeoutMs: 5000 },
  });
  return { platform, client };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("sdk-js realtime over SSE", () => {
  it("auto mode tries WebSocket first and falls back to SSE when the host cannot upgrade", async () => {
    resetRealtimeFallbackCache();
    const { platform, client } = harness("auto");
    const snaps: DocumentSnapshot<Record<string, unknown>>[] = [];
    const ref = client.collection("tickets").doc("t9");
    const off = ref.onSnapshot((s) => snaps.push(s));
    // P0-4: a document missing at subscribe time emits exists === false first.
    await waitFor(() => snaps.length > 0, 15_000);
    expect(snaps[0]!.exists).toBe(false);
    await ref.create({ n: 1 });
    await waitFor(() => snaps.some((s) => s.exists && s.data()!["n"] === 1), 15_000);
    off();
    platform.metering.stop();
  }, 30_000);

  it("delivers create, update and delete quickly and survives adding a second subscription", async () => {
    const { platform, client } = harness();
    const snaps: DocumentSnapshot<Record<string, unknown>>[] = [];
    const ref = client.collection("tickets").doc("t1");
    const off = ref.onSnapshot((s) => snaps.push(s));
    await waitFor(() => snaps.length > 0);

    const other: DocumentSnapshot<Record<string, unknown>>[] = [];
    const off2 = client.collection("tickets").doc("t2").onSnapshot((s) => other.push(s));
    await waitFor(() => other.length > 0);

    const t0 = Date.now();
    await ref.create({ n: 1 });
    await waitFor(() => snaps.some((s) => s.exists && s.data()!["n"] === 1));
    const latency = Date.now() - t0;
    expect(latency).toBeLessThan(1000);

    await ref.update({ n: 2 });
    await waitFor(() => snaps.some((s) => s.exists && s.data()!["n"] === 2));
    await ref.delete();
    // P0-4: a delete lands as exists === false with data() === null.
    await waitFor(() => snaps.some((s) => !s.exists && s.path === "tickets/t1" && s.version > 0));

    off();
    off2();
    platform.metering.stop();
  }, 20_000);
});
