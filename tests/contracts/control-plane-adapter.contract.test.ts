import { describe, expect, it } from "vitest";
import type { ControlPlanePort } from "@vellum/database-control";
import { ControlPlaneStore } from "@vellum/database-control/adapters";

function runControlPlaneConformanceSuite(name: string, factory: () => ControlPlanePort): void {
  describe(`ControlPlanePort conformance: ${name}`, () => {
    it("creates an organization and project under Tenant == Project without environments", async () => {
      const store = factory();
      const org = await store.createOrganization({ name: "Acme Corp", slug: "acme-corp" });
      expect(org.id).toBeTruthy();

      const { project } = await store.createProject({
        organizationId: org.id,
        name: "Production",
        slug: "production",
      });
      expect(project.organizationId).toBe(org.id);
      expect((await store.getProject(project.id)).project.id).toBe(project.id);
    });
  });
}

runControlPlaneConformanceSuite("In-Memory ControlPlaneStore", () => new ControlPlaneStore());
