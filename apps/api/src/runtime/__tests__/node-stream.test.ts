import { describe, expect, it } from "vitest";
import { pipeWebResponse, type NodeResponseLike } from "../node-stream.js";

function fakeRes() {
  const events: string[] = [];
  const headers: Record<string, string> = {};
  let closeListener: (() => void) | null = null;
  const res: NodeResponseLike & { ended: boolean } = {
    statusCode: 0,
    ended: false,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    write(chunk) { events.push("write:" + new TextDecoder().decode(chunk)); },
    end() { this.ended = true; events.push("end"); },
    flushHeaders() { events.push("flush"); },
    on(_e, l) { closeListener = l; },
  };
  return { res, events, headers, close: () => closeListener?.() };
}

describe("pipeWebResponse", () => {
  it("writes each chunk before the source finishes", async () => {
    const f = fakeRes();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode("one"));
        await gate;
        c.enqueue(enc.encode("two"));
        c.close();
      },
    });
    const done = pipeWebResponse(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }), f.res, { "x-test": "1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.events).toEqual(["flush", "write:one"]);
    expect(f.res.ended).toBe(false);
    release();
    await done;
    expect(f.events).toEqual(["flush", "write:one", "write:two", "end"]);
    expect(f.headers["content-type"]).toBe("text/event-stream");
    expect(f.headers["x-test"]).toBe("1");
    expect(f.res.statusCode).toBe(200);
  });

  it("ends immediately for an empty body and cancels the source when the client closes", async () => {
    const empty = fakeRes();
    await pipeWebResponse(new Response(null, { status: 204 }), empty.res);
    expect(empty.events).toEqual(["end"]);

    const f = fakeRes();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } });
    const done = pipeWebResponse(new Response(body), f.res);
    await new Promise((r) => setTimeout(r, 10));
    f.close();
    await done;
    expect(cancelled).toBe(true);
    expect(f.res.ended).toBe(false);
  });
});
