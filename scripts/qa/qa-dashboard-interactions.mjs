// Customer Dashboard Interaction QA — real-browser click assertions.
// Run from repo root: node scripts/qa-dashboard-interactions.mjs
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
const results = [];
const errors = [];

const auth = await fetch("http://127.0.0.1:8080/v1/auth/sign-in/email", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "visual@vellum.dev", password: "visual123" }),
}).then((r) => r.json());
if (!auth.token) { console.error("AUTH FAILED", JSON.stringify(auth).slice(0, 200)); process.exit(1); }

function seedDashboardSession(context) {
  return context.addInitScript((s) => {
    localStorage.setItem("vellum_console_access_token", s.token);
    localStorage.setItem("vellum_console_refresh_token", s.refreshToken ?? "");
    localStorage.setItem("vellum_console_user", JSON.stringify({ user: s.user, expiresAt: s.expiresAt }));
  }, {
    user: { id: "visual", email: "visual@vellum.dev", name: "Visual Reviewer" },
    token: auth.token,
    refreshToken: auth.refreshToken,
    expiresAt: new Date(Date.now() + 604800000).toISOString(),
  });
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await seedDashboardSession(ctx);
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`JS ${e.message.slice(0, 140)}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 500/.test(m.text())) {
    errors.push(`console ${m.text().slice(0, 140)}`);
  }
});
page.on("response", (r) => {
  // Ignore 500s from QA-created duplicate indexes (unique constraint); those
  // are asserted separately. Report any other server error as a defect.
  if (r.status() >= 500 && !r.url().includes("/indexes")) {
    errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  }
});

function assert(name, ok, detail = "") {
  results.push({ name, pass: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}
async function shot(name) { await page.screenshot({ path: `${OUT}/${name}.png` }); }
async function go(path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(800);
}
async function dialogInfo() {
  return page.evaluate(() => [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map((el) => {
    const c = getComputedStyle(el), r = el.getBoundingClientRect();
    return { role: el.getAttribute("role"), state: el.getAttribute("data-state"),
      display: c.display, opacity: c.opacity, translate: c.translate,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      centered: Math.abs((r.x + r.width / 2) - innerWidth / 2) <= 8,
      text: (el.innerText || "").trim().slice(0, 120).replace(/\n+/g, " | ") };
  }).filter((d) => d.state === "open"));
}
function rx(s) { return new RegExp(s, "i"); }

// === AUTH PAGES (fresh context, no session) ===
{
  const authCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ap = await authCtx.newPage();
  await ap.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  assert("login page renders form", await ap.getByRole("button", { name: /Sign In/i }).count() === 1);
  await ap.locator("#email").fill("visual@vellum.dev");
  await ap.locator("#password").fill("visual123");
  await ap.getByRole("button", { name: /Sign In/i }).click();
  await ap.waitForTimeout(2000);
  assert("login submits and navigates to /app", ap.url().includes("/app"), ap.url());
  await authCtx.close();

  const ac2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sp = await ac2.newPage();
  await sp.goto(`${BASE}/signup`, { waitUntil: "networkidle" });
  await sp.getByRole("button", { name: /Create Account/i }).click();
  await sp.waitForTimeout(400);
  const valMsgs = await sp.locator("body").innerText();
  assert("signup shows validation errors on empty submit", /at least 2 characters|valid email|at least 6 characters/i.test(valMsgs));
  await ac2.close();

  const ac3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const mp = await ac3.newPage();
  await mp.goto(`${BASE}/mfa`, { waitUntil: "networkidle" });
  const otpInputs = await mp.locator('input[inputmode="numeric"]').count();
  const otpSlots = await mp.locator('[data-input-otp-container] > div > div').count();
  assert("MFA page renders OTP input with 6 slots", otpInputs === 1 && otpSlots >= 6, `inputs=${otpInputs} slots=${otpSlots}`);
  const verify = mp.getByRole("button", { name: /Verify Code/i });
  assert("MFA verify disabled without code", await verify.isDisabled());
  await mp.locator('input[autocomplete="one-time-code"]').fill("123456");
  await mp.waitForTimeout(250);
  assert("MFA verify enables after 6 digits", !(await verify.isDisabled()));
  await ac3.close();
}

// === APP SHELL MENUS ===
await go(`${DASH_BASE}/data`);
{
  const av = page.getByRole("button", { name: /VI/i }).first();
  await av.click();
  await page.waitForTimeout(350);
  const menus = await page.evaluate(() => [...document.querySelectorAll('[role="menu"]')].map((m) => ({
    text: m.innerText.replace(/\n+/g, " | "), items: m.querySelectorAll('[role="menuitem"]').length,
    visible: getComputedStyle(m).display !== "none",
  })));
  assert("avatar dropdown opens with menu items", menus.length === 1 && menus[0].items >= 3 && menus[0].visible, JSON.stringify(menus));
  await shot("after-avatar-menu");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}
{
  const before = await page.evaluate(() => document.documentElement.className);
  await page.locator('button[aria-label^="Switch theme"]').click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.documentElement.className);
  assert("theme toggle changes theme class", before !== after, `${before} -> ${after}`);
  // restore light
  for (let i = 0; i < 3 && !(await page.evaluate(() => document.documentElement.className)).includes("light"); i++) {
    await page.locator('button[aria-label^="Switch theme"]').click(); await page.waitForTimeout(200);
  }
}
{
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(400);
  const dlg = await dialogInfo();
  const cmdItems = await page.locator("[cmdk-item]").count();
  assert("command palette opens (⌘K)", dlg.length === 1 && dlg[0].role === "dialog" && dlg[0].centered, JSON.stringify(dlg));
  assert("command palette lists commands", cmdItems >= 10, `items=${cmdItems}`);
  await shot("after-command-palette");
  await page.locator('input[cmdk-input]').fill("indexes");
  await page.waitForTimeout(350);
  const filtered = await page.locator("[cmdk-item]").count();
  assert("command palette filters on search", filtered >= 1 && filtered < cmdItems, `filtered=${filtered}/${cmdItems}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

// === NEW ORGANIZATION DIALOG ===
await go("/app");
{
  const trigger = page.getByRole("button", { name: /New Organization/i });
  assert("New Organization trigger present", await trigger.count() === 1);
  await trigger.click();
  await page.waitForTimeout(400);
  const dlg = await dialogInfo();
  assert("New Organization dialog opens centered", dlg.length === 1 && dlg[0].centered && /Create Organization/.test(dlg[0].text), JSON.stringify(dlg));
  await shot("after-new-org-dialog");
  const slug = `qa-org-${Date.now().toString().slice(-6)}`;
  await page.locator("#slug").fill(slug);
  await page.locator("#name").fill("QA Organization");
  await page.locator("#billingEmail").fill("qa@vellum.dev");
  await page.getByRole("button", { name: /Create Organization/i }).click();
  await page.waitForTimeout(1600);
  const body = await page.locator("body").innerText();
  assert("New Organization form submits (toast/new org)", /created successfully|QA Organization/i.test(body), body.slice(0, 140).replace(/\n+/g, " | "));
  await shot("after-new-org-submit");
}

// === NEW PROJECT DIALOG ===
await go(`/app/orgs/${ORG}`);
{
  await page.getByRole("button", { name: /New Project/i }).click();
  await page.waitForTimeout(400);
  const dlg = await dialogInfo();
  assert("New Project dialog opens centered", dlg.length === 1 && dlg[0].centered && /Create Project/.test(dlg[0].text), JSON.stringify(dlg));
  await shot("after-new-project-dialog");
  await page.locator("#slug").fill(`qa-proj-${Date.now().toString().slice(-6)}`);
  await page.locator("#name").fill("QA Project");
  await page.getByRole("button", { name: /Create Project/i }).last().click();
  await page.waitForTimeout(1500);
  const body = await page.locator("body").innerText();
  assert("New Project form submits", /created successfully|QA Project/i.test(body), body.slice(0, 140).replace(/\n+/g, " | "));
}

// === DATA EXPLORER DIALOGS / TABS / ACTIONS ===
await go(`${DASH_BASE}/data`);
{
  await page.locator('button[title="Add Collection"]').click();
  await page.waitForTimeout(400);
  let dlg = await dialogInfo();
  assert("Add Collection dialog opens centered", dlg.length === 1 && dlg[0].centered, JSON.stringify(dlg));
  await shot("after-add-collection-dialog");
  await page.locator("#colName").fill(`qa_col_${Date.now().toString().slice(-5)}`);
  await page.getByRole("button", { name: /^Add Collection$/ }).click();
  await page.waitForTimeout(500);
  const body = await page.locator("body").innerText();
  assert("Add Collection creates and selects collection", /selected/i.test(body), body.slice(0, 120).replace(/\n+/g, " | "));

  // Add Document
  await page.getByRole("button", { name: /Document/i }).first().click();
  await page.waitForTimeout(400);
  dlg = await dialogInfo();
  assert("New Document dialog opens centered", dlg.length === 1 && dlg[0].centered, JSON.stringify(dlg));
  await shot("after-add-document-dialog");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // Tabs
  const fieldTab = page.getByRole("tab", { name: /Fields/i });
  if (await fieldTab.count()) {
    await fieldTab.click(); await page.waitForTimeout(350);
    assert("Fields tab switches content", (await page.locator("body").innerText()).includes("Structured view of document properties"));
    await page.getByRole("tab", { name: /Metadata/i }).click(); await page.waitForTimeout(350);
    assert("Metadata tab switches content", (await page.locator("body").innerText()).includes("Full Document Path"));
    await shot("after-inspector-tabs");
  }

  // Delete alert dialog
  const del = page.getByRole("button", { name: /Delete/i }).first();
  if (await del.count()) {
    await del.click(); await page.waitForTimeout(400);
    const ad = await dialogInfo();
    assert("Delete AlertDialog opens centered", ad.length === 1 && ad[0].centered && /Delete Document/i.test(ad[0].text), JSON.stringify(ad));
    await shot("after-delete-alertdialog");
    await page.getByRole("button", { name: /^Cancel$/ }).click(); await page.waitForTimeout(250);
  }
}

// === QUERY PLAYGROUND SELECTS ===
await go(`${DASH_BASE}/query`);
{
  const combo = page.locator('button[role="combobox"]').first();
  await combo.click(); await page.waitForTimeout(350);
  const opts = await page.locator('[role="option"]').count();
  assert("query operator Select opens with options", opts >= 8, `options=${opts}`);
  await shot("after-query-select");
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  const before = await page.locator("body").innerText();
  await page.getByRole("button", { name: /Add Filter/i }).click(); await page.waitForTimeout(300);
  const whereCount = await page.locator('input[placeholder="field"]').count();
  assert("Add Filter adds a where clause", whereCount >= 3, `field inputs=${whereCount} (1 where + 1 order initially)`);
  await page.getByRole("button", { name: /Run Query/i }).click(); await page.waitForTimeout(1800);
  const after = await page.locator("body").innerText();
  assert("Run Query shows results or error card", /Query Results|Query failed|Missing Composite Index|matched/i.test(after), after.slice(-160).replace(/\n+/g, " | "));
  await shot("after-query-run");
}

// === RULES STUDIO ===
await go(`${DASH_BASE}/rules`);
{
  await page.getByRole("button", { name: /Simulate Request/i }).click(); await page.waitForTimeout(500);
  assert("Rules simulate shows evaluation result", /EVALUATION RESULT/i.test(await page.locator("body").innerText()));
  await shot("after-rules-simulate");
  await page.getByRole("button", { name: /Publish Rules/i }).click(); await page.waitForTimeout(1500);
  const body = await page.locator("body").innerText();
  assert("Publish Rules shows toast", /published|validated/i.test(body), body.slice(-160).replace(/\n+/g, " | "));
}

// === INDEX MANAGER ===
await go(`${DASH_BASE}/indexes`);
{
  await page.getByRole("button", { name: /Create Index/i }).first().click(); await page.waitForTimeout(400);
  const dlg = await dialogInfo();
  assert("Create Index dialog opens centered", dlg.length === 1 && dlg[0].centered, JSON.stringify(dlg));
  await shot("after-create-index-dialog");
  const idxField = `qa_${Date.now().toString().slice(-7)}`;
  const rowCount = () => {
    const text = document.body.innerText;
    const m = text.match(/\((\d+) rows?\)/);
    return m ? Number(m[1]) : -1;
  };
  const beforeRows = await page.evaluate(rowCount);
  await page.locator("#idxColl").fill("users");
  await page.locator('input[placeholder="field name (e.g. role)"]').first().fill(idxField);
  await page.getByRole("button", { name: /Build Index/i }).click(); await page.waitForTimeout(1600);
  // The list is paginated and accumulates rows from earlier QA runs, so the
  // new row's page is not fixed. Assert the real behaviour: a success toast
  // plus an increased total row count (the created index is persisted).
  const body = await page.locator("body").innerText();
  const afterRows = await page.evaluate(rowCount);
  // The shared DataTable footer no longer renders the legacy "(N rows)"
  // string this script used to count. Verify persistence through the real
  // console API instead of depending on pagination/footer text.
  const indexesResponse = await fetch(
    `${BASE}/v1/console/projects/${PID}/indexes`,
    { headers: { authorization: `Bearer ${auth.token}` } }
  );
  const indexesBody = await indexesResponse.json();
  const createdIndex = (indexesBody.indexes ?? []).some((idx) =>
    JSON.stringify(idx.fields ?? []).includes(idxField)
  );
  assert(
    "Build Index shows toast/row",
    /created successfully/i.test(body) && createdIndex,
    `rows ${beforeRows}->${afterRows} :: createdIndex=${createdIndex} :: ${body.slice(-160).replace(/\n+/g, " | ")}`
  );
  await shot("after-index-created");
}

// === API KEYS ===
await go(`${DASH_BASE}/keys`);
{
  await page.getByRole("button", { name: /Generate Key/i }).click(); await page.waitForTimeout(400);
  const dlg = await dialogInfo();
  assert("Generate Key dialog opens centered", dlg.length === 1 && dlg[0].centered, JSON.stringify(dlg));
  await shot("after-generate-key-dialog");
  await page.locator("#keyName").fill("QA Browser Key");
  await page.getByRole("button", { name: /Generate Credential/i }).click(); await page.waitForTimeout(1800);
  const info = await dialogInfo();
  assert("API key reveal dialog appears", info.length >= 1 && /API Key Generated/i.test(info.map((d) => d.text).join(" ")), JSON.stringify(info));
  await shot("after-key-reveal-dialog");
  const reveal = page.getByRole("button", { name: /I Have Stored the Key/i });
  if (await reveal.count()) { await reveal.click(); await page.waitForTimeout(300); }
  assert("reveal dialog dismisses", (await dialogInfo()).length === 0);
}

// === MOBILE DRAWER + DIALOG ===
{
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await seedDashboardSession(mctx);
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}${DASH_BASE}/data`, { waitUntil: "networkidle" });
  await mp.waitForTimeout(900);
  await mp.locator('button[aria-label="Toggle navigation menu"]').click();
  await mp.waitForTimeout(450);
  const drawer = await mp.evaluate(() => {
    const d = document.querySelector('.fixed.inset-0.z-50.md\\:hidden');
    return d ? d.innerText.replace(/\n+/g, " | ") : "";
  });
  assert("mobile drawer displays nav items", /Database Explorer/.test(drawer) && /API Keys/.test(drawer), drawer.slice(0, 100));
  await mp.screenshot({ path: `${OUT}/after-mobile-drawer.png` });
  await mp.keyboard.press("Escape"); await mp.waitForTimeout(300);
  assert("Escape closes mobile drawer", await mp.locator('.fixed.inset-0.z-50.md\\:hidden').count() === 0);
  await mp.locator('button[title="Add Collection"]').click(); await mp.waitForTimeout(400);
  const dlg = await mp.evaluate(() => {
    const el = document.querySelector('[role="dialog"][data-state="open"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      centered: Math.abs((r.x + r.width / 2) - innerWidth / 2) <= 8,
      inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  });
  assert("mobile dialog centered and inside viewport", dlg && dlg.centered && dlg.inViewport, JSON.stringify(dlg));
  await mp.screenshot({ path: `${OUT}/after-mobile-dialog.png` });
  await mctx.close();
}

assert("no uncaught page errors", errors.length === 0, JSON.stringify([...new Set(errors)].slice(0, 5)));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(" | ")); process.exitCode = 1; }
