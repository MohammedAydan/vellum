import { describe, expect, it } from "vitest";
import { createFixture, TENANT, serverKey, publicKey } from "./_harness.js";
import type { EngineContext } from "../types.js";

function ctx(budget?: EngineContext["rulesLookupBudget"]): EngineContext & { path: string } {
  return {
    ...TENANT,
    path: "items/one",
    apiKeyRecord: serverKey("key-1"),
    ...(budget ? { rulesLookupBudget: budget } : {}),
  };
}

function telemetryOf(f: { telemetry: unknown }): Map<string, number> {
  return (f.telemetry as unknown as { counters: Map<string, number> }).counters;
}

describe("per-request rules-lookup budget (D1)", () => {
  it("meters the store read and memoizes within one request context", async () => {
    const f = createFixture();
    const counters = telemetryOf(f);
    const c = ctx();
    await f.engine.getDocument(c).catch(() => undefined);
    expect(counters.get("security.rules_lookups")).toBe(1);
    // Same request context object: the second call hits the memo, not the store.
    await f.engine.getDocument(c).catch(() => undefined);
    expect(counters.get("security.rules_lookups")).toBe(1);
  });

  it("a fresh request context reads the store again", async () => {
    const f = createFixture();
    const counters = telemetryOf(f);
    await f.engine.getDocument(ctx()).catch(() => undefined);
    await f.engine.getDocument(ctx()).catch(() => undefined);
    expect(counters.get("security.rules_lookups")).toBe(2);
  });

  it("spreading a used context never inherits the memoized ruleset", async () => {
    const noRules = createFixture();
    const base = { ...TENANT, path: "items/one", apiKeyRecord: publicKey() };
    // This memoizes "no ruleset" against the base context object.
    await noRules.engine.getDocument(base).catch(() => undefined);

    const ruleset = {
      rulesAst: {
        version: 1,
        rules: [{ match: "items/{id}", allow: { get: true } }],
      },
    };
    const withRules = createFixture({ ruleset });
    await withRules.engine.createDocument({ ...TENANT, path: "items/one", data: { v: 1 } });
    // A spread is a new request: it must see this fixture's ruleset, not the stale memo.
    const doc = await withRules.engine.getDocument({ ...base });
    expect(doc?.path).toBe("items/one");
  });

  it("memoizes the ruleset within a shared explicit budget", async () => {
    const f = createFixture();
    const shared = ctx({ used: 0, maxLoads: 2 });
    await f.engine.getDocument(shared).catch(() => undefined);
    await f.engine.getDocument({ ...shared, rulesLookupBudget: shared.rulesLookupBudget }).catch(() => undefined);
    // One store read for the whole request; the second call hits the memo.
    expect(shared.rulesLookupBudget?.used).toBe(1);
  });

  it("fails closed when the store-read cap is exhausted without a memo", async () => {
    const f = createFixture();
    const shared = ctx({ used: 0, maxLoads: 1 });
    await f.engine.getDocument(shared).catch(() => undefined);
    expect(shared.rulesLookupBudget?.used).toBe(1);
    // A path that bypasses the request memo (cache dropped) hits the cap.
    delete shared.rulesLookupBudget!.cached;
    const denied = await f.engine
      .getDocument({ ...shared, rulesLookupBudget: shared.rulesLookupBudget })
      .then(() => ({ code: "ok" as const }))
      .catch((err: { code?: string }) => ({ code: err.code ?? "unknown" }));
    expect(denied.code).toBe("PERMISSION_DENIED");

    const audit = f.audit as unknown as { calls: Array<{ action: string }> };
    expect(audit.calls.some((call) => call.action === "security.rules_budget_exceeded")).toBe(true);
  });
});
