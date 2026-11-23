import { test, expect } from "@playwright/test";
import { mockApi, seedSession, ORG_ID, PROJECT_ID } from "./helpers.js";
const host = process.env.REMEDIATION_UI_URL ?? "http://127.0.0.1:3000";
const base = `${host}/app/orgs/${ORG_ID}/projects/${PROJECT_ID}`;
test.beforeEach(async ({ page }) => {
  await mockApi(page); await seedSession(page);
  await page.addInitScript(() => { window.__VELLUM_API_BASE_URL__ = ""; localStorage.setItem("vellum.locale", "en"); });
});
for (const width of [1440, 390, 320]) test(`large import retains pointer-accessible controls at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${base}/data`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Actions for users", exact: true }).click();
  await page.getByRole("menuitem", { name: "Import JSON", exact: true }).click();
  await page.getByRole("textbox", { name: "Import JSON", exact: true }).fill(JSON.stringify(Array.from({ length: 54 }, (_, i) => ({ id: String(i), data: { text: "x".repeat(100) } })), null, 2));
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeInViewport(); await expect(page.getByRole("button", { name: "Import", exact: true })).toBeInViewport();
  await cancel.click(); await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("index select is above the dialog and accepts pointer selection", async ({ page }) => {
  await page.goto(`${base}/indexes`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Create Index", exact: true }).click();
  await page.getByRole("dialog").getByRole("combobox").first().click();
  const option = page.getByRole("option").last(); await expect(option).toBeVisible();
  const box = await option.boundingBox(); expect(box).not.toBeNull();
  expect(await option.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })).toBe(true);
  await option.click(); await expect(page.getByRole("listbox")).toHaveCount(0);
});
test("visual/raw transitions synchronize the payload and remove previous results", async ({ page }) => {
  await page.goto(`${base}/query`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Run Query", exact: true }).click();
  await expect(page.getByText("Execution Plan", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Raw JSON", exact: true }).click();
  await expect(page.getByText("Execution Plan", { exact: true })).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText('"collection": "users"');
  await page.getByRole("tab", { name: "Visual Builder", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Visual Builder", exact: true })).toHaveAttribute("aria-selected", "true");
});
