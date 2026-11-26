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
  return { projectId: project.id, rawKey, write, open };
}

async function readFrames(res: Response, until: (frames: Array<Record<string, unknown>>) => boolean, ms = 4000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<Record<string, unknown>> = [];
  let buffer = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !until(frames)) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 200)),
    ]);
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
  }
  await reader.cancel();
  return frames;
}

describe("realtime over SSE", () => {
  it("streams create, update and delete events without a WebSocket upgrade", async () => {
    const f = await fixture();
    const res = await f.open([
      { type: "auth", projectId: f.projectId, apiKey: f.rawKey },
      { type: "subscribe", subId: "s1", query: { collectionPath: "items" } },
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reading = readFrames(res, (fr) => fr.filter((x) => x["type"] === "mutation").length >= 3);
    await new Promise((r) => setTimeout(r, 150));
    await f.write("POST", "/documents/items/a", { data: { n: 1 } });
    await f.write("PUT", "/documents/items/a", { data: { n: 2 } });
    await f.write("DELETE", "/documents/items/a", {});
    const frames = await reading;
    expect(frames[0]).toMatchObject({ type: "auth_ack" });
    const ops = frames.filter((x) => x["type"] === "mutation").map((x) => x["operation"]);
    expect(ops).toEqual(["create", "update", "delete"]);
  });

  it("rejects bad credentials with an error frame and closes", async () => {
    const f = await fixture();
    const res = await f.open([{ type: "auth", projectId: f.projectId, apiKey: "sk_bad_key_000000000000000" }]);
    const frames = await readFrames(res, (fr) => fr.some((x) => x["type"] === "error"));
    expect(frames.some((x) => x["type"] === "error")).toBe(true);
    expect(frames.some((x) => x["type"] === "auth_ack")).toBe(false);
  });

  it("requires an auth frame first and bounds frame count", async () => {
    const f = await fixture();
    expect((await f.open([{ type: "ping", ts: 1 }])).status).toBe(401);
    expect((await f.open([])).status).toBe(400);
    const many = Array.from({ length: 65 }, () => ({ type: "ping", ts: 1 }));
    expect((await f.open([{ type: "auth", projectId: f.projectId, apiKey: f.rawKey }, ...many])).status).toBe(400);
  });

  it("sets the SSE id from seqId", () => {
    expect(encodeSseFrame({ type: "pong", ts: 1, serverTs: 2 })).toBe('data: {"type":"pong","ts":1,"serverTs":2}\n\n');
    expect(
      encodeSseFrame({ type: "resume_complete", subId: "s", seqId: "9", count: 1, truncated: false })
    ).toContain("id: 9\n");
  });

  describe("browser access from a third-party origin", () => {
    it("adds Access-Control-Allow-Origin only when an active key of the project lists the origin", async () => {
      const f = await fixture();
      const p = platforms[platforms.length - 1]!;
      (p.controlStore as unknown as { listActiveApiKeyOrigins: (id: string) => Promise<string[]> }).listActiveApiKeyOrigins = async (id) =>
        id === f.projectId ? ["https://shop.example"] : [];
      const post = (origin: string, projectId = f.projectId) => {
        const ac = new AbortController();
        const res = Promise.resolve(p.fetch(
          new Request("http://localhost/v1/realtime/stream", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({ frames: [{ type: "auth", projectId, apiKey: f.rawKey }] }),
            signal: ac.signal,
          })
        ));
        return res.then((r: Response) => {
          ac.abort();
          return r;
        });
      };
      const ok = await post("https://shop.example");
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://shop.example");
      expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
      const other = await post("https://evil.example");
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
      const wrongProject = await post("https://shop.example", "00000000-0000-4000-8000-000000000000");
      expect(wrongProject.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});
