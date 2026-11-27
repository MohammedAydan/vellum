import { describe, expect, it, vi } from "vitest";
import { createClient, type StorageLike } from "../index.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const session = (id: string) => ({ user: { id }, accessToken: `access-${id}`, refreshToken: `refresh-${id}` });
const document = (owner = "A") => ({ path: "items/one", documentId: "one", version: 1, data: { owner } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("SDK audit regressions", () => {
  it.each(["https://example.test/v1", "https://example.test/v1/projects/p", "ftp://example.test", "https://user:pass@example.test", "https://example.test?query=1", "relative"])("rejects unsafe or misrouted endpoint %s before sending", (endpoint) => {
    const fetch = vi.fn();
    expect(() => createClient({ projectId: "p", apiKey: "key", endpoint, customFetch: fetch })).toThrow(/endpoint/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("normalizes trailing slashes and uses exact project URL", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(document()));
    const db = createClient({ projectId: "p", apiKey: "key", endpoint: "https://example.test///", customFetch: fetch });
    await db.doc("items/one").get();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://example.test/v1/projects/p/documents/items/one");
    db.dispose();
  });
  it.each([{}, null, { user: {} }, { user: { id: "a" }, accessToken: "", refreshToken: "r" }])("rejects malformed auth success without signing in", async (body) => {
    const db = createClient({ projectId: "p", apiKey: "key", customFetch: async () => json(body) });
    await expect(db.signUpWithEmailAndPassword("a@example.test", "password")).rejects.toThrow(/auth response/);
    expect(db.currentUser).toBeNull();
    db.dispose();
  });
  it("partitions cache and dedupe for external bearer switches", async () => {
    let token = "A";
    let reads = 0;
    const db = createClient({ projectId: "p", apiKey: "key", getAuthToken: () => token, cache: { enabled: true }, dedupeReads: true, customFetch: async (_url, init) => {
      reads += 1;
      return json(document((init?.headers as Record<string, string>)["authorization"]));
    } });
    const ref = db.doc("items/one");
    expect((await ref.get()).data()).toEqual({ owner: "Bearer A" });
    expect((await ref.get()).data()).toEqual({ owner: "Bearer A" });
    token = "B";
    expect((await ref.get()).data()).toEqual({ owner: "Bearer B" });
    expect(reads).toBe(2);
    db.dispose();
  });
  it("does not join or return a prior session's in-flight read", async () => {
    const pending = deferred<Response>();
    let reads = 0;
    const db = createClient({ projectId: "p", apiKey: "key", dedupeReads: true, cache: { enabled: true }, customFetch: async (url, init) => {
      if (String(url).includes("sign-in/email")) return json(session(JSON.parse(String(init?.body)).email));
      if (String(url).includes("sign-out")) return json({ success: true });
      reads += 1;
      return reads === 1 ? pending.promise : json(document("B"));
    } });
    await db.signInWithEmailAndPassword("A", "password");
    const oldRead = db.doc("items/one").get();
    const oldResult = expect(oldRead).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await vi.waitFor(() => expect(reads).toBe(1));
    await db.signOut();
    await db.signInWithEmailAndPassword("B", "password");
    expect((await db.doc("items/one").get()).data()).toEqual({ owner: "B" });
    pending.resolve(json(document("A")));
    await oldResult;
    expect((await db.doc("items/one").get()).data()).toEqual({ owner: "B" });
    db.dispose();
  });
  it("clears local state before a stalled remote logout and preserves a later sign-in", async () => {
    const logout = deferred<Response>();
    const db = createClient({ projectId: "p", apiKey: "key", customFetch: async (url, init) => String(url).includes("sign-out") ? logout.promise : json(session(JSON.parse(String(init?.body)).email)) });
    await db.signInWithEmailAndPassword("A", "password");
    const signingOut = db.signOut();
    expect(db.currentUser).toBeNull();
    await db.signInWithEmailAndPassword("B", "password");
    logout.resolve(json({ success: true }));
    await signingOut;
    expect(db.currentUser?.id).toBe("B");
    db.dispose();
  });
  it("does not resurrect a pending sign-in after sign-out", async () => {
    const pending = deferred<Response>();
    const db = createClient({ projectId: "p", apiKey: "key", customFetch: async (url) => String(url).includes("sign-in") ? pending.promise : json({ success: true }) });
    const signingIn = db.signInWithEmailAndPassword("A", "password");
    const result = expect(signingIn).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await db.signOut();
    pending.resolve(json(session("A")));
    await result;
    expect(db.currentUser).toBeNull();
    db.dispose();
  });
  it("does not overwrite a new user's profile with a late old-user response", async () => {
    const pending = deferred<Response>();
    const db = createClient({ projectId: "p", apiKey: "key", customFetch: async (url, init) => String(url).endsWith("/auth/user") ? pending.promise : json(session(JSON.parse(String(init?.body)).email)) });
    await db.signInWithEmailAndPassword("A", "password");
    const reading = db.getUser();
    const result = expect(reading).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await db.signInWithEmailAndPassword("B", "password");
    pending.resolve(json({ user: { id: "A" } }));
    await result;
    expect(db.currentUser?.id).toBe("B");
    db.dispose();
  });
  it("ends old realtime subscriptions on sign-out before remote cleanup", async () => {
    const close = vi.fn();
    const onError = vi.fn();
    const pending = deferred<Response>();
    const db = createClient({ projectId: "p", apiKey: "key", customFetch: async (url) => String(url).includes("sign-out") ? pending.promise : json(session("A")), realtimeHub: {
      createConnectionSession: () => ({ handleClientFrame: () => undefined, close }),
    } });
    await db.signInWithEmailAndPassword("A", "password");
    db.doc("items/one").onSnapshot(() => undefined, onError);
    await Promise.resolve();
    const signingOut = db.signOut();
    expect(close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "SESSION_CHANGED" }));
    pending.resolve(json({ success: true }));
    await signingOut;
    db.dispose();
  });
  it("clears an external identity when its token provider becomes anonymous", async () => {
    let token: string | null = "A";
    const db = createClient({ projectId: "p", apiKey: "key", cache: { enabled: true }, getAuthToken: () => token, customFetch: async (_url, init) =>
      (init?.headers as Record<string, string>)["authorization"] ? json(document("A")) : json({ error: { code: "PERMISSION_DENIED" } }, 403)
    });
    await db.doc("items/one").get();
    token = null;
    await expect(db.doc("items/one").get()).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    db.dispose();
  });
  it("never commits a transaction staged by another session", async () => {
    const calls: string[] = [];
    const db = createClient({ projectId: "p", apiKey: "key", customFetch: async (url, init) => {
      calls.push(String(url));
      if (String(url).includes("sign-in")) return json(session(JSON.parse(String(init?.body)).email));
      return json({ transactionToken: "transaction-A" });
    } });
    await db.signInWithEmailAndPassword("A", "password");
    await expect(db.runTransaction(async (tx) => {
      tx.set("items/one", { owner: "A" });
      await db.signInWithEmailAndPassword("B", "password");
    })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(calls.some((url) => url.includes("transactions:commit"))).toBe(false);
    db.dispose();
  });
  it("scopes opt-in browser persistence by endpoint and project", async () => {
    const values = new Map<string, string>();
    const storage: StorageLike = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
    vi.stubGlobal("window", { localStorage: storage });
    try {
      // Persistence is opt-in since 0.0.9 (S7): each client passes authPersistence: "local".
      const a = createClient({ projectId: "a", apiKey: "key", authPersistence: "local", customFetch: async () => json(session("A")) });
      await a.signInWithEmailAndPassword("A", "password");
      const b = createClient({ projectId: "b", apiKey: "key", authPersistence: "local" });
      const otherOrigin = createClient({ projectId: "a", apiKey: "key", endpoint: "https://other.test", authPersistence: "local" });
      const restored = createClient({ projectId: "a", apiKey: "key", authPersistence: "local" });
      expect(b.currentUser).toBeNull();
      expect(otherOrigin.currentUser).toBeNull();
      expect(restored.currentUser?.id).toBe("A");
      a.dispose(); b.dispose(); otherOrigin.dispose(); restored.dispose();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("document path validation", () => {
  it("rejects a collection path used as a document path with a clear error", () => {
    const db = createClient({ projectId: "p", apiKey: "sk_test", endpoint: "http://127.0.0.1:1" });
    expect(() => db.doc("onlycollection")).toThrow(/even number of segments/);
    expect(() => db.doc("a/b/c")).toThrow(/even number of segments/);
    expect(() => db.doc("a/b")).not.toThrow();
    db.dispose?.();
  });
});
