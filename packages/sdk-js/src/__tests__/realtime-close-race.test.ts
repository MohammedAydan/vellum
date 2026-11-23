import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { RealtimeTransport, type WebSocketLike } from "../index.js";

/**
 * Regression: closing a realtime transport while its socket is still
 * CONNECTING must not crash the host process. The `ws` package emits an
 * asynchronous `error` event ("WebSocket was closed before the connection was
 * established") in that case; with listeners detached during close(), the
 * event had no handler and took down the entire Node process.
 */

/** Minimal ws-like fake: EventEmitter semantics, on* properties map to listeners. */
class FakeConnectingSocket extends EventEmitter implements WebSocketLike {
  public readonly readyState = 0; // CONNECTING
  private _onopen: ((event: unknown) => void) | null = null;
  private _onmessage: ((event: { data: unknown }) => void) | null = null;
  private _onerror: ((event: unknown) => void) | null = null;
  private _onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;
  public closedWith: { code?: number | undefined; reason?: string | undefined } | null = null;

  get onopen() { return this._onopen; }
  set onopen(fn) { this._onopen = fn; }
  get onmessage() { return this._onmessage; }
  set onmessage(fn) { this._onmessage = fn; }
  get onerror() { return this._onerror; }
  set onerror(fn) {
    this.removeAllListeners("error");
    this._onerror = fn;
    if (fn) this.on("error", (e) => this._onerror?.(e));
  }
  get onclose() { return this._onclose; }
  set onclose(fn) { this._onclose = fn; }

  send(): void {}
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    // Mimic `ws`: closing a CONNECTING socket emits an async error. An
    // unhandled 'error' on an EventEmitter throws inside the emit call.
    process.nextTick(() => {
      this.emit("error", new Error("WebSocket was closed before the connection was established"));
    });
  }
}

function makeTransport(socket: FakeConnectingSocket): RealtimeTransport {
  return new RealtimeTransport({
    url: "ws://127.0.0.1:1/v1/realtime",
    auth: () => ({ projectId: "p", apiKey: "k" }),
    onFrame: () => {},
    webSocketFactory: () => socket,
  });
}

describe("RealtimeTransport close race", () => {
  it("close() while CONNECTING swallows the late ws error instead of crashing", async () => {
    const socket = new FakeConnectingSocket();
    const transport = makeTransport(socket);
    void transport.connect().catch(() => {});
    transport.close();
    // Let the async error fire; before the fix this threw an unhandled 'error'.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.closedWith?.code).toBe(1000);
    expect(typeof socket.onerror).toBe("function");
  });

  it("failConnection() on a CONNECTING socket also closes quietly", async () => {
    const socket = new FakeConnectingSocket();
    const transport = makeTransport(socket);
    void transport.connect().catch(() => {});
    (transport as unknown as { failConnection(e: unknown): void }).failConnection(new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(typeof socket.onerror).toBe("function");
    transport.close();
  });
});
