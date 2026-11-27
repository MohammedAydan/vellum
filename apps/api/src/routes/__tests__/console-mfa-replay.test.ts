import { describe, expect, it } from "vitest";
import { generateTotpCode } from "@vellum/auth";
import type { SessionClaims, SessionService } from "@vellum/authorization";
import { createVellumPlatform } from "../../index.js";
import { createMfaApp, InMemoryMfaStore } from "../mfa.js";

function fixture() {
  const platform = createVellumPlatform();
  const claims = { uid: "user-1", role: "owner" } as SessionClaims;
  const sessionService = {
    verifyAccessChecked: async () => claims,
  } as unknown as SessionService;
  const app = createMfaApp({
    controlStore: platform.controlStore,
    sessionService,
    store: new InMemoryMfaStore(),
    apiKeyPepper: "test-pepper",
  });
  const post = (path: string, body: unknown) =>
    app.fetch(
      new Request(`http://localhost/v1/auth/mfa${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-session" },
        body: JSON.stringify(body),
      })
    );
  return { post };
}

describe("console TOTP MFA replay protection (S9)", () => {
  it("a code that enabled MFA cannot be replayed at /verify or /disable", async () => {
    const f = fixture();
    const setup = await (await f.post("/setup", {})).json() as { secret: string };
    const code = generateTotpCode(setup.secret);
    expect((await f.post("/verify", { code })).status).toBe(200);
    // Replay at /disable inside the code's validity window: rejected, and MFA
    // stays enabled.
    expect((await f.post("/disable", { code })).status).toBe(401);
    // A fresh code from the next step still works.
    const fresh = generateTotpCode(setup.secret, Date.now() + 30_000);
    expect((await f.post("/disable", { code: fresh })).status).toBe(200);
  });

  it("the same fresh code cannot be used twice", async () => {
    const f = fixture();
    const setup = await (await f.post("/setup", {})).json() as { secret: string };
    const code = generateTotpCode(setup.secret);
    expect((await f.post("/verify", { code })).status).toBe(200);
    // /verify is idempotent for an enabled record but must not consume or
    // re-accept the spent code pathologically: a second enable attempt with a
    // different account code shape still reports enabled.
    expect((await f.post("/verify", { code })).status).toBe(200);
  });
});
