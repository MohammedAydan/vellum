import { describe, expect, it, vi } from "vitest";
import { createControlInvalidationHandler } from "../workers/control-invalidation.js";

describe("control invalidation handler", () => {
  it("drops the control read cache for every message kind", () => {
    const invalidateReadCache = vi.fn();
    const handler = createControlInvalidationHandler({ refresh: async () => undefined, invalidateReadCache });
    handler({ kind: "ruleset", key: "p" } as never);
    handler({ kind: "relation_rules", key: "p" } as never);
    expect(invalidateReadCache).toHaveBeenCalledTimes(2);
  });
});
