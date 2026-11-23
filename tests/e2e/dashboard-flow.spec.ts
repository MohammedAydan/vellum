import { test, expect } from "@playwright/test";
import { mockApi, seedSession, ORG_ID, PROJECT_ID } from "./helpers.js";

const projectBase = `/app/orgs/${ORG_ID}/projects/${PROJECT_ID}`;

test.describe("Customer Dashboard — every route", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await seedSession(page);
  });

  test("organization directory renders live organizations", async ({ page }) => {
    await page.goto("http://127.0.0.1:3000/app");
    await expect(page.getByText("Select Organization")).toBeVisible();
    // The tenant name also appears in the shell breadcrumb; scope to the card.
    await expect(page.getByRole("main").getByText("E2E Tenant")).toBeVisible();
  });

  test("project list renders live projects", async ({ page }) => {
    await page.goto(`http://127.0.0.1:3000/app/orgs/${ORG_ID}`);
    await expect(page.getByText("Organization Projects")).toBeVisible();
    await expect(page.getByText("E2E Project")).toBeVisible();

    await page.goto(`http://127.0.0.1:3000${projectBase}`);
    await expect(page.getByText("E2E Project")).toBeVisible();
  });

  test("usage page renders live counters", async ({ page }) => {
    await page.goto(`http://127.0.0.1:3000${projectBase}/usage`);
    await expect(page.getByRole("heading", { name: "Usage & Quotas" })).toBeVisible();
    await expect(page.getByText("LIVE DATA")).toBeVisible();
  });

  test("database explorer renders documents with virtualized table", async ({ page }) => {
    await page.goto(`http://127.0.0.1:3000${projectBase}/data`);
    await expect(page.getByRole("heading", { name: "Database Explorer" })).toBeVisible();
    await expect(page.getByText("Collections")).toBeVisible();
    // v5 renders the virtualized document table as a list of rows.
    await expect(page.getByRole("listitem").filter({ hasText: "usr_101" }).first()).toBeVisible();
  });

  test("query playground renders builders and results", async ({ page }) => {
    await page.goto(`http://127.0.0.1:3000${projectBase}/query`);
    await expect(page.getByRole("heading", { name: "Query Playground" })).toBeVisible();
    await expect(page.getByText("Visual Builder")).toBeVisible();
  });

  test("rules studio renders the DSL editor with a JSON AST tab", async ({ page }) => {
    await page.goto(`http://127.0.0.1:3000${projectBase}/rules`);
    await expect(page.getByRole("heading", { name: "Security Rules Studio" })).toBeVisible();
    // DSL mode is the default; the compiled v1 AST is available in the second tab.
    await expect(page.getByText(/rules_version = '2'/).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: /JSON AST/i })).toBeVisible();
  });

  test("index manager and API keys render live records", async ({ page }) => {
    await page.goto(`http://127.0.0.1:3000${projectBase}/indexes`);
    await expect(page.getByRole("heading", { name: "Composite Indexes" })).toBeVisible();
    await expect(page.getByText("READY")).toBeVisible();

    await page.goto(`http://127.0.0.1:3000${projectBase}/keys`);
    await expect(page.getByRole("heading", { name: "API Key Management" })).toBeVisible();
    // The key name appears in the sidebar summary and the table; scope to the table.
    await expect(page.getByRole("table").getByText("E2E Key")).toBeVisible();
  });

  test("settings renders MFA management", async ({ page }) => {
    await page.goto("http://127.0.0.1:3000/app/settings");
    await expect(page.getByText("Settings & Security")).toBeVisible();
    await expect(page.getByText("Two-Factor Authentication", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /enable mfa/i })).toBeVisible();
  });
});
