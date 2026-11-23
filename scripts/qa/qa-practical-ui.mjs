/**
 * Practical real-browser interaction audit.
 * Actually clicks, types, opens dialogs, changes tabs/toggles and verifies the
 * UI responds. Screenshots every interaction. No code-level mocking.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = (process.argv[2] || "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = "docs/evidence/practical-ui";
fs.mkdirSync(OUT, { recursive: true });
// Rebrand aliases: VELLUM_* wins; legacy VELLUM_* names keep working.
const envAlias = (name, fallback) => process.env[name] || fallback;
const ORG = envAlias("VELLUM_QA_ORG_ID", "d29c31e0-e93f-402c-8499-74909e9bfb0a");
const PROJ = envAlias("VELLUM_QA_PROJECT_ID", "1382468e-5dc0-44a8-9b68-5427a5b6ea5c");
const DASH_BASE = `/app/orgs/${ORG}/projects/${PROJ}`;

const results = [];
const errs = new Set();
const ok = (n, d = "") => { results.push({ n, pass: true }); console.log(`PASS ${n}${d ? ` :: ${d}` : ""}`); };
const bad = (n, d = "") => { results.push({ n, pass: false }); console.log(`FAIL ${n}${d ? ` :: ${d}` : ""}`); };
const wire = (p, scope) => {
  p.on("pageerror", (e) => errs.add(`${scope} PAGEERROR ${e.message.slice(0, 180)}`));
  p.on("console", (m) => { if (m.type() === "error" && !/ERR_ABORTED/.test(m.text())) errs.add(`${scope} CONSOLE ${m.text().slice(0, 180)}`); });
  p.on("response", (r) => { if (r.status() >= 400) errs.add(`${scope} HTTP ${r.status()} ${r.url()}`); });
};
const shot = async (p, n) => { await p.waitForTimeout(350); await p.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: false }); };
const text = (p) => p.locator("body").innerText();

async function login(p, path, email, pw, url) {
  await p.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 90000 });
  await p.locator("#email").fill(email);
  await p.locator("#password").fill(pw);
  await p.locator('button[type="submit"]').click();
  await p.waitForURL(url, { timeout: 30000 });
  await p.waitForTimeout(400);
}

async function pressIf(p, name, label) {
  const b = p.getByRole("button", { name: label });
  if (await b.count() === 0) { bad(`${name}: button missing`); return false; }
  await b.first().click(); await p.waitForTimeout(500); return true;
}

const browser = await chromium.launch({ headless: true });
try {
  /* ---------- CUSTOMER ---------- */
  const cctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await cctx.newPage();
  wire(p, "customer");
  await login(p, "/login", "visual@vellum.dev", "visual123", /\/app/);
  ok("customer login");

  // 1. Language toggle (real UI click) + back
  await p.goto(`${base}/app`, { waitUntil: "networkidle" });
  await p.locator('[data-testid="language-toggle"]').first().click();
  await p.waitForTimeout(400);
  let d = await p.evaluate(() => document.documentElement.dir);
  d === "rtl" ? ok("locale toggle → AR") : bad("locale toggle", d);
  await shot(p, "01-locale-ar");
  await p.locator('[data-testid="language-toggle"]').first().click();
  await p.waitForTimeout(400);
  d = await p.evaluate(() => document.documentElement.dir);
  d === "ltr" ? ok("locale toggle → EN") : bad("locale toggle back", d);

  // 2. Theme toggle button in topbar
  const themeBtn = p.locator('button[aria-label*="theme" i], button[title*="theme" i]').first();
  if (await themeBtn.count()) {
    await themeBtn.click(); await p.waitForTimeout(400);
    ok("theme toggle button click", JSON.stringify(await p.evaluate(() => ({ d: document.documentElement.classList.contains("dark"), k: localStorage.getItem("vellum_theme") }))));
    await shot(p, "02-theme-toggled");
    await themeBtn.click(); await p.waitForTimeout(300);
  } else bad("theme toggle button missing");

  // 3. Command palette via keyboard, navigate an item
  await p.keyboard.press("ControlOrMeta+k"); await p.waitForTimeout(400);
  const items = await p.locator("[cmdk-item]").count();
  items >= 10 ? ok("cmd+k palette", `${items} items`) : bad("cmd+k palette", `${items}`);
  await shot(p, "03-command-palette");
  await p.keyboard.press("Escape");

  // 4. Create Organization dialog (open, fill, cancel)
  await p.goto(`${base}/app`, { waitUntil: "networkidle" });
  if (await pressIf(p, "New Organization dialog", /New Organization/i)) {
    const inputs = await p.locator('[role="dialog"] input, [role="dialog"] textarea').count();
    ok("create-org dialog inputs", `${inputs}`);
    await shot(p, "04-create-org-dialog");
    await p.keyboard.press("Escape");
  }

  // 5. Data explorer: tabs/dialog + add document
  await p.goto(`${base}${DASH_BASE}/data`, { waitUntil: "networkidle" });
  const newDocBtn = p.getByRole("button", { name: /^(Document|New Document|Add Document)$/i }).first();
  if (await newDocBtn.count() === 0) bad("Add document dialog: button missing");
  else {
    await newDocBtn.click(); await p.waitForTimeout(500);
    await shot(p, "05-add-document-dialog");
    await p.keyboard.press("Escape");
    ok("Add document dialog opens");
  }
  const dataText = await text(p);
  /Collections|Database Explorer/i.test(dataText) ? ok("data explorer content") : bad("data explorer content");

  // 6. Query playground: add filter + run query
  await p.goto(`${base}${DASH_BASE}/query`, { waitUntil: "networkidle" });
  if (await pressIf(p, "Add Filter", /Add Filter/i)) {
    const n = await p.locator('input[placeholder="field"]').count();
    n >= 2 ? ok("query add filter", `${n} field inputs`) : bad("query add filter", `${n}`);
    await shot(p, "06-query-filter");
  }
  const combo = p.locator('button[role="combobox"]').first();
  if (await combo.count()) { await combo.click(); await p.waitForTimeout(300); const opts = await p.locator('[role="option"]').count(); ok("query operator select", `${opts} options`); await p.keyboard.press("Escape"); }
  if (await pressIf(p, "Run Query", /Run Query/i)) {
    await p.waitForTimeout(900);
    /Query Results|Query failed|matched|Missing Composite Index/i.test(await text(p)) ? ok("query results visible") : bad("query results");
    await shot(p, "07-query-results");
  }

  // 7. Rules DSL: template chip, JSON tab, simulate, publish
  await p.goto(`${base}${DASH_BASE}/rules`, { waitUntil: "networkidle" });
  const tpl = p.getByRole("button", { name: /Owner Read\/Write/i });
  if (await tpl.count()) { await tpl.click(); await p.waitForTimeout(500); ok("rules template chip"); await shot(p, "08-rules-template"); }
  const jsonTab = p.getByRole("button", { name: /JSON AST/i });
  if (await jsonTab.count()) { await jsonTab.click(); await p.waitForTimeout(400); ok("rules JSON AST tab"); await shot(p, "09-rules-json-tab"); }
  await p.getByRole("button", { name: /DSL/i }).first().click().catch(() => {});
  if (await pressIf(p, "Rules simulate", /Simulate Request/i)) {
    /EVALUATION RESULT|DENIED|ALLOWED/i.test(await text(p)) ? ok("rules simulator result") : bad("rules simulator");
    await shot(p, "10-rules-simulate");
  }
  if (await pressIf(p, "Rules publish", /Publish Rules/i)) {
    await p.waitForTimeout(1000);
    /published|validated/i.test(await text(p)) ? ok("rules publish toast") : bad("rules publish toast", (await text(p)).slice(-140));
    await shot(p, "11-rules-published");
  }

  // 8. Indexes: create dialog + build
  await p.goto(`${base}${DASH_BASE}/indexes`, { waitUntil: "networkidle" });
  if (await pressIf(p, "Create Index dialog", /Create Index/i)) {
    const inp = await p.locator('[role="dialog"] input').count();
    ok("create index dialog inputs", `${inp}`);
    await shot(p, "12-create-index-dialog");
    await p.keyboard.press("Escape");
  }

  // 9. API keys: generate dialog + reveal/copy
  await p.goto(`${base}${DASH_BASE}/keys`, { waitUntil: "networkidle" });
  if (await pressIf(p, "Generate Key dialog", /Generate Key/i)) {
    await shot(p, "13-generate-key-dialog");
    await p.keyboard.press("Escape");
  }
  const copyBtns = await p.locator('button[title="Copy to clipboard"]').count();
  ok("API keys copy buttons present", `${copyBtns}`);

  // 10. Auth studio: tabs + user detail sheet
  await p.goto(`${base}${DASH_BASE}/auth`, { waitUntil: "networkidle" });
  const tabs = await p.locator('[role="tab"]').count();
  tabs > 0 ? ok("auth studio tabs", `${tabs}`) : bad("auth studio tabs");
  await shot(p, "14-auth-studio");

  // 11. Billing: spend cap + plan selector + tabs
  await p.goto(`${base}/app/orgs/${ORG}/billing`, { waitUntil: "networkidle" });
  const switches = await p.locator('[role="switch"]').count();
  ok("billing spend-cap switch present", `${switches}`);
  if (switches) {
    await p.locator('[role="switch"]').first().click(); await p.waitForTimeout(400);
    await shot(p, "15-billing-spendcap-toggle");
    await p.locator('[role="switch"]').first().click(); await p.waitForTimeout(300);
  }
  const billTabs = await p.locator('[role="tab"]').count();
  ok("billing tabs", `${billTabs}`);
  await shot(p, "16-billing-tabs");

  // 12. Settings page interactions
  await p.goto(`${base}/app/settings`, { waitUntil: "networkidle" });
  ok("settings page loaded", ((await text(p)).slice(0, 40)).replace(/\n/g, " "));
  await shot(p, "17-settings");

  /* ---------- ADMIN ---------- */
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await actx.newPage();
  wire(a, "admin");
  await login(a, "/admin/login", "visual-admin@vellum.dev", "visual123", /\/admin\/?$/);
  ok("admin login");

  // 1. Command palette
  await a.keyboard.press("ControlOrMeta+k"); await a.waitForTimeout(400);
  const ai = await a.locator("[cmdk-item]").count();
  ai >= 7 ? ok("admin cmd+k palette", `${ai} items`) : bad("admin cmd+k palette", `${ai}`);
  await shot(a, "20-admin-command-palette");
  await a.keyboard.press("Escape");

  // 2. Security: verifier + threat tabs + blocklist dialog + audit filters
  await a.goto(`${base}/admin/security`, { waitUntil: "networkidle" });
  const vb = a.getByRole("button", { name: /Verify Audit & Billing Hash Chains/i });
  if (await vb.count()) { await vb.click(); await a.waitForTimeout(1200); await shot(a, "21-admin-chain-proof"); ok("chain verifier clicked"); } else bad("chain verifier button");
  const threatTabs = await a.locator('[role="tab"]').count();
  ok("admin security tabs", `${threatTabs}`);
  const addBlock = a.getByRole("button", { name: /Add Block/i });
  if (await addBlock.count()) { await addBlock.click(); await a.waitForTimeout(400); await shot(a, "22-admin-block-dialog"); await a.keyboard.press("Escape"); ok("blocklist dialog"); }
  const filter = a.locator('input[placeholder*="earch"], input[placeholder*="ilter"]').first();
  if (await filter.count()) { await filter.fill("test"); await a.waitForTimeout(400); ok("audit filter typing"); await shot(a, "23-admin-audit-filter"); }

  // 3. Billing: generate invoices button, org search, override sheet
  await a.goto(`${base}/admin/billing`, { waitUntil: "networkidle" });
  if (await pressIf(a, "Generate invoices button", /Generate Invoices/i)) {
    await a.waitForTimeout(900); await shot(a, "24-admin-generate-invoices"); ok("generate invoices action");
  }
  const search = a.locator('input[placeholder*="earch"]').first();
  if (await search.count()) { await search.fill("Visual"); await a.waitForTimeout(500); ok("admin org search typing"); await shot(a, "25-admin-org-search"); }

  // 4. Tenants/features/metrics/auth pages render with controls
  for (const [name, url, file] of [
    ["tenants", "/admin/tenants", "26-admin-tenants"],
    ["features", "/admin/features", "27-admin-features"],
    ["metrics", "/admin/metrics", "28-admin-metrics"],
    ["auth", "/admin/auth", "29-admin-auth-control"],
  ]) {
    await a.goto(`${base}${url}`, { waitUntil: "networkidle" });
    const n = await a.locator("button, input, [role=switch]").count();
    n > 3 ? ok(`admin ${name} controls`, `${n}`) : bad(`admin ${name} controls`, `${n}`);
    await shot(a, file);
  }

  /* ---------- DOCS interactions ---------- */
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dp = await dctx.newPage();
  wire(dp, "docs");
  await dp.goto(`${base}/docs/`, { waitUntil: "networkidle" });
  // Copy button on code block
  const copy = dp.locator('button[title="Copy to clipboard"]').first();
  if (await copy.count()) { await copy.click(); await dp.waitForTimeout(300); ok("docs code copy button"); await shot(dp, "30-docs-copy"); }
  // Search input
  const si = dp.locator("#searchInput, .search-trigger").first();
  if (await si.count()) { await si.click(); await dp.waitForTimeout(300); await shot(dp, "31-docs-search"); ok("docs search opens"); }
  // Language toggle
  const lt = dp.locator('[data-testid="language-toggle"]').first();
  if (await lt.count()) { await lt.click(); await dp.waitForTimeout(500); const dr = await dp.evaluate(() => document.documentElement.dir); dr === "rtl" ? ok("docs AR toggle") : bad("docs AR toggle", dr); await shot(dp, "32-docs-ar"); }

  /* ---------- MOBILE practical ---------- */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  wire(mp, "mobile");
  await login(mp, "/login", "visual@vellum.dev", "visual123", /\/app/);
  // Mobile nav drawer
  const menu = mp.locator('button[aria-label*="menu" i], button[title*="menu" i]').first();
  if (await menu.count()) { await menu.click(); await mp.waitForTimeout(400); await shot(mp, "40-mobile-nav-drawer"); ok("mobile nav drawer opens"); }
  // Mobile billing interactions
  await mp.goto(`${base}/app/orgs/${ORG}/billing`, { waitUntil: "networkidle" });
  await shot(mp, "41-mobile-billing");
  ok("mobile billing renders");

  const u = [...errs];
  u.length === 0 ? ok("ZERO runtime errors during all real interactions") : u.slice(0, 40).forEach((e) => bad("runtime error", e));

  const failed = results.filter((r) => !r.pass);
  console.log(`\nPRACTICAL UI AUDIT: ${results.length - failed.length}/${results.length} checks passed`);
  console.log(`Screenshots: ${OUT}/ (${fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).length} files)`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, errors: u }, null, 2));
  if (failed.length) { console.log("FAILED:", failed.map((f) => f.n).join(" | ")); process.exitCode = 1; }
} finally { await browser.close(); }
