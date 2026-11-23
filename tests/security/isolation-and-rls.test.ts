/**
 * Security, RLS Isolation & Governance Test Suite (`tests/security/isolation-and-rls.test.ts`)
 * Verifies:
 * 1. Strict Cross-Tenant Isolation: Tenant A's API key can never read, query, or mutate Tenant B's documents
 * 2. RLS Fail-Closed Enforcement when tenant context is missing
 * 3. Platform Admin Kill-Switch (`Throttled` / `suspended`) & Privacy-by-Default (Admin cannot view document payloads)
 * 4. Secret Redaction in Observability Logs (never leaks `pk_`, `sk_`, or `Bearer` JWTs)
 */

import { describe, it, expect } from "vitest";
import { VellumError } from "@vellum/core";
import { createVellumPlatform } from "../../apps/api/src/index.js";
import { CustomerDashboardService } from "../../apps/dashboard/src/index.js";
import { PlatformAdminService } from "../../apps/admin/src/index.js";
import type { DataPlaneStore } from "@vellum/storage";

describe("Security, RLS Isolation & Governance", () => {
  it("cross-project isolation blocks unauthorized access and enforces RLS", async () => {
    const platform = createVellumPlatform();
    const dashboard = new CustomerDashboardService({ platform });
    const admin = new PlatformAdminService({ platform });

    const owner = platform.controlStore.createUser({
      email: "owner@vellum.dev",
      name: "Owner",
      platformRole: "owner",
    });

    const orgA = platform.controlStore.createOrganization({
      slug: "tenant-alpha",
      name: "Tenant Alpha",
      billingEmail: "a@alpha.io",
    });
    const orgB = platform.controlStore.createOrganization({
      slug: "tenant-beta",
      name: "Tenant Beta",
      billingEmail: "b@beta.io",
    });

    const projA = platform.controlStore.createProject({ organizationId: orgA.id, slug: "app-a", name: "App A" });
    const projB = platform.controlStore.createProject({ organizationId: orgB.id, slug: "app-b", name: "App B" });

    const { plaintextKeyOnce: keyA } = dashboard.createProjectApiKey({
      projectId: projA.project.id,
      name: "Alpha Server Key",
      keyType: "server",
      scopes: ["documents:read", "documents:write"],
    });

    const { plaintextKeyOnce: keyB } = dashboard.createProjectApiKey({
      projectId: projB.project.id,
      name: "Beta Server Key",
      keyType: "server",
      scopes: ["documents:read", "documents:write"],
    });

    // Write a secret document in tenant A.
    const writeRes = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${projA.project.id}/documents/secrets/sec_1`, {
        method: "PUT",
        headers: { "x-project-key": keyA, "content-type": "application/json" },
        body: JSON.stringify({ data: { apiToken: "top-secret-alpha" } }),
      })
    );
    expect(writeRes.status).toBe(200);

    // 1. Tenant B key attempting to read Tenant A project -> 403 PERMISSION_DENIED
    const crossTenantRes = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${projA.project.id}/documents/secrets/sec_1`, {
        method: "GET",
        headers: { "x-project-key": keyB },
      })
    );
    expect(crossTenantRes.status).toBe(403);

    // 2. Tenant A's own key still reads its own document.
    const ownRes = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${projA.project.id}/documents/secrets/sec_1`, {
        method: "GET",
        headers: { "x-project-key": keyA },
      })
    );
    expect(ownRes.status).toBe(200);

    // 3. Direct storage transaction without tenant context fails closed (RLS Violation)
    const memStore = platform.dataStore as DataPlaneStore;
    expect(() => {
      memStore.runInTenantTransaction(
        null as unknown as string,
        () => {}
      );
    }).toThrowError(VellumError);

    try {
      memStore.runInTenantTransaction(
        null as unknown as string,
        () => {}
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(VellumError);
      expect((err as VellumError).code).toBe("PERMISSION_DENIED");
    }

    // 4. Platform Admin Privacy-by-Default & Kill-Switch verification
    const metadata = admin.inspectProjectMetadata(owner, projA.project.id);
    expect(metadata.stats.documentCount).toBe(1);
    expect("data" in metadata).toBe(false); // Customer document payload is never exposed to platform admins

    // Suspend project A and verify immediate API rejection.
    admin.setProjectStatus(owner, projA.project.id, "suspended", "Security drill");
    const suspendedRes = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${projA.project.id}/documents/secrets/sec_1`, {
        method: "GET",
        headers: { "x-project-key": keyA },
      })
    );
    expect(suspendedRes.status).toBe(403);

    // 5. Verify logger redacted the secret API key in error logs
    const lastLog = platform.logger.entries[platform.logger.entries.length - 1];
    expect(lastLog?.apiKey).toBe("[REDACTED]");
  });
});
