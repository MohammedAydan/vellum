import { test, expect } from "@playwright/test";
import { mockApi, seedSession, ORG_ID, PROJECT_ID } from "./helpers.js";

test.describe("Relations manager", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await seedSession(page);
  });

  test("lists existing rules with the cascade-impact warning", async ({ page }, testInfo) => {
    await page.goto(
      `http://127.0.0.1:3000/app/orgs/${ORG_ID}/projects/${PROJECT_ID}/relations`
    );
    await expect(page.getByText("Relation rules", { exact: true })).toBeVisible();
    await expect(page.getByText("posts", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Cascade deletes bypass security rules")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("relations-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("relations-mobile-normal.png"), fullPage: true });
  });

  test("adds a rule and saves the new version", async ({ page }, testInfo) => {
    await page.goto(
      `http://127.0.0.1:3000/app/orgs/${ORG_ID}/projects/${PROJECT_ID}/relations`
    );
    await expect(page.getByText("Relation rules", { exact: true })).toBeVisible();

    await page.locator("#relCollection").fill("likes");
    await page.locator("#relField").fill("postId");
    await page.locator("#relTarget").fill("posts");
    await page.getByRole("button", { name: /add rule/i }).click();
    await expect(page.getByText("likes", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /save rules/i }).click();
    await expect(page.getByText(/Relation rules saved/)).toBeVisible();
  });

  test("blocks a duplicate rule before saving", async ({ page }, testInfo) => {
    await page.goto(
      `http://127.0.0.1:3000/app/orgs/${ORG_ID}/projects/${PROJECT_ID}/relations`
    );
    await expect(page.getByText("Relation rules", { exact: true })).toBeVisible();

    await page.locator("#relCollection").fill("posts");
    await page.locator("#relField").fill("authorId");
    await page.getByRole("button", { name: /add rule/i }).click();
    await expect(page.getByText(/invalid or duplicates/)).toBeVisible();
  });
  test("keeps edits on conflict and reloads the latest version explicitly", async ({ page }, testInfo) => {
    let version = 3;
    await page.route("**/relation-rules", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        expect(body.expectedVersion).toBe(3);
        version = 4;
        return route.fulfill({ status: 409, json: { error: { code: "ABORTED_CONFLICT", message: "Relation rules version conflict" } } });
      }
      return route.fulfill({ json: { projectId: PROJECT_ID, version, rules: [] } });
    });
    await page.goto(`http://127.0.0.1:3000/app/orgs/${ORG_ID}/projects/${PROJECT_ID}/relations`);
    await page.locator("#relCollection").fill("likes");
    await page.locator("#relField").fill("postId");
    await page.getByRole("button", { name: /add rule/i }).click();
    await page.getByRole("button", { name: /save rules/i }).click();
    await expect(page.getByText(/changed elsewhere/)).toBeVisible();
    await expect(page.getByRole("cell", { name: "likes", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(page.getByText("v4", { exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "likes", exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("relations-mobile.png"), fullPage: true });
  });

});
