import { describe, expect, it } from "vitest";
import { DataPlaneStore } from "@vellum/storage/adapters";
import type { StructuredLogger } from "@vellum/observability";
import { listIndexesReconciled, refreshIndexRecord } from "../index-build.js";

const PROJECT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const logger = { warn() {}, info() {}, error() {}, debug() {} } as unknown as StructuredLogger;

describe("request-scoped index building", () => {
  it("moves a new index from building to ready without the periodic worker", async () => {
    const dataStore = new DataPlaneStore();
    const created = await dataStore.createCompositeIndex({ projectId: PROJECT }, "users", [
      { path: "age", dir: "asc" },
    ]);
    expect(created.status).toBe("building");
    const fresh = await refreshIndexRecord({ dataStore, logger }, PROJECT, created);
    expect(fresh.status).toBe("ready");
  });

  it("reconciles a stuck building index when the list is read, only for that project", async () => {
    const dataStore = new DataPlaneStore();
    await dataStore.createCompositeIndex({ projectId: PROJECT }, "users", [{ path: "age", dir: "asc" }]);
    await dataStore.createCompositeIndex({ projectId: OTHER }, "users", [{ path: "age", dir: "asc" }]);
    const mine = await listIndexesReconciled({ dataStore, logger }, PROJECT);
    expect(mine.map((i) => i.status)).toEqual(["ready"]);
    const theirs = await dataStore.listCompositeIndexes({ projectId: OTHER });
    expect(theirs[0]?.status).toBe("building");
  });
});
