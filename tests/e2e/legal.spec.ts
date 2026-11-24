import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers.js";

test.describe("Legal pages and alpha notice", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("signup shows the alpha notice, consent line and legal links", async ({ page }, testInfo) => {
    await page.goto("http://127.0.0.1:3000/signup");
    await expect(page.getByTestId("alpha-notice")).toBeVisible();
    await expect(page.getByText("AS IS").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Privacy Policy" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Terms of Service" }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("signup-desktop.png"), fullPage: true });
  });

  test("terms and privacy pages are public and carry the full disclaimer", async ({ page }, testInfo) => {
    await page.goto("http://127.0.0.1:3000/terms");
    await expect(page.getByTestId("legal-terms")).toBeVisible();
    await expect(page.getByText("No uptime or stability guarantee")).toBeVisible();
    await expect(page.getByText("AS AVAILABLE").first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("terms-desktop.png"), fullPage: true });
    await page.goto("http://127.0.0.1:3000/privacy");
    await expect(page.getByTestId("legal-privacy")).toBeVisible();
    await expect(page.getByText("We do not sell your data").first()).toBeVisible();
  });
});
