import { describe, expect, it } from "vitest";

/**
 * Regression: importing node-server.js as a module must not install global
 * SIGTERM/SIGINT handlers. The handlers used to be registered at import time
 * while `activeServerStop` was only assigned in the isMain branch, so any
 * embedder (tests, stress launchers, host applications) lost its own signal
 * handling: the imported handler took the `stop === null` branch and called
 * process.exit(0) immediately - no drain, no metering flush, and the host's
 * own cleanup never ran.
 */
describe("node-server embedded import", () => {
  it("registers no SIGTERM/SIGINT handlers when not the process entrypoint", async () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    await import("../node-server.js");
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  });
});
