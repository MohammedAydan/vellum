import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../index.js";

// A browser's window.fetch throws "Illegal invocation" unless it runs with no receiver or with window.
// This stub reproduces that rule so a regression to `this.customFetch(...)` fails here, not in a browser.
function browserLikeFetch() {
  const calls: string[] = [];
  const fn = function (this: unknown, input: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    calls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ id: "a", path: "c/a", version: 1, data: {} }), { status: 200, headers: { "content-type": "application/json" } }));
  };
  return { fn, calls };
}

describe("sdk-js calls fetch like a browser requires", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    vi.restoreAllMocks();
  });

  it("works with the default globalThis.fetch", async () => {
    const { fn, calls } = browserLikeFetch();
    globalThis.fetch = fn as never;
    const db = createClient({ projectId: "p1", apiKey: "pk_" + "a".repeat(32), endpoint: "https://api.example.test" });
    await db.collection("c").doc("a").get();
    expect(calls).toHaveLength(1);
  });

  it("works when the app passes window.fetch as customFetch", async () => {
    const { fn, calls } = browserLikeFetch();
    const db = createClient({ projectId: "p1", apiKey: "pk_" + "a".repeat(32), endpoint: "https://api.example.test", customFetch: fn as never });
    await db.collection("c").doc("a").get();
    expect(calls).toHaveLength(1);
  });

  it("uses a fetch installed after the client was created", async () => {
    const db = createClient({ projectId: "p1", apiKey: "pk_" + "a".repeat(32), endpoint: "https://api.example.test" });
    const { fn, calls } = browserLikeFetch();
    globalThis.fetch = fn as never;
    await db.collection("c").doc("a").get();
    expect(calls).toHaveLength(1);
  });
});
