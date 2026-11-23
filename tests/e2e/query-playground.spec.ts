import { test, expect } from "@playwright/test";
import { mockApi, seedSession, ORG_ID, PROJECT_ID } from "./helpers.js";

test.describe("Query Playground", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await seedSession(page);
  });

  test("displays real engine indexUsed, executionTimeMs and compiledSql", async ({ page }) => {
    await page.goto(
      `http://127.0.0.1:3000/app/orgs/${ORG_ID}/projects/${PROJECT_ID}/query`
    );
    await page.getByRole("button", { name: /run query/i }).click();
    await expect(page.getByText("Execution Plan")).toBeVisible();
    await expect(page.getByText("idx_docs_data_gin_active", { exact: true })).toBeVisible();
    await expect(page.getByText("3.25 ms").first()).toBeVisible();
    await expect(page.getByText(/SELECT d\.id, d\.data FROM documents/)).toBeVisible();
  });
});
