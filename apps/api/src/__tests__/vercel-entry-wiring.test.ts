import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Vercel serves `/api/server` from api/server/index.js (the rewrite target), not from runtime/vercel.ts.
// Anything the Vercel runtime needs must be wired in that file too.
describe("Vercel function entry wiring", () => {
  const src = readFileSync(fileURLToPath(new URL("../../api/server/index.js", import.meta.url)), "utf8");

  it("serves the maintenance endpoint and runs the purge tick", () => {
    expect(src).toContain("handleMaintenanceRequest(request, platform.dataStore)");
    expect(src).toContain("startPurgeTick(platform.dataStore");
  });

  it("closes WebSockets before the function limit", () => {
    expect(src).toContain("maxLifetimeMs");
    expect(src).toContain("REALTIME_WS_MAX_LIFETIME_MS");
  });
});
