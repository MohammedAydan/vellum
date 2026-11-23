import { test, expect } from "@playwright/test";
import { mockApi, seedSession, ORG_ID } from "./helpers.js";

test.describe("Platform Admin — every route", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await seedSession(page, true);
  });

  test("cluster overview renders live counters", async ({ page }) => {
    await page.goto("http://127.0.0.1:3001/admin/");
    await expect(page.getByText("Platform Cluster Telemetry")).toBeVisible();
    await expect(page.getByText("Tenant Organizations")).toBeVisible();
  });

  test("tenant directory and detail render live metadata", async ({ page }) => {
    await page.goto("http://127.0.0.1:3001/admin/tenants");
    await expect(page.getByRole("heading", { name: "Tenant Directory" })).toBeVisible();
    await expect(page.getByText("E2E Tenant")).toBeVisible();

    await page.goto(`http://127.0.0.1:3001/admin/tenants/${ORG_ID}`);
    await expect(page.getByText(/Tenant:/)).toBeVisible();
    await expect(page.getByText("Privacy-by-Default Enforcement Active")).toBeVisible();
  });

  test("metrics page renders", async ({ page }) => {
    await page.goto("http://127.0.0.1:3001/admin/metrics");
    await expect(page.getByText("System Performance & Latency SLAs")).toBeVisible();
  });

  test("audit explorer renders live events", async ({ page }) => {
    await page.goto("http://127.0.0.1:3001/admin/audit");
    await expect(page.getByText("Platform Audit Explorer")).toBeVisible();
    await expect(page.getByText("tenant.suspended")).toBeVisible();
  });

  test("feature flags render live flags", async ({ page }) => {
    await page.goto("http://127.0.0.1:3001/admin/features");
    await expect(page.getByText("Platform Feature Flags")).toBeVisible();
    await expect(page.getByText("E2E Flag")).toBeVisible();
  });
});
