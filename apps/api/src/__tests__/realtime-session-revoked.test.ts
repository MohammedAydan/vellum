import { afterEach, describe, expect, it } from "vitest";
import { createVellumPlatform } from "../index.js";
import { encodeSseFrame } from "../routes/realtime-sse.js";

const platforms: ReturnType<typeof createVellumPlatform>[] = [];
afterEach(() => {
  for (const p of platforms.splice(0)) p.metering.stop();
});

async function fixture() {
  const p = createVellumPlatform();
  platforms.push(p);
  const org = await p.controlStore.createOrganization({
    name: "Sse",
    slug: `sse-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    planId: "pro",
    billingEmail: "test@example.test",
  });
  const { project } = await p.controlStore.createProject({ organizationId: org.id, name: "Sse", slug: "sse" });
  const keyRes = await p.fetch(
    new Request(`http://localhost/v1/projects/${project.id}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "secret", keyType: "secret" }),
    })
  );
  const { rawKey } = (await keyRes.json()) as { rawKey: string };
  const write = (method: string, path: string, body: unknown) =>
    p.fetch(
      new Request(`http://localhost/v1/projects/${project.id}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-project-key": rawKey },
        body: JSON.stringify(body),
      })
    );
  const open = (frames: unknown[], signal?: AbortSignal) =>
    p.fetch(
      new Request("http://localhost/v1/realtime/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frames }),
        ...(signal ? { signal } : {}),
      })
    );
  return { p, projectId: project.id, rawKey, write, open };
}

/** Reads SSE frames in the background without ever dropping a chunk (a raced read would lose data). */
function collectFrames(res: Response) {
  const frames: Array<Record<string, unknown>> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const done = (async () => {
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (next.value) {
        buffer += decoder.decode(next.value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (data) frames.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
        }
      }
      if (next.done) return;
    }
  })();
  return { frames, stop: async () => { await reader.cancel().catch(() => undefined); await done; } };
}

describe("realtime stops delivering to a revoked end-user session", () => {
  it("closes the stream after sign-out instead of delivering later events", async () => {
    process.env["REALTIME_SESSION_RECHECK_MS"] = "0";
    const f = await fixture();
    const su = await fetch_(f, "POST", "/auth/sign-up/email", { email: `rv-${Date.now()}@example.com`, password: "Revoke-Test-1234!" });
    expect(su.status).toBe(201);
    const { accessToken, refreshToken } = (await su.json()) as { accessToken: string; refreshToken: string };
    const res = await f.open([
      { type: "auth", projectId: f.projectId, apiKey: f.rawKey, authToken: accessToken },
      { type: "subscribe", subId: "s1", query: { collectionPath: "items" } },
    ]);
    const feed = collectFrames(res);
    await new Promise((r) => setTimeout(r, 300));
    expect((await f.write("PUT", "/documents/items/before", { data: { n: 1 } })).status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 300));
    const out = await fetch_(f, "POST", "/auth/sign-out", { refreshToken }, accessToken);
    expect(out.status).toBe(200);
    expect((await f.write("PUT", "/documents/items/after", { data: { n: 2 } })).status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 2500));
    await feed.stop();
    const frames = feed.frames;
    const types = frames.map((x) => x["type"]);
    expect(types).toContain("error");
    const errIdx = types.indexOf("error");
    expect(frames.slice(errIdx + 1).some((x) => x["type"] === "mutation")).toBe(false);
    expect(JSON.stringify(frames.slice(errIdx))).not.toContain("after");
    delete process.env["REALTIME_SESSION_RECHECK_MS"];
  }, 20000);
});

async function fetch_(f: Awaited<ReturnType<typeof fixture>>, method: string, path: string, body: unknown, token?: string) {
  return f.p.fetch(
    new Request(`http://localhost/v1/projects/${f.projectId}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-project-key": f.rawKey, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  );
}
