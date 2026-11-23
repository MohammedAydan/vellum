import { test, expect } from "@playwright/test";
import { mockApi, seedSession, ORG_ID, PROJECT_ID } from "./helpers.js";

test.describe("Security Rules Studio", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await seedSession(page);
  });

  test("simulates a request and publishes the v1 AST", async ({ page }) => {
    await page.goto(
      `http://127.0.0.1:3000/app/orgs/${ORG_ID}/projects/${PROJECT_ID}/rules`
    );
    await expect(page.getByText("Rule Simulator")).toBeVisible();
    await page.getByRole("button", { name: /simulate request/i }).click();
    await expect(page.getByText("Evaluation Result")).toBeVisible();

    await page.getByRole("button", { name: /publish rules/i }).click();
    await expect(page.getByText(/Security rules validated and published/)).toBeVisible();
  });
});
