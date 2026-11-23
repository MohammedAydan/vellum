import { describe, it, expect } from "vitest";
import { ControlPlaneStore } from "../memory-store.js";
import { users, organizations, projects, projectAuthConfigs, apiKeys, securityRulesets } from "../schema.js";
import { createControlDb } from "../client.js";
import { VellumError } from "@vellum/core";

describe("@vellum/database-control", () => {
  describe("ControlPlaneStore (Memory)", () => {
    it("creates a user", () => {
      const store = new ControlPlaneStore();
      const user = store.createUser({ email: "alice@example.com", name: "Alice" });
      expect(user.id).toBeDefined();
      expect(user.email).toBe("alice@example.com");
      expect(user.platformRole).toBe("customer");
      expect(user.isSuspended).toBe(false);
    });

    it("creates an organization and validates slug", () => {
      const store = new ControlPlaneStore();
      const user = store.createUser({ email: "bob@example.com", name: "Bob" });

      const org = store.createOrganization({
        slug: "acme-corp",
        name: "Acme Corp",
        billingEmail: "billing@acme.com",
        ownerUserId: user.id,
      });

      expect(org.slug).toBe("acme-corp");
      expect(store.organizationMembers.get(`${org.id}:${user.id}`)?.role).toBe("owner");

      expect(() =>
        store.createOrganization({
          slug: "INVALID SLUG!",
          name: "Bad Org",
          billingEmail: "bad@acme.com",
        })
      ).toThrow(VellumError);
    });

    it("creates a project as the only tenant record", () => {
      const store = new ControlPlaneStore();
      const org = store.createOrganization({
        slug: "acme",
        name: "Acme",
        billingEmail: "billing@acme.com",
      });

      const { project } = store.createProject({
        organizationId: org.id,
        slug: "web-app",
        name: "Web App",
      });

      expect(project.id).toBeDefined();
      expect(project.organizationId).toBe(org.id);
      expect(store.projects.size).toBe(1);

      // Project lookup is synchronous and fails closed for unknown ids.
      expect(store.getProject(project.id).project.id).toBe(project.id);
      expect(() => store.getProject("missing-project")).toThrow(VellumError);

      // Audit log was recorded
      expect(store.auditLogs.some((l) => l.action === "project.created")).toBe(true);
    });

    it("registers and revokes API keys", () => {
      const store = new ControlPlaneStore();
      const org = store.createOrganization({ slug: "acme", name: "Acme", billingEmail: "b@a.com" });
      const { project } = store.createProject({ organizationId: org.id, slug: "app", name: "App" });

      const key = store.registerApiKey({
        projectId: project.id,
        name: "Key",
        keyType: "publishable",
        keyPrefix: "pk_dev_test123",
        secretHash: "hash123",
      });

      expect(store.apiKeysByPrefix.get("pk_dev_test123")).toBeDefined();
      expect(store.auditLogs.some((l) => l.action === "api_key.created")).toBe(true);

      // Revoke
      store.revokeApiKey(key.id);
      expect(store.apiKeysByPrefix.get("pk_dev_test123")).toBeUndefined();
      expect(store.auditLogs.some((l) => l.action === "api_key.revoked")).toBe(true);
    });

    it("publishes versioned security rulesets", () => {
      const store = new ControlPlaneStore();
      const org = store.createOrganization({ slug: "acme", name: "Acme", billingEmail: "b@a.com" });
      const { project } = store.createProject({ organizationId: org.id, slug: "app", name: "App" });

      const r1 = store.publishSecurityRuleset({
        projectId: project.id,
        rulesAst: { allow: true },
      });
      expect(r1.version).toBe(1);
      expect(r1.isActive).toBe(true);
      expect(store.getActiveRuleset(project.id)?.id).toBe(r1.id);

      const r2 = store.publishSecurityRuleset({
        projectId: project.id,
        rulesAst: { allow: false },
      });
      expect(r2.version).toBe(2);
      expect(r2.isActive).toBe(true);
      expect(r1.isActive).toBe(false);
      expect(store.getActiveRuleset(project.id)?.version).toBe(2);
    });

    it("tracks and increments usage counters", () => {
      const store = new ControlPlaneStore();
      const usage = store.incrementUsage("proj_1", {
        documentReads: 10,
        documentWrites: 2,
        storageBytesDelta: 1024,
      });

      expect(usage.documentReads).toBe(10);
      expect(usage.documentWrites).toBe(2);
      expect(usage.storageBytes).toBe(1024);

      const usage2 = store.incrementUsage("proj_1", {
        documentReads: 5,
      });
      expect(usage2.documentReads).toBe(15);
    });
  });

  describe("Drizzle Schema & Client", () => {
    it("exports all tables matching Section 5", () => {
      expect(users).toBeDefined();
      expect(organizations).toBeDefined();
      expect(projects).toBeDefined();
      expect(projectAuthConfigs).toBeDefined();
      expect(apiKeys).toBeDefined();
      expect(securityRulesets).toBeDefined();
    });

    it("creates dual-mode client factory", async () => {
      const { db, close } = createControlDb({
        connectionString: "postgresql://vellum_control:control_secret@localhost:5432/control_db",
        driver: "pg",
      });
      expect(db).toBeDefined();
      await close();

      const neonRes = createControlDb({
        connectionString: "postgresql://user:pass@ep-cool-project.us-east-2.aws.neon.tech/control_db",
        driver: "neon",
      });
      expect(neonRes.db).toBeDefined();
      await neonRes.close();

      const { getControlDb, closeControlDb } = await import("../client.js");
      const db1 = getControlDb({
        connectionString: "postgresql://vellum_control:control_secret@localhost:5432/control_db",
        driver: "pg",
      });
      const db2 = getControlDb();
      expect(db1).toBe(db2);
      await closeControlDb();
    });
  });
});
