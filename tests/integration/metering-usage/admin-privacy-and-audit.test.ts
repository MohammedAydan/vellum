/**
 * admin privacy invariant + server-side audit pagination/filtering.
 *
 * A customer document with a unique secret is written to the data plane, then
 * every admin GET endpoint is asserted not to contain that secret. The audit
 * log endpoint is additionally exercised with keyset pagination and filters.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryRevocationStore, createSessionService } from "@vellum/authorization";
import { ControlPlaneStore } from "@vellum/database-control/adapters";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { createAdminRoutes, sanitizeAdminPayload } from "../../../apps/api/src/routes/admin.js";

const PRIVATE_SECRET = "TOP_SECRET_CUSTOMER_PAYLOAD_9f3a7c";

function setup() {
  const control = new ControlPlaneStore();
  const data = new DataPlaneStore();
  const owner = control.createUser({
    email: `owner-${Math.random().toString(36).slice(2)}@example.test`,
    name: "Owner",
    platformRole: "owner",
  });
  const org = control.createOrganization({
    slug: `privacy-${Math.random().toString(36).slice(2, 9)}`,
    name: "Privacy Org",
    billingEmail: "billing@example.test",
    ownerUserId: owner.id,
  });
  const created = control.createProject({
    organizationId: org.id,
    slug: "privacy-proj",
    name: "Privacy Project",
    actorUserId: owner.id,
  });
  const sessionService = createSessionService({
    secret: "test-session-secret-with-at-least-32-chars",
    revocationStore: createInMemoryRevocationStore(),
  });
  const token = sessionService.signAccess({
    sub: owner.id,
    uid: owner.id,
    role: "owner",
    orgIds: [org.id],
  });
  const app = createAdminRoutes(control, data, sessionService);
  return { control, data, owner, org, project: created.project, app, token };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("admin privacy invariant", () => {
  it("sanitizeAdminPayload strips document data payloads", () => {
    const payload = {
      path: "private/notes/doc_1",
      collectionPath: "private/notes",
      documentId: "doc_1",
      version: 1,
      data: { secret: PRIVATE_SECRET },
      metadata: { safe: true },
    };
    const serialized = JSON.stringify(sanitizeAdminPayload(payload));
    expect(serialized).not.toContain(PRIVATE_SECRET);
    expect(serialized).not.toContain('"data"');
    expect(serialized).toContain('"safe":true');
  });

  it("no admin endpoint returns documents.data for a seeded customer document", async () => {
    const { data, org, project, app, token } = setup();
    await data.putDocument(
      { projectId: project.id },
      {
        projectId: project.id,
        path: "private/notes/doc_1",
        collectionPath: "private/notes",
        collectionGroup: "notes",
        documentId: "doc_1",
        pathDepth: 2,
        data: { secret: PRIVATE_SECRET, nested: { secret: PRIVATE_SECRET } },
        sizeBytes: 128,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      }
    );

    const paths = [
      "/admin/setup-status",
      "/admin/overview",
      "/admin/tenants",
      `/admin/tenants/${org.id}`,
      "/admin/audit-logs",
      "/admin/features",
    ];
    for (const path of paths) {
      const res = await app.request(path, { headers: auth(token) });
      expect(res.status, `GET ${path}`).toBe(200);
      const body = await res.text();
      expect(body, `GET ${path} leaked customer data`).not.toContain(PRIVATE_SECRET);
    }
  });
});

describe("audit-log pagination and filtering", () => {
  it("pages with an opaque cursor and filters by action", async () => {
    const { control, app, token } = setup();
    for (let i = 0; i < 6; i++) {
      await control.recordAuditLog({
        action: i % 2 === 0 ? "tenant.suspended" : "feature_flag.updated",
        actorType: "operator",
        metadata: { index: i },
      });
    }

    const first = await app.request("/admin/audit-logs?limit=2&envelope=true", {
      headers: auth(token),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-total-count")).toBe("7");
    expect(first.headers.get("x-has-more")).toBe("true");
    const page1 = (await first.json()) as {
      items: Array<{ id: string }>;
      total: number;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(7);
    expect(page1.nextCursor).toBeTruthy();

    const second = await app.request(
      `/admin/audit-logs?limit=2&envelope=true&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`,
      { headers: auth(token) }
    );
    const page2 = (await second.json()) as { items: Array<{ id: string }> };
    expect(page2.items).toHaveLength(2);
    expect(page2.items.map((log) => log.id)).not.toEqual(page1.items.map((log) => log.id));

    const filtered = await app.request(
      "/admin/audit-logs?action=tenant.suspended&limit=50&envelope=true",
      { headers: auth(token) }
    );
    const filteredBody = (await filtered.json()) as { items: Array<{ action: string }>; total: number };
    expect(filteredBody.total).toBe(3);
    expect(filteredBody.items.every((log) => log.action === "tenant.suspended")).toBe(true);
  });

  it("array response remains backward compatible", async () => {
    const { control, app, token } = setup();
    await control.recordAuditLog({ action: "platform.owner.initialized", actorType: "operator" });
    const res = await app.request("/admin/audit-logs", { headers: auth(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("feature flag CRUD", () => {
  it("creates, updates and deletes a flag with audit entries", async () => {
    const { control, app, token } = setup();
    const created = await app.request(
      "/admin/features",
      {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ key: "new.checkout", enabled: false, rolloutPercent: 10 }),
      }
    );
    expect(created.status).toBe(201);

    const updated = await app.request(
      "/admin/features/new.checkout",
      {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, rolloutPercent: 50 }),
      }
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { enabled: boolean }).enabled).toBe(true);

    const deleted = await app.request("/admin/features/new.checkout", {
      method: "DELETE",
      headers: auth(token),
    });
    expect(deleted.status).toBe(200);

    const logs = control.auditLogs.map((log) => log.action);
    expect(logs).toContain("feature_flag.created");
    expect(logs).toContain("feature_flag.updated");
    expect(logs).toContain("feature_flag.deleted");
  });
});
