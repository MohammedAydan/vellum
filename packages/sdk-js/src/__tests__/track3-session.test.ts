import { describe, expect, it } from "vitest";
import { createClient, type WebSocketLike } from "../index.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function session(accessToken: string, refreshToken = "refresh_1") {
  return {
    user: { id: "usr", email: "a@b.c", createdAt: "2026-11-01T00:00:00.000Z" },
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    sessionId: "sess_1",
    expiresAt: "2026-11-28T01:00:00.000Z",
  };
}

class MockSocket implements WebSocketLike {
  public readyState = 1;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;
  public readonly sent: string[] = [];
  public send(data: string): void {
    this.sent.push(data);
  }
  public close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  public receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const TOKEN_A = makeJwt({ sub: "usr_a", exp: Math.floor(Date.now() / 1000) + 3600 });
const TOKEN_B = makeJwt({ sub: "usr_b", exp: Math.floor(Date.now() / 1000) + 3600 });

describe("identity switch kills live subscriptions (Track 3)", () => {
  it("A -> B sign-in closes subscriptions with SESSION_CHANGED", async () => {
    const sockets: MockSocket[] = [];
    const fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/auth/sign-in/email")) {
        // First sign-in is A; the second is B (identity switch).
        const usedB = (fetch as unknown as { usedB?: boolean }).usedB === true;
        (fetch as unknown as { usedB?: boolean }).usedB = true;
        return json(session(usedB ? TOKEN_B : TOKEN_A));
      }
      return json({});
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: fetch,
      webSocketFactory: () => {
        const s = new MockSocket();
        sockets.push(s);
        return s;
      },
    });

    await db.signInWithEmailAndPassword({ email: "a@example.com", password: "password123" });

    const errors: Array<{ code?: string }> = [];
    const off = db.doc("chats/c1").onSnapshot(
      () => undefined,
      (err) => errors.push(err as { code?: string })
    );
    await Promise.resolve();
    const sock = sockets[0]!;
    sock.onopen?.({});
    await Promise.resolve();
    sock.receive({ type: "auth_ack" });

    // Identity switch: A -> B.
    await db.signInWithEmailAndPassword({ email: "b@example.com", password: "password123" });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("SESSION_CHANGED");
    expect(sock.readyState).toBe(3);
    off();
    db.dispose();
  });

  it("same-identity token refresh reauthenticates instead of killing subscriptions", async () => {
    const sockets: MockSocket[] = [];
    const TOKEN_A2 = makeJwt({ sub: "usr_a", exp: Math.floor(Date.now() / 1000) + 7200 });
    let refreshCalls = 0;
    const fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/auth/sign-in/email")) return json(session(TOKEN_A));
      if (u.endsWith("/auth/token/refresh")) {
        refreshCalls += 1;
        return json(session(TOKEN_A2, "refresh_2"));
      }
      return json({});
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: fetch,
      webSocketFactory: () => {
        const s = new MockSocket();
        sockets.push(s);
        return s;
      },
    });

    await db.signInWithEmailAndPassword({ email: "a@example.com", password: "password123" });
    const errors: Array<{ code?: string }> = [];
    db.doc("chats/c1").onSnapshot(
      () => undefined,
      (err) => errors.push(err as { code?: string })
    );
    await Promise.resolve();
    const sock = sockets[0]!;
    sock.onopen?.({});
    await Promise.resolve();
    sock.receive({ type: "auth_ack" });

    await db.auth.getIdToken(true); // force refresh, same subject
    expect(refreshCalls).toBe(1);
    expect(errors).toHaveLength(0);
    expect(sock.readyState).toBe(1);
    // The live socket received a re-auth frame carrying the new token.
    const authFrames = sock.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f["type"] === "auth");
    expect(authFrames.length).toBeGreaterThanOrEqual(2);
    db.dispose();
  });
});
