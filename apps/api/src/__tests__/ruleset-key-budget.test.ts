import { describe, expect, it } from "vitest";
import { createVellumPlatform } from "../index.js";

/**
 * Ruleset publishing has its own payload key budget (25,000 object keys),
 * separate from the 500-key per-document guard, and its own guardCode. A
 * realistic ruleset for many collections must publish cleanly, and a truly
 * oversized one must fail with RULESET_TOO_LARGE instead of the misleading
 * batch-oriented message.
 */

async function fixture() {
  const platform = createVellumPlatform();
  const res = await platform.fetch(
    new Request("http://localhost/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rules Owner", email: "rules@example.invalid", password: "FixtureOnly123!" }),
    })
  );
  expect(res.status).toBe(201);
  const { token, project } = (await res.json()) as { token: string; project: { id: string } };
  const publish = (rulesAst: unknown) =>
    platform.fetch(
      new Request(`http://localhost/v1/projects/${project.id}/rulesets`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ rulesAst }),
      })
    );
  return { publish };
}

describe("ruleset publishing key budget", () => {
  it("publishes a ruleset with more than 500 object keys (the old shared cap)", async () => {
    const { publish } = await fixture();
    // 200 rules (the per-ruleset rule cap) x ~3 keys each lands past 500 keys.
    const rules = Array.from({ length: 200 }, (_, i) => ({
      match: `c${i}/{docId}`,
      allow: { read: true, write: false },
    }));
    const res = await publish({ version: 1, rules });
    expect(res.status).toBeLessThan(300);
  });

  it("rejects a ruleset beyond the ruleset budget with RULESET_TOO_LARGE", async () => {
    const { publish } = await fixture();
    const rules = Array.from({ length: 9_000 }, (_, i) => ({
      match: `c${i}/{docId}`,
      allow: { read: true, write: false },
    }));
    const res = await publish({ version: 1, rules });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; details?: { guardCode?: string } } };
    expect(body.error.details?.guardCode).toBe("RULESET_TOO_LARGE");
    expect(body.error.message).toContain("ruleset");
  });
});
