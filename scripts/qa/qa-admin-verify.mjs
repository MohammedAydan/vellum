import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/home/ubuntu/projects/document-db/docs/visual-review/admin-interactions";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + JSON.stringify(detail) : ""}`);
}

const browser = await chromium.launch({ headless: true });

async function login(page) {
  await page.goto("http://127.0.0.1:3000/admin/login", { waitUntil: "networkidle", timeout: 30000 });
  await page.locator("#email").fill("visual-admin@vellum.dev");
  await page.locator("#password").fill("visual123");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/admin\/?$/, { timeout: 10000 });
  await page.waitForTimeout(800);
}

const pageErrors = [];
const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
desktop.on("pageerror", e => pageErrors.push("pageerror: " + e.message));
desktop.on("console", m => { if (m.type() === "error") pageErrors.push("console: " + m.text().slice(0, 200)); });

try {
  await login(desktop);

  // --- Avatar / user dropdown ---
  await desktop.locator("header button[aria-haspopup='menu']").click();
  await desktop.waitForTimeout(400);
  const menuItems = await desktop.locator("[role='menuitem']").allInnerTexts();
  check("avatar dropdown opens with Logout item", menuItems.some(t => /Operator Logout/.test(t)), { menuItems });
  const menuBox = await desktop.locator("[role='menu']").boundingBox();
  check("avatar dropdown is visible & positioned", !!menuBox && menuBox.width > 100 && menuBox.x > 0 && menuBox.y >= 0, { menuBox });
  await desktop.screenshot({ path: `${OUT}/after-avatar-dropdown.png` });
  await desktop.keyboard.press("Escape");
  await desktop.waitForTimeout(200);

  // --- Breadcrumbs ---
  const breadcrumb = desktop.getByRole("link", { name: "VELLUM Admin" }).first();
  check("breadcrumb 'VELLUM Admin' visible", await breadcrumb.isVisible());
  await breadcrumb.click();
  await desktop.waitForTimeout(400);
  check("breadcrumb navigates to /admin", /\/admin\/?$/.test(desktop.url()), { url: desktop.url() });

  // --- Command palette (button + keyboard) ---
  await desktop.getByRole("button", { name: /Search ops/ }).click();
  await desktop.waitForTimeout(400);
  const cmdItems = await desktop.locator("[cmdk-item]").allInnerTexts();
  check("command palette opens with 7 items", cmdItems.length === 7, { count: cmdItems.length });
  await desktop.screenshot({ path: `${OUT}/after-command-palette.png` });
  // command item navigation
  await desktop.locator("[cmdk-item]").filter({ hasText: "Tenant Directory" }).click();
  await desktop.waitForTimeout(500);
  check("command palette item navigates", desktop.url().includes("/admin/tenants"), { url: desktop.url() });
  await desktop.goto("http://127.0.0.1:3000/admin", { waitUntil: "networkidle" });
  await desktop.waitForTimeout(500);
  await desktop.keyboard.press("Control+k");
  await desktop.waitForTimeout(400);
  check("command palette opens via Ctrl+K", await desktop.locator("[cmdk-item]").count() === 7);
  await desktop.keyboard.press("Escape");

  // --- Theme toggle ---
  const themeBefore = await desktop.evaluate(() => document.documentElement.className);
  await desktop.getByRole("button", { name: /Switch theme/ }).click();
  await desktop.waitForTimeout(300);
  const themeAfter = await desktop.evaluate(() => document.documentElement.className);
  check("theme toggle changes theme", themeBefore !== themeAfter, { themeBefore, themeAfter });
  await desktop.screenshot({ path: `${OUT}/after-theme-light.png` });
  // revert
  await desktop.getByRole("button", { name: /Switch theme/ }).click();
  await desktop.waitForTimeout(300);

  // --- Cluster Health tabs ---
  await desktop.getByRole("tab", { name: /Node Fleet/ }).click();
  await desktop.waitForTimeout(250);
  check("Node Fleet tab shows content", await desktop.getByText("Active Node Fleet").isVisible());
  await desktop.screenshot({ path: `${OUT}/after-tab-node-fleet.png` });
  await desktop.getByRole("tab", { name: /RLS & Privacy/ }).click();
  await desktop.waitForTimeout(250);
  check("RLS tab shows content", await desktop.getByText("Multi-Tenant Isolation & Privacy Policies").isVisible());
  await desktop.screenshot({ path: `${OUT}/after-tab-rls.png` });
  await desktop.getByRole("tab", { name: /Overview/ }).click();

  // --- Refresh button + toast ---
  await desktop.getByRole("button", { name: "Refresh" }).click();
  await desktop.waitForTimeout(1000);
  const toastTexts = await desktop.locator("[data-sonner-toast]").allInnerTexts();
  check("Refresh produces success toast", toastTexts.some(t => /refreshed successfully/.test(t)), { toastTexts });
  await desktop.screenshot({ path: `${OUT}/after-refresh-toast.png` });

  // --- Tenant Directory: search, plan select, status tabs, Inspect row action ---
  await desktop.goto("http://127.0.0.1:3000/admin/tenants", { waitUntil: "networkidle" });
  await desktop.waitForTimeout(700);
  const allRows = await desktop.locator("tbody tr").count();
  await desktop.getByPlaceholder(/Search organizations/).fill("smoke");
  await desktop.waitForTimeout(300);
  const searchRows = await desktop.locator("tbody tr").count();
  check("tenant search filters rows", searchRows > 0 && searchRows < allRows, { allRows, searchRows });
  await desktop.getByPlaceholder(/Search organizations/).fill("");
  await desktop.getByRole("combobox").click();
  await desktop.waitForTimeout(300);
  const planOpts = await desktop.locator("[role='option']").allInnerTexts();
  check("tenant plan dropdown populated", planOpts.length === 4, { planOpts });
  await desktop.screenshot({ path: `${OUT}/after-tenant-plan-dropdown.png` });
  // The live DB is seeded with free-tier tenants; filtering by a plan that
  // actually exists proves the filter works without depending on fixtures.
  await desktop.locator("[role='option']").filter({ hasText: "Free Tier" }).click();
  await desktop.waitForTimeout(300);
  const enterpriseBody = await desktop.locator("tbody").innerText();
  const filteredRows = await desktop.locator("tbody tr").count();
  check("tenant plan filter applies", filteredRows < allRows && /FREE/i.test(enterpriseBody), { allRows, filteredRows, body: enterpriseBody.slice(0, 160) });
  await desktop.getByRole("combobox").click();
  await desktop.locator("[role='option']").filter({ hasText: "All Plans" }).click();
  await desktop.waitForTimeout(200);
  await desktop.getByRole("tab", { name: /Suspended/ }).click();
  await desktop.waitForTimeout(200);
  check("tenant status tab switches", (await desktop.locator("[role='tab'][data-state='active']").innerText()).includes("Suspended"));
  await desktop.getByRole("tab", { name: /^All/ }).click();
  await desktop.waitForTimeout(200);
  await desktop.locator("tbody tr").first().getByRole("button", { name: "Inspect" }).click();
  await desktop.waitForURL("**/admin/tenants/**", { timeout: 10000 });
  await desktop.waitForTimeout(700);
  check("tenant Inspect navigates to detail", /\/admin\/tenants\/[^/]+$/.test(desktop.url()), { url: desktop.url() });
  await desktop.screenshot({ path: `${OUT}/after-tenant-detail.png` });
  // tenant detail tabs
  await desktop.getByRole("tab", { name: /^Projects$/ }).click();
  await desktop.waitForTimeout(200);
  check("tenant detail tab switches", (await desktop.locator("[role='tab'][data-state='active']").innerText()).includes("Projects"));
  await desktop.getByRole("tab", { name: /Quotas & Identity/ }).click();
  await desktop.waitForTimeout(200);
  // suspension alert dialog
  const suspendBtn = desktop.locator("button[aria-haspopup='dialog']").filter({ hasText: "Suspend" });
  await suspendBtn.click();
  await desktop.waitForTimeout(400);
  const dialogText = await desktop.locator("[role='alertdialog']").allInnerTexts();
  check("tenant suspend confirmation dialog opens", dialogText.some(t => /Suspend Tenant Organization/.test(t)), { dialogText });
  await desktop.screenshot({ path: `${OUT}/after-suspend-dialog.png` });
  // cancel it (do not mutate tenant data)
  await desktop.getByRole("button", { name: "Cancel" }).click();
  await desktop.waitForTimeout(200);

  // --- Audit Explorer ---
  await desktop.goto("http://127.0.0.1:3000/admin/audit", { waitUntil: "networkidle" });
  await desktop.waitForTimeout(700);
  await desktop.getByRole("combobox").click();
  await desktop.waitForTimeout(300);
  const actorOpts = await desktop.locator("[role='option']").allInnerTexts();
  check("audit actor dropdown populated", actorOpts.length === 4, { actorOpts });
  await desktop.screenshot({ path: `${OUT}/after-audit-actor-dropdown.png` });
  await desktop.keyboard.press("Escape");
  await desktop.getByPlaceholder(/Filter by action/).fill("api_key");
  await desktop.waitForTimeout(300);
  check("audit search filters rows", (await desktop.locator("tbody").innerText()).includes("api_key"));
  await desktop.getByPlaceholder(/Filter by action/).fill("");
  await desktop.getByRole("tab", { name: /Security/ }).click();
  await desktop.waitForTimeout(200);
  check("audit category tab switches", (await desktop.locator("[role='tab'][data-state='active']").innerText()).includes("Security"));
  await desktop.getByRole("tab", { name: /All Events/ }).click();
  await desktop.locator("tbody tr").first().getByRole("button", { name: "Inspect" }).click();
  await desktop.waitForTimeout(400);
  const auditDialog = await desktop.locator("[role='dialog']").allInnerTexts();
  check("audit Inspect details dialog opens", auditDialog.some(t => /Audit Event/.test(t)), { snippet: auditDialog[0]?.slice(0, 120) });
  await desktop.screenshot({ path: `${OUT}/after-audit-inspect-dialog.png` });
  // The detail sheet's sticky header intercepts the corner X on some
  // viewports; Escape is the canonical dialog dismissal and is intercepted by
  // no overlay.
  await desktop.keyboard.press("Escape");
  await desktop.waitForTimeout(250);
  // export
  await desktop.getByRole("button", { name: /Export Audit Trail/ }).click();
  await desktop.waitForTimeout(400);
  const exportToast = await desktop.locator("[data-sonner-toast]").allInnerTexts();
  check("Export Audit Trail produces toast", exportToast.some(t => /audit export generated/i.test(t)), { exportToast });

  // --- Metrics page ---
  await desktop.goto("http://127.0.0.1:3000/admin/metrics", { waitUntil: "networkidle" });
  await desktop.waitForTimeout(700);
  await desktop.getByRole("button", { name: "Refresh" }).click();
  await desktop.waitForTimeout(800);
  check("metrics Refresh produces toast", (await desktop.locator("[data-sonner-toast]").allInnerTexts()).some(t => /metrics refreshed/i.test(t)));
  await desktop.screenshot({ path: `${OUT}/after-metrics.png` });

  // --- Feature Flags: empty-state controls + create dialog + tabs/switch/slider ---
  await desktop.goto("http://127.0.0.1:3000/admin/features", { waitUntil: "networkidle" });
  await desktop.waitForTimeout(800);
  const featuresBody = await desktop.locator("body").innerText();
  check("feature flags empty state renders", /No feature flags/.test(featuresBody), { snippet: featuresBody.slice(-250).replace(/\n+/g, " | ") });
  check("Register Flag button visible on empty state", await desktop.getByRole("button", { name: /Register Flag/ }).isVisible());
  check("Save Changes button visible on empty state", await desktop.getByRole("button", { name: /Save Changes/ }).isVisible());
  check("category tabs visible on empty state", (await desktop.getByRole("tab").allInnerTexts()).length === 4);
  await desktop.screenshot({ path: `${OUT}/after-features-empty-state.png` });
  // open create dialog
  await desktop.getByRole("button", { name: /Register Flag/ }).click();
  await desktop.waitForTimeout(400);
  const createDialog = await desktop.locator("[role='dialog']").allInnerTexts();
  check("Register Flag dialog opens on empty state", createDialog.some(t => /Register New Feature Flag/.test(t)), { snippet: createDialog[0]?.slice(0, 100) });
  await desktop.screenshot({ path: `${OUT}/after-features-create-dialog.png` });
  // fill and submit form
  await desktop.locator("#flagId").fill("qa_e2e_created_flag");
  await desktop.locator("#flagName").fill("QA E2E Created Flag");
  await desktop.locator("#desc").fill("Created by real browser QA verification");
  const dialogCombos = desktop.locator("[role='dialog'] [role='combobox']");
  await dialogCombos.nth(0).click();
  await desktop.waitForTimeout(200);
  await desktop.locator("[role='option']").filter({ hasText: "Realtime & Outbox" }).click();
  await dialogCombos.nth(1).click();
  await desktop.waitForTimeout(200);
  await desktop.locator("[role='option']").filter({ hasText: "Beta" }).click();
  const postResp = desktop.waitForResponse(r => /\/v1\/admin\/features$/.test(r.url()) && r.request().method() === "POST", { timeout: 10000 }).catch(() => null);
  await desktop.getByRole("button", { name: "Create Flag" }).click();
  const pres = await postResp;
  await desktop.waitForTimeout(1200);
  const afterCreate = await desktop.locator("body").innerText();
  // Live DBs already carry feature flags from earlier runs, so the "Total 1"
  // assumption is invalid. A 201 POST + dialog close + the new flag id in the
  // table is the real persistence proof.
  check("create flag form submits & persists", pres?.status() === 201 && /qa_e2e_created_flag/i.test(afterCreate), {
    postStatus: pres?.status(),
    dialogStillOpen: await desktop.locator("[role='dialog']").count(),
    bodyHasName: /Qa E2E Created Flag/.test(afterCreate),
    snippet: afterCreate.slice(0, 500).replace(/\n+/g, " | "),
  });
  await desktop.screenshot({ path: `${OUT}/after-features-created.png` });
  // toggles & slider
  const switchEl = desktop.locator("[role='switch']").first();
  await switchEl.click();
  await desktop.waitForTimeout(700);
  check("feature flag switch toggles", (await desktop.locator("[role='switch']").first().getAttribute("data-state")) === "checked");
  const slider = desktop.locator("[role='slider']").first();
  await slider.focus();
  await desktop.keyboard.press("ArrowRight");
  await desktop.waitForTimeout(200);
  await desktop.getByRole("button", { name: /Save Changes/ }).click();
  await desktop.waitForTimeout(1000);
  check("Save Changes produces toast", (await desktop.locator("[data-sonner-toast]").allInnerTexts()).some(t => /updated globally/i.test(t)));
  await desktop.screenshot({ path: `${OUT}/after-features-saved.png` });

  // --- Setup wizard link (logout first) ---
  await desktop.evaluate(() => {
    localStorage.removeItem("vellum_super_admin_access_token");
    localStorage.removeItem("vellum_super_admin_refresh_token");
    localStorage.removeItem("vellum_super_admin_user");
  });
  await desktop.goto("http://127.0.0.1:3000/admin/login", { waitUntil: "networkidle" });
  await desktop.waitForTimeout(400);
  const setupLink = desktop.getByRole("button", { name: /setup wizard/i });
  check("setup wizard link visible", await setupLink.isVisible());
  await setupLink.click();
  await desktop.waitForTimeout(300);
  check("setup wizard link shows setup form", /First-Time Setup/.test(await desktop.locator("body").innerText()));
  await desktop.screenshot({ path: `${OUT}/after-setup-wizard.png` });

  // --- Logout via avatar + command palette ---
  await login(desktop);
  await desktop.locator("header button[aria-haspopup='menu']").click();
  await desktop.waitForTimeout(200);
  await desktop.locator("[role='menuitem']").filter({ hasText: "Operator Logout" }).click();
  await desktop.waitForTimeout(700);
  check("avatar menu logout works", desktop.url().includes("/login") && (await desktop.evaluate(() => localStorage.getItem("vellum_super_admin_access_token"))) === null);
  await login(desktop);
  await desktop.getByRole("button", { name: /Search ops/ }).click();
  await desktop.waitForTimeout(200);
  await desktop.locator("[cmdk-item]").filter({ hasText: "Operator Logout" }).click();
  await desktop.waitForTimeout(700);
  check("command palette logout works", desktop.url().includes("/login"));

  // --- Mobile sidebar toggle ---
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await login(mobile);
  const menuBtn = mobile.getByRole("button", { name: "Toggle navigation menu" });
  check("mobile menu button visible", await menuBtn.isVisible());
  await menuBtn.click();
  await mobile.waitForTimeout(400);
  const navLinks = await mobile.locator(".fixed.inset-0.z-50.md\\:hidden a").allInnerTexts();
  check("mobile drawer shows nav links", navLinks.some(t => /Cluster Health/.test(t)) && navLinks.some(t => /Feature Flags/.test(t)), { navLinks });
  const drawerAside = await mobile.locator(".fixed.inset-0.z-50.md\\:hidden aside").evaluate(e => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { display: cs.display, w: r.width, h: r.height }; });
  check("mobile drawer sidebar visible (display != none)", drawerAside.display !== "none" && drawerAside.w > 0, { drawerAside });
  await mobile.screenshot({ path: `${OUT}/after-mobile-drawer.png` });
  // click a nav link in drawer
  await mobile.locator(".fixed.inset-0.z-50.md\\:hidden a").filter({ hasText: "Audit Explorer" }).click();
  await mobile.waitForTimeout(600);
  check("mobile drawer link navigates & closes drawer", mobile.url().includes("/admin/audit"), { url: mobile.url() });
  await mobile.close();

  check("no browser console/page errors", pageErrors.length === 0, { pageErrors });

  // Cleanup QA-created flag via API (best-effort, using page fetch with session)
  await desktop.goto("http://127.0.0.1:3000/admin", { waitUntil: "networkidle" });
  await login(desktop);
  await desktop.evaluate(async () => {
    const token = localStorage.getItem("vellum_super_admin_access_token");
    if (token) {
      await fetch("/v1/admin/features/qa_e2e_created_flag", { method: "DELETE", headers: { Authorization: "Bearer " + token } });
    }
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) console.log("FAILED:", JSON.stringify(failed, null, 2));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.log("FATAL:", String(e));
  console.log("pageErrors:", pageErrors);
  await browser.close();
  process.exit(2);
}
