// Secondary interaction sweep: avatar menu navigation, usage, tabs, pagination, copy buttons.
import { chromium } from "playwright";
import fs from "node:fs";
const OUT = "/home/ubuntu/projects/document-db/docs/visual-review/dashboard-interactions";
fs.mkdirSync(OUT, { recursive: true });
// Rebrand aliases: VELLUM_* wins; legacy VELLUM_* names keep working.
const envAlias = (name, fallback) => process.env[name] || fallback;
const ORG = envAlias("VELLUM_QA_ORG_ID", "d29c31e0-e93f-402c-8499-74909e9bfb0a");
const PID = envAlias("VELLUM_QA_PROJECT_ID", "1382468e-5dc0-44a8-9b68-5427a5b6ea5c");
const BASE = "http://127.0.0.1:3000";
const DASH_BASE = `/app/orgs/${ORG}/projects/${PID}`;
const auth = await fetch("http://127.0.0.1:8080/v1/auth/sign-in/email", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "visual@vellum.dev", password: "visual123" }),
}).then((r) => r.json());
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
await ctx.addInitScript((s) => {
  localStorage.setItem("vellum_console_access_token", s.token);
  localStorage.setItem("vellum_console_refresh_token", s.refreshToken ?? "");
  localStorage.setItem("vellum_console_user", JSON.stringify({ user: s.user, expiresAt: s.expiresAt }));
}, {
  user: { id: "visual", email: "visual@vellum.dev", name: "Visual Reviewer" },
  token: auth.token,
  refreshToken: auth.refreshToken,
  expiresAt: new Date(Date.now() + 604800000).toISOString(),
});
const page = await ctx.newPage();
const results = [];
const assert = (n, ok, d = "") => { results.push({ n, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? " :: " + d : ""}`); };
async function go(p) { await page.goto(`${BASE}${p}`, { waitUntil: "networkidle" }); await page.waitForTimeout(750); }

// Avatar -> Settings & Security
await go(`${DASH_BASE}/data`);
await page.getByRole("button", { name: /VI/i }).first().click(); await page.waitForTimeout(300);
await page.getByRole("menuitem", { name: /Settings & Security/i }).click(); await page.waitForTimeout(800);
assert("avatar menu -> Settings & Security navigates", page.url().includes("/app/settings"), page.url());
assert("settings page shows MFA card", (await page.locator("body").innerText()).includes("Two-Factor Authentication"));
await page.screenshot({ path: `${OUT}/after-settings-page.png` });

// Settings -> Enable MFA (setup wizard opens)
const enable = page.getByRole("button", { name: /Enable MFA/i });
if (await enable.count()) {
  await enable.click(); await page.waitForTimeout(900);
  const t = await page.locator("body").innerText();
  assert("Enable MFA opens setup wizard", /TOTP Secret|Scan or enter/i.test(t), t.slice(-160).replace(/\n+/g, " | "));
  await page.screenshot({ path: `${OUT}/after-mfa-setup.png` });
}

// Avatar -> Two-Factor route
await go(`${DASH_BASE}/data`);
await page.getByRole("button", { name: /VI/i }).first().click(); await page.waitForTimeout(300);
await page.getByRole("menuitem", { name: /Two-Factor Authentication/i }).click(); await page.waitForTimeout(700);
assert("avatar menu -> Two-Factor navigates", page.url().includes("/mfa"), page.url());

// Usage page filters/charts
await go(`/app/orgs/${ORG}/projects/${PID}/usage`);
const ubody = await page.locator("body").innerText();
assert("usage page renders metrics or empty state", /Plan Quota Allocations|No usage recorded yet/.test(ubody), ubody.slice(0, 100).replace(/\n+/g, " | "));
await page.screenshot({ path: `${OUT}/after-usage-page.png` });

// DataGrid pagination on indexes/keys
await go(`${DASH_BASE}/keys`);
const tbody = await page.locator("body").innerText();
assert("API keys page renders table or empty state", /Active Credentials|No API keys/i.test(tbody));
// Copy button toast
const copy = page.locator('button[title="Copy to clipboard"]');
if (await copy.count()) {
  await copy.first().click(); await page.waitForTimeout(400);
  const t = await page.locator("body").innerText();
  assert("copy button shows toast", /Copied to clipboard/i.test(t), t.slice(-120).replace(/\n+/g, " | "));
}

// Inspector tabs Meta -> CopyButton
await go(`${DASH_BASE}/data`);
await page.getByRole("tab", { name: /Metadata/i }).click(); await page.waitForTimeout(300);
const metaCopy = page.locator('button[title="Copy to clipboard"]');
if (await metaCopy.count()) {
  await metaCopy.first().click(); await page.waitForTimeout(400);
  assert("metadata copy button shows toast", /Copied to clipboard/i.test(await page.locator("body").innerText()));
}

// Prev/Next pagination buttons
const next = page.getByRole("button", { name: /Next/i });
if (await next.count()) {
  const beforeDisabled = await next.isDisabled();
  assert("pagination Next button present", true, `disabled=${beforeDisabled}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
await browser.close();
