import { describe, expect, it } from "vitest";
import { createClient } from "../index.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("5xx responses are retried with backoff", () => {
  it("retries a 503 read and succeeds when the server recovers", async () => {
    let calls = 0;
    const customFetch = (async () => {
      calls += 1;
      if (calls < 3) return json(503, { error: { code: "UNAVAILABLE", message: "busy" } });
      return json(200, { exists: false, path: "a/b" });
    }) as unknown as typeof fetch;
    const db = createClient({ projectId: "p", apiKey: "pk_t", customFetch, maxRetries: 3, retryBaseDelayMs: 5 } as never);
    await db.doc("a/b").get().catch(() => undefined);
    expect(calls).toBe(3);
  });

  it("gives up after maxRetries and surfaces the error", async () => {
    let calls = 0;
    const customFetch = (async () => {
      calls += 1;
      return json(503, { error: { code: "UNAVAILABLE", message: "busy" } });
    }) as unknown as typeof fetch;
    const db = createClient({ projectId: "p", apiKey: "pk_t", customFetch, maxRetries: 2, retryBaseDelayMs: 5 } as never);
    const err = await db.doc("a/b").get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(calls).toBe(3);
  });
});
