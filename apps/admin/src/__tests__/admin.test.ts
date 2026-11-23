import { describe, it, expect } from "vitest";
import { PlatformAdminService } from "../index.js";
import { VellumError } from "@vellum/core";
import { assertPrivacySafeEndpoint, assertNoCustomerPayload } from "../lib/api.js";

/** Metadata-only tenant shape (no customer document payloads) used as a privacy fixture. */
const metadataOnlyTenants = [
  {
    id: "org_123",
    name: "Tenant",
    slug: "tenant",
    storageMb: 420,
    dailyReads: 1200,
    dailyWrites: 300,
    projectsCount: 2,
  },
];

describe("apps/admin - PlatformAdminService", () => {
  it("enforces role check: rejects non-admin users", () => {
    const service = new PlatformAdminService({ platform: {} as never });

    expect(() =>
      service.getClusterMetrics({ id: "user_1", platformRole: "customer" })
    ).toThrowError(VellumError);
  });

  it("allows support_readonly to read metrics, but forbids mutation", () => {
    const platform = {
      controlStore: {
        organizations: new Map(),
        projects: new Map(),
        auditLogs: [],
        recordAuditLog: () => {},
      },
      dataStore: {
        documents: new Map(),
        indexes: new Map(),
        outbox: [],
      },
      realtimeHub: {
        connections: new Map(),
      },
    };

    const service = new PlatformAdminService({ platform });

    // Read allowed
    const metrics = service.getClusterMetrics({ id: "support_1", platformRole: "support_readonly" });
    expect(metrics.totalProjects).toBe(0);

    // Mutation rejected
    expect(() =>
      service.setProjectStatus({ id: "support_1", platformRole: "support_readonly" }, "proj_1", "suspended")
    ).toThrowError(VellumError);
  });

  describe("Privacy Invariant Enforcements", () => {
    it("strictly blocks endpoints attempting to fetch customer documents or query data", () => {
      expect(() => assertPrivacySafeEndpoint("/v1/projects/p1/documents/doc1")).toThrow(
        /Platform operator UI is strictly forbidden from requesting customer documents\.data/
      );
      expect(() => assertPrivacySafeEndpoint("/v1/projects/p1/query")).toThrow(
        /Platform operator UI is strictly forbidden from requesting customer documents\.data/
      );
      expect(() => assertPrivacySafeEndpoint("/v1/data/documents.data")).toThrow(
        /Platform operator UI is strictly forbidden from requesting customer documents\.data/
      );
      expect(() => assertPrivacySafeEndpoint("http://localhost:8080/v1/projects/p1/documents/secret")).toThrow(
        /Platform operator UI is strictly forbidden from requesting customer documents\.data/
      );

      // Safe control-plane or aggregate metadata endpoints are allowed
      expect(() => assertPrivacySafeEndpoint("/v1/admin/cluster/health")).not.toThrow();
      expect(() => assertPrivacySafeEndpoint("/v1/admin/tenants")).not.toThrow();
      expect(() => assertPrivacySafeEndpoint("/v1/admin/audit")).not.toThrow();
      expect(() => assertPrivacySafeEndpoint("/v1/admin/features")).not.toThrow();
      expect(() => assertPrivacySafeEndpoint("/v1/projects/p1/documents/metadata")).not.toThrow();
      expect(() => assertPrivacySafeEndpoint("/v1/projects/p1/documents/count")).not.toThrow();
    });

    it("strictly blocks responses containing customer document payload contents", () => {
      const validMetadata = {
        organizationId: "org_123",
        stats: { documentCount: 500, storageBytes: 1048576 },
      };
      expect(() => assertNoCustomerPayload(validMetadata)).not.toThrow();

      const leakedDocument = {
        organizationId: "org_123",
        leaked: {
          id: "doc_abc",
          version: 2,
          data: { secretUserCreditCard: "4111-2222-3333-4444" },
        },
      };
      expect(() => assertNoCustomerPayload(leakedDocument)).toThrow(
        /Runtime assertion violated: customer document payload detected in response data/
      );

      // Deeply nested inside arrays
      const nestedLeakedArray = {
        items: [
          { status: "ok" },
          { doc: { id: "d1", version: 1, data: { userSecret: "password123" } } },
        ],
      };
      expect(() => assertNoCustomerPayload(nestedLeakedArray)).toThrow(
        /Runtime assertion violated: customer document payload detected in response data/
      );
    });

    it("verifies tenant directory metadata strictly contains zero customer document data", () => {
      expect(() => assertNoCustomerPayload(metadataOnlyTenants)).not.toThrow();
      for (const t of metadataOnlyTenants) {
        expect(t).not.toHaveProperty("data");
        expect(t).toHaveProperty("id");
        expect(t).toHaveProperty("storageMb");
        expect(t).toHaveProperty("projectsCount");
      }
    });
  });
});
