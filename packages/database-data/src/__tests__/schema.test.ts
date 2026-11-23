import { describe, it, expect } from "vitest";
import { documents, documentIndexes, documentIndexEntries, realtimeOutbox } from "../schema.js";
import { INIT_DATA_PLANE_SQL } from "../rls.js";

describe("@vellum/database-data", () => {
  it("exports Drizzle schema definitions keyed on project_id only", () => {
    expect(documents).toBeDefined();
    expect(documentIndexes).toBeDefined();
    expect(documentIndexEntries).toBeDefined();
    expect(realtimeOutbox).toBeDefined();

    expect(documents.projectId).toBeDefined();
    expect(documents.path).toBeDefined();
    expect(documents.data).toBeDefined();
    expect(documents.version).toBeDefined();
    expect(documents.deletedAt).toBeDefined();
  });

  it("contains fail-closed tenant RLS SQL keyed on app.current_project_id only", () => {
    expect(INIT_DATA_PLANE_SQL).toContain("ENABLE ROW LEVEL SECURITY");
    expect(INIT_DATA_PLANE_SQL).toContain("FORCE ROW LEVEL SECURITY");
    expect(INIT_DATA_PLANE_SQL).toContain("tenant_rls_documents");
    expect(INIT_DATA_PLANE_SQL).toContain("WITH CHECK");
    expect(INIT_DATA_PLANE_SQL).toContain("app.current_project_id");
    expect(INIT_DATA_PLANE_SQL).not.toContain("environment");
    expect(INIT_DATA_PLANE_SQL).not.toContain("app.current_environment_id");
  });
});
