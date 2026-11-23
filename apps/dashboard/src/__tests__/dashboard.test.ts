import { describe, it, expect } from "vitest";
import { CustomerDashboardService } from "../index.js";

describe("apps/dashboard - CustomerDashboardService", () => {
  it("simulates a security rule evaluation", () => {
    const service = new CustomerDashboardService({ platform: {} as never });

    const sim = service.simulateSecurityRule({
      rulesAst: {
        version: 1,
        rules: [
          {
            match: "users/{userId}",
            allow: {
              read: true,
              write: false,
            },
          },
        ],
      },
      operation: "get",
      path: "users/u1",
    });

    expect(sim.allowed).toBe(true);
  });
});
