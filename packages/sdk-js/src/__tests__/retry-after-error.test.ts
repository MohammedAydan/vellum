import { describe, expect, it } from "vitest";
import { createClient } from "../index.js";

const res429 = (headers: Record<string, string>, details: Record<string, unknown>) =>
  new Response(JSON.stringify({ error: { code: "TOO_MANY_REQUESTS", message: "Too many attempts.", details } }), {
    status: 429,
    headers: { "content-type": "application/json", ...headers },
  });

describe("throttled requests expose retryAfter", () => {
  it("reads Retry-After (seconds) from the header", async () => {
    const db = createClient({ projectId: "p", apiKey: "pk_t", customFetch: (async () => res429({ "retry-after": "900" }, {})) as unknown as typeof fetch, maxRetries: 0 } as never);
    const err = (await db.doc("a/b").set({ x: 1 }).catch((e: unknown) => e)) as { code: string; retryAfter?: number };
    expect(err.code).toBe("TOO_MANY_REQUESTS");
    expect(err.retryAfter).toBe(900);
  });

  it("falls back to details.retryAfterSeconds", async () => {
    const db = createClient({ projectId: "p", apiKey: "pk_t", customFetch: (async () => res429({}, { retryAfterSeconds: 120 })) as unknown as typeof fetch, maxRetries: 0 } as never);
    const err = (await db.doc("a/b").set({ x: 1 }).catch((e: unknown) => e)) as { retryAfter?: number };
    expect(err.retryAfter).toBe(120);
  });
});
