import { expect, test, type Page } from "@playwright/test";

interface DocStoreLike {
  set(key: string, value: unknown): Promise<void>;
  get(key: string): Promise<{ value: unknown } | undefined>;
}
interface SocketLike {
  onmessage: ((e: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
interface SdkShape {
  resetRealtimeFallbackCache(): void;
  createFallbackSocketFactory(o: {
    webSocketFactory: (url: string) => WebSocket;
    openTimeoutMs: number;
    onFallback: () => void;
  }): (url: string) => Promise<SocketLike>;
  createDefaultDocStore(name: string): DocStoreLike;
}
type SdkWindow = { VellumSdk: SdkShape };

/** Open a socket through the SDK's WebSocket-first factory, collect frames with arrival times. */
async function runSocket(page: Page, base: string) {
  return page.evaluate(async (basePath) => {
    const sdk = (window as unknown as SdkWindow).VellumSdk;
    sdk.resetRealtimeFallbackCache();
    let fellBack = false;
    const factory = sdk.createFallbackSocketFactory({
      webSocketFactory: (url: string) => new WebSocket(url),
      openTimeoutMs: 3000,
      onFallback: () => {
        fellBack = true;
      },
    });
    const url = `ws://${location.host}${basePath}/v1/realtime`;
    const socket = await factory(url);
    const frames: Array<{ type: string; at: number }> = [];
    const t0 = Date.now();
    socket.onmessage = (e) => frames.push({ type: JSON.parse(e.data).type, at: Date.now() - t0 });
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => undefined;
      setTimeout(() => reject(new Error("socket did not open")), 8000);
    });
    socket.send(JSON.stringify({ type: "auth", projectId: "p", apiKey: "k" }));
    socket.send(JSON.stringify({ type: "subscribe", subId: "s1", path: "c" }));
    await new Promise((r) => setTimeout(r, 2600));
    socket.close();
    return { fellBack, frames };
  }, base);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("WebSocket is used when the host supports it (no fallback)", async ({ page }) => {
  const out = await runSocket(page, "/ws");
  expect(out.fellBack).toBe(false);
  expect(out.frames.map((f) => f.type)).toContain("auth_ack");
});

test("falls back to SSE when the WebSocket upgrade is refused, and streams incrementally", async ({ page }) => {
  const out = await runSocket(page, "/nows");
  expect(out.fellBack).toBe(true);
  const ack = out.frames.find((f) => f.type === "auth_ack");
  const mutation = out.frames.find((f) => f.type === "mutation");
  expect(ack).toBeTruthy();
  expect(mutation).toBeTruthy();
  // The server sent the mutation 1.5s after the ack; a buffering browser would deliver both together.
  expect(mutation!.at - ack!.at).toBeGreaterThan(900);
});

test("IndexedDB document cache persists across page reloads", async ({ page }) => {
  const kind = await page.evaluate(() => {
    const sdk = (window as unknown as SdkWindow).VellumSdk;
    return (sdk.createDefaultDocStore("compat") as object).constructor.name;
  });
  expect(kind).toBe("IndexedDbDocStore");
  await page.evaluate(async () => {
    const sdk = (window as unknown as SdkWindow).VellumSdk;
    const store = sdk.createDefaultDocStore("compat-persist");
    await store.set("k1", { path: "c/1", value: { n: 42 }, storedAt: Date.now() });
  });
  await page.reload();
  const value = await page.evaluate(async () => {
    const sdk = (window as unknown as SdkWindow).VellumSdk;
    const store = sdk.createDefaultDocStore("compat-persist");
    return (await store.get("k1"))?.value;
  });
  expect(value).toEqual({ n: 42 });
});
