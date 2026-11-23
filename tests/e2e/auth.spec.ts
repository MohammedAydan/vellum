import { test, expect } from "@playwright/test";
import { mockApi, seedSession } from "./helpers.js";

test.describe("Authentication", () => {
  test("signup creates a session and redirects to /app", async ({ page }) => {
    await mockApi(page);
    await page.goto("http://127.0.0.1:3000/signup");
    await expect(page.getByText("Create your account")).toBeVisible();
    await page.getByLabel("Full Name", { exact: true }).fill("Alice Developer");
    await page.locator('input[placeholder="alice@example.com"]').fill("alice@example.com");
    await page.locator('input[type="password"]').fill("ValidSecret#2026");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/app/);
  });

  test("login redirects to /app and shows the organization directory", async ({ page }) => {
    await mockApi(page);
    await page.goto("http://127.0.0.1:3000/login");
    await expect(page.getByText("Sign in to your account")).toBeVisible();
    await page.locator('input[type="email"]').fill("e2e@vellum.dev");
    await page.locator('input[type="password"]').fill("Secret#2026");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/app/);
    await expect(page.getByText("Select Organization")).toBeVisible();
  });

  test("logout clears the session and returns to /login", async ({ page }) => {
    await mockApi(page);
    await seedSession(page);
    await page.goto("http://127.0.0.1:3000/app");
    await page.locator("header button.rounded-full").click();
    await page.getByText(/log out/i).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("MFA verification page validates the 6-digit code", async ({ page }) => {
    await mockApi(page);
    await page.goto("http://127.0.0.1:3000/mfa");
    await expect(page.getByText("Two-Factor Authentication")).toBeVisible();
    const submit = page.getByRole("button", { name: /verify code/i });
    await expect(submit).toBeDisabled();
    await page.locator("input").first().fill("123456");
    await expect(submit).toBeEnabled();
  });
});
