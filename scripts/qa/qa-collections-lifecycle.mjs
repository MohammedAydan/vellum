// Collections Lifecycle QA — real-browser (headless Chromium) click assertions.
// Run from the repo root: node scripts/qa-collections-lifecycle.mjs
//
// Proves the persisted collections registry in EN and AR:
//   create empty -> hard reload -> add document -> hard reload -> SDK/HTTP
//   auto-discovery -> clear -> hard reload -> delete (type-to-confirm) ->
//   hard reload. Every fetch of the registry asks for limit=500 because the
//   live project already holds more than the API's default page of 50.
//
// No API keys, bearer tokens or passwords are ever written to stdout.
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/home/ubuntu/projects/document-db/docs/visual-review/collections";
fs.mkdirSync(OUT, { recursive: true });

// Rebrand aliases: VELLUM_* wins; legacy VELLUM_* names keep working.
const envAlias = (name, fallback) => process.env[name] || fallback;
const API = envAlias(
  "VELLUM_ENDPOINT", "VELLUM_ENDPOINT",
  envAlias("VELLUM_API_BASE_URL",
    envAlias("VELLUM_API_BASE",
      envAlias("VELLUM_QA_API_BASE_URL", "http://127.0.0.1:8080")))
).replace(/\/+$/, "");
const BASE = envAlias("VELLUM_QA_UI_BASE_URL", "http://127.0.0.1:3000").replace(/\/+$/, "");
const ORG = envAlias("VELLUM_QA_ORG_ID", "d29c31e0-e93f-402c-8499-74909e9bfb0a");
const PID = envAlias(
  "VELLUM_PROJECT_ID", "VELLUM_PROJECT_ID",
  envAlias("VELLUM_QA_PROJECT_ID", "1382468e-5dc0-44a8-9b68-5427a5b6ea5c")
);
const DASH_BASE = `/app/orgs/${ORG}/projects/${PID}`;
const EMAIL = envAlias("VELLUM_CONSOLE_EMAIL",
  envAlias("VELLUM_QA_EMAIL", "visual@vellum.dev"));
const PASSWORD = envAlias("VELLUM_CONSOLE_PASSWORD",
  envAlias("VELLUM_QA_PASSWORD", "visual123"));
const PERSIST_COL = envAlias("VELLUM_TEST_COLLECTION", "qa_persist_col");
const SDK_COL = "qa_sdk_col";

const STRINGS = {
  en: {
    title: "Database Explorer",
    addCollection: "Add Collection",
    newDoc: "Document",
    create: "Create",
    clear: "Clear All Documents",
    delete: "Delete Collection",
    actions: (name) => `Actions for ${name}`,
  },
  ar: {
    title: "مستكشف قاعدة البيانات",
    addCollection: "إضافة مجموعة",
    newDoc: "مستند",
    create: "إنشاء",
    clear: "حذف جميع المستندات",
    delete: "حذف المجموعة",
    actions: (name) => `إجراءات ${name}`,
  },
};

const results = [];

function check(name, ok, detail = "") {
  const pass = Boolean(ok);
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function apiJson(path, method = "GET", body, headers = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
  }
  return { status: response.status, body: parsed };
}

const collectionsPath = (name) =>
  `/v1/projects/${PID}/collections/${encodeURIComponent(name)}`;

