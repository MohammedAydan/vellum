import { test, expect } from "@playwright/test";
import { mockApi, seedSession, ORG_ID, PROJECT_ID } from "./helpers.js";

const envBase = `/app/orgs/${ORG_ID}/projects/${PROJECT_ID}`;

test.describe("Visual correctness (styling & layout)", () => {
  test("login page renders the shared auth layout with design tokens", async ({ page }) => {
    await mockApi(page);
    await page.goto("http://127.0.0.1:3000/login");
    await expect(page.getByText("Your documents, queries and rules, in one place.")).toBeVisible();
    const card = page.locator(".auth-shell");
    await expect(card).toBeVisible();
    const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("dashboard shell and 3-pane explorer render borders and panels", async ({ page }) => {
    await mockApi(page);
    await seedSession(page);
    await page.goto(`http://127.0.0.1:3000${envBase}/data`);
    await expect(page.getByRole("heading", { name: "Database Explorer" })).toBeVisible();
    const borders = page.locator("[class*='border']");
    expect(await borders.count()).toBeGreaterThan(5);
    await expect(page.getByText("Collections")).toBeVisible();
    await expect(page.getByText("JSON Editor")).toBeVisible();
  });

  test("admin console renders telemetry without a fabricated privacy verification", async ({ page }) => {
    await mockApi(page);
    await seedSession(page, true);
    await page.goto("http://127.0.0.1:3001/admin/");
    await expect(page.getByRole("heading", { name: "Platform Cluster Telemetry" })).toBeVisible();
    await expect(page.getByText("Privacy Guard: Active", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Provisioned API Keys")).toBeVisible();
  });
});
