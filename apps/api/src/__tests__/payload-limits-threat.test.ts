import { beforeEach, describe, expect, it } from "vitest";
import { createVellumPlatform } from "../index.js";
import { resetPayloadLimitWindows } from "../middleware/fortress.js";

/**
 * Payload shape budgets are decoupled from the threat detector's
 * injection/SSRF IP ban: oversized payloads get per-request 400s (429 only for
 * an abusive streak), while genuine prototype-pollution keys still escalate
 * to a block after 3 events in 10 minutes.
 */

async function fixture() {
  const platform = createVellumPlatform();
  const res = await platform.fetch(
    new Request("http://localhost/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Limit Owner", email: "limit@example.invalid", password: "FixtureOnly123!" }),
    })
  );
  expect(res.status).toBe(201);
  const { token, project } = (await res.json()) as { token: string; project: { id: string } };
  const publish = (rules: unknown[]) =>
    platform.fetch(
      new Request(`http://localhost/v1/projects/${project.id}/rulesets`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ rulesAst: { version: 1, rules } }),
      })
    );
  const oversizeRules = () =>
    Array.from({ length: 9_000 }, (_, i) => ({ match: `c${i}/{docId}`, allow: { read: true, write: false } }));
  return { platform, publish, oversizeRules };
}

describe("payload limits vs threat escalation", () => {
  beforeEach(() => {
    resetPayloadLimitWindows();
  });

  it("rejects 10 oversize payloads in a row with 400 and never blocks the IP", async () => {
    const { platform, publish, oversizeRules } = await fixture();
    for (let i = 0; i < 10; i += 1) {
      const res = await publish(oversizeRules());
      expect(res.status).toBe(400);
    }
    // The same client keeps full access: no injection/SSRF escalation.
    const health = await platform.fetch(new Request("http://localhost/v1/health"));
    expect(health.status).toBe(200);
  }, 120_000);

  it("throttles an abusive streak of oversize payloads with 429 + Retry-After", async () => {
    const { publish, oversizeRules } = await fixture();
    let last: Response | undefined;
    for (let i = 0; i < 21; i += 1) {
      last = await publish(oversizeRules());
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).not.toBeNull();
  }, 120_000);

  it("still escalates genuine prototype-pollution keys to an IP block after 3 events", async () => {
    const platform = createVellumPlatform();
    const protoBody = '{"__proto__": {"polluted": true}, "name": "x", "email": "p@example.invalid", "password": "FixtureOnly123!"}';
    for (let i = 0; i < 3; i += 1) {
      const res = await platform.fetch(
        new Request("http://localhost/v1/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: protoBody,
        })
      );
      expect(res.status).toBe(400);
    }
    const blocked = await platform.fetch(new Request("http://localhost/v1/health"));
    expect(blocked.status).toBe(403);
    const body = (await blocked.json()) as { error: { message: string } };
    expect(body.error.message).toBe("IP_BLOCKED");
  });
});