/** Session bootstrap: same three localStorage keys as the other dashboard QA scripts. */
const authResponse = await fetch(`${API}/v1/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!authResponse.ok) {
  console.error(`AUTH FAILED (HTTP ${authResponse.status})`);
  process.exit(1);
}
const auth = await authResponse.json();
if (typeof auth.token !== "string" || auth.token.length === 0) {
  console.error("AUTH FAILED (no session token)");
  process.exit(1);
}
const session = {
  token: auth.token,
  refreshToken: auth.refreshToken ?? "",
  expiresAt: new Date(Date.now() + 604800000).toISOString(),
  user: { id: "visual", email: EMAIL, name: "Visual Reviewer" },
};
const consoleHeaders = { authorization: `Bearer ${session.token}` };

/** console API key creation (never logged), used for the direct HTTP document write. */
const keyReply = await apiJson(
  `/v1/console/projects/${PID}/api-keys`,
  "POST",
  { name: "qa-collections-lifecycle", keyType: "secret" },
  consoleHeaders
);
if (keyReply.status !== 201 || typeof keyReply.body.rawKey !== "string") {
  console.error(`CONSOLE KEY PROVISION FAILED (HTTP ${keyReply.status})`);
  process.exit(1);
}
const skKey = keyReply.body.rawKey;
const skKeyId = keyReply.body.apiKey?.id ?? "";
const skHeaders = { "x-vellum-api-key": skKey };

/** Remove leftovers from an interrupted earlier QA run (silently). */
async function resetCollections() {
  for (const name of [PERSIST_COL, SDK_COL]) {
    await apiJson(collectionsPath(name), "DELETE", undefined, skHeaders).catch(() => undefined);
  }
}

function sidebarRow(page, name) {
  return page
    .locator("div.group")
    .filter({ has: page.getByRole("button", { name, exact: true }) })
    .first();
}

async function sidebarCount(page, name) {
  const badge = sidebarRow(page, name).locator(".tabular-nums").first();
  const text = (await badge.innerText()).trim();
  return Number(text);
}

async function openDialogs(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
      .filter((el) => el.getAttribute("data-state") === "open")
      .map((el) => (el.innerText || "").trim().slice(0, 100).replace(/\n+/g, " | "))
  );
}

async function hardReload(page) {
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(700);
}

async function openCollectionActions(page, name, strings) {
  await page.getByRole("button", { name: strings.actions(name), exact: true }).click();
  await page.waitForTimeout(300);
}

async function runLocale(browser, locale) {
  const strings = STRINGS[locale];
  await resetCollections();

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((seed) => {
    localStorage.setItem("vellum_console_access_token", seed.token);
    localStorage.setItem("vellum_console_refresh_token", seed.refreshToken);
    localStorage.setItem("vellum_console_user", JSON.stringify({ user: seed.user, expiresAt: seed.expiresAt }));
    localStorage.setItem("vellum.locale", seed.locale);
  }, { ...session, locale });

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(`JS ${error.message.slice(0, 160)}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !/Failed to load resource/.test(text)) {
      pageErrors.push(`console ${text.slice(0, 160)}`);
    }
  });

  const shot = (name) => page.screenshot({ path: `${OUT}/${locale}-${name}.png` });
  const prefix = locale.toUpperCase();

  try {
    await page.goto(`${BASE}${DASH_BASE}/data`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(800);
    check(`${prefix}: Data Explorer renders`, (await page.getByRole("heading", { name: strings.title }).count()) >= 1);

    // 1. Create an empty collection through the preserved QA selectors.
    await page.locator(`button[title="${strings.addCollection}"]`).click();
    await page.waitForTimeout(400);
    check(`${prefix}: Add Collection dialog opens`, (await openDialogs(page)).length >= 1);
    await page.locator("#colName").fill(PERSIST_COL);
    await page.getByRole("button", { name: new RegExp(`^${escapeRegExp(strings.addCollection)}$`) }).click();
    await page.waitForTimeout(800);
    check(`${prefix}: collection visible in sidebar after create`, (await sidebarRow(page, PERSIST_COL).count()) === 1);
    check(`${prefix}: selection pinned via ?collection=`, page.url().includes(`collection=${PERSIST_COL}`));
    await shot("01-created-empty");

    // 2. Hard reload: registration, count and ?collection= selection persist.
    await hardReload(page);
    check(`${prefix}: collection survives hard reload`, (await sidebarRow(page, PERSIST_COL).count()) === 1);
    check(`${prefix}: still selected via ?collection= after reload`, page.url().includes(`collection=${PERSIST_COL}`));
    check(`${prefix}: empty collection shows count 0`, (await sidebarCount(page, PERSIST_COL)) === 0);
    await shot("02-empty-after-reload");

    // 3. Add one document via the UI, then hard reload and assert count 1.
    await page.getByRole("button", { name: strings.newDoc, exact: true }).first().click();
    await page.waitForTimeout(400);
    check(`${prefix}: New Document dialog opens`, (await openDialogs(page)).length >= 1);
    await page.locator("#docId").fill(`qa_doc_${locale}_${Date.now().toString().slice(-5)}`);
    await page.getByRole("button", { name: strings.create, exact: true }).last().click();
    await page.waitForTimeout(800);
    check(`${prefix}: document count updates to 1`, (await sidebarCount(page, PERSIST_COL)) === 1);
    await hardReload(page);
    check(`${prefix}: document count 1 survives hard reload`, (await sidebarCount(page, PERSIST_COL)) === 1);
    await shot("03-document-after-reload");

    // 4. Direct HTTP write with an sk_ key auto-registers qa_sdk_col.
    const written = await apiJson(
      `/v1/projects/${PID}/documents/${SDK_COL}/qa_doc_http_${locale}`,
      "PUT",
      { data: { source: "qa-collections-lifecycle", locale } },
      skHeaders
    );
    check(`${prefix}: HTTP document write accepted`, written.status >= 200 && written.status < 300, `HTTP ${written.status}`);
    await hardReload(page);
    check(`${prefix}: HTTP-written collection appears in sidebar`, (await sidebarRow(page, SDK_COL).count()) === 1);
    check(`${prefix}: auto-registered collection shows count 1`, (await sidebarCount(page, SDK_COL)) === 1);
    await shot("04-auto-discovered");

    // 5. Clear All Documents: registration remains, documents are gone.
    await openCollectionActions(page, PERSIST_COL, strings);
    await page.getByRole("menuitem", { name: strings.clear }).click();
    await page.waitForTimeout(400);
    const clearDialog = page.getByRole("alertdialog");
    check(`${prefix}: Clear confirmation opens`, (await clearDialog.count()) === 1);
    await clearDialog.getByRole("button", { name: strings.clear }).click();
    await page.waitForTimeout(900);
    await hardReload(page);
    check(`${prefix}: cleared collection stays registered`, (await sidebarRow(page, PERSIST_COL).count()) === 1);
    check(`${prefix}: cleared collection shows count 0`, (await sidebarCount(page, PERSIST_COL)) === 0);
    await shot("05-cleared-after-reload");

    // 6. Delete Collection (type-to-confirm): gone permanently.
    await openCollectionActions(page, PERSIST_COL, strings);
    await page.getByRole("menuitem", { name: strings.delete }).click();
    await page.waitForTimeout(400);
    const deleteDialog = page.getByRole("alertdialog");
    check(`${prefix}: Delete confirmation opens`, (await deleteDialog.count()) === 1);
    await deleteDialog.locator(`input[placeholder="${PERSIST_COL}"]`).fill(PERSIST_COL);
    await deleteDialog.getByRole("button", { name: strings.delete }).click();
    await page.waitForTimeout(900);
    check(`${prefix}: collection disappears after delete`, (await sidebarRow(page, PERSIST_COL).count()) === 0);
    await hardReload(page);
    check(`${prefix}: deletion survives hard reload`, (await sidebarRow(page, PERSIST_COL).count()) === 0);
    await shot("06-deleted-after-reload");

    check(`${prefix}: zero JS page errors`, pageErrors.length === 0, [...new Set(pageErrors)].slice(0, 3).join(" | "));
  } catch (error) {
    check(`${prefix}: flow completed without exception`, false, (error instanceof Error ? error.message : String(error)).slice(0, 200));
    await shot("99-failure");
  } finally {
    // The HTTP-written collection is not part of the UI delete step.
    await apiJson(collectionsPath(SDK_COL), "DELETE", undefined, skHeaders).catch(() => undefined);
    await ctx.close();
  }
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  await runLocale(browser, "en");
  await runLocale(browser, "ar");
} catch (error) {
  check("QA harness completed", false, (error instanceof Error ? error.message : String(error)).slice(0, 200));
} finally {
  if (browser) await browser.close();
  if (skKeyId) {
    await apiJson(
      `/v1/console/projects/${PID}/api-keys/${encodeURIComponent(skKeyId)}`,
      "DELETE",
      undefined,
      consoleHeaders
    ).catch(() => undefined);
  }
  const failed = results.filter((result) => !result.pass);
  console.log(`\nCOLLECTIONS QA: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((result) => result.name).join(" | ")}`);
    process.exitCode = 1;
  }
}
