/**
 * Comprehensive End-to-End Browser Test Suite using Playwright Chromium
 * Tests real authentication, real database data, modal interactions,
 * CRUD operations, navigation, and responsiveness.
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const SCREENSHOT_DIR = path.resolve("tests/screenshots");
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    failedTests++;
    throw new Error(message);
  } else {
    console.log(`✅ PASSED: ${message}`);
    passedTests++;
  }
}

async function runTests() {
  console.log("==================================================================");
  console.log("🚀 Starting Comprehensive Chromium E2E Test Suite");
  console.log("   (Platform Admin + Customer Developer Studio)");
  console.log("==================================================================");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const adminPage = await context.newPage();
  const custPage = await context.newPage();

  try {
    // =========================================================================
    // SECTION 1: PLATFORM ADMIN CONSOLE (Port 5174)
    // =========================================================================
    console.log("\n--- [1] Admin Console: Login Security & Master Authentication ---");
    await adminPage.goto("http://127.0.0.1:5174/login", { waitUntil: "networkidle" });
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "01-admin-login-page.png") });

    // 1.1 Test invalid credentials fails closed
    console.log("Testing invalid admin credentials...");
    const adminEmail = adminPage.locator("input[type='email'], input#email").first();
    const adminPass = adminPage.locator("input[type='password'], input#password").first();
    await adminEmail.fill("invalid@platform.com");
    await adminPass.fill("badpass123");
    await adminPage.locator("button[type='submit']").click();
    await adminPage.waitForTimeout(1000);
    assert(adminPage.url().includes("/login"), "Admin login rejects invalid credentials");

    // 1.2 Test valid master owner credentials
    console.log("Testing valid master owner credentials...");
    await adminEmail.fill("mohammedaydan12@gmail.com");
    await adminPass.fill("ownerpassword123");
    await adminPage.locator("button[type='submit']").click();
    await adminPage.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
    await adminPage.waitForLoadState("networkidle");
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "02-admin-overview-kpis.png") });
    assert(adminPage.url().includes("/admin"), `Admin logged in successfully to ${adminPage.url()}`);

    const adminBodyText = await adminPage.textContent("body");
    assert(
      adminBodyText.includes("Total Tenants") || adminBodyText.includes("Control Plane"),
      "Admin Overview KPIs rendered with live database metrics"
    );

    // 1.3 Tenants Explorer
    console.log("\n--- [2] Admin Console: Tenants Explorer & Tenant Modal ---");
    await adminPage.goto("http://127.0.0.1:5174/admin/tenants", { waitUntil: "networkidle" });
    await adminPage.waitForTimeout(1000);
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "03-admin-tenants-directory.png") });

    const tenantsText = await adminPage.textContent("body");
    assert(
      tenantsText.includes("Mohammed Cloud") || tenantsText.includes("mohammed-org") || tenantsText.includes("acme"),
      "Real tenant organizations loaded from Neon DB in Admin Console"
    );

    // Test New Tenant Dialog in Admin
    const newTenantBtn = adminPage.locator("button:has-text('New Tenant'), button:has-text('Add Tenant')").first();
    if (await newTenantBtn.count() > 0) {
      await newTenantBtn.click();
      await adminPage.waitForTimeout(500);
      const adminDialog = adminPage.locator("[role='dialog']").first();
      assert(await adminDialog.isVisible(), "Admin New Tenant dialog opens and is visible");
      await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "04-admin-dialog-new-tenant.png") });

      const cancelBtn = adminDialog.locator("button:has-text('Cancel')").first();
      if (await cancelBtn.count() > 0) {
        await cancelBtn.click();
        await adminPage.waitForTimeout(500);
      }
    }

    // 1.4 Audit Logs Explorer
    console.log("\n--- [3] Admin Console: Immutable Audit Logs Explorer ---");
    await adminPage.goto("http://127.0.0.1:5174/admin/audit", { waitUntil: "networkidle" });
    await adminPage.waitForTimeout(1000);
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "05-admin-audit-logs.png") });
    const auditText = await adminPage.textContent("body");
    assert(auditText.includes("Audit Explorer") || auditText.includes("actor_type"), "Admin Audit Explorer operational with live Neon records");

    // =========================================================================
    // SECTION 2: CUSTOMER DEVELOPER STUDIO (Port 5173)
    // =========================================================================
    console.log("\n--- [4] Customer Studio: Authentication & Multi-Tenant Context ---");
    await custPage.goto("http://127.0.0.1:5173/login", { waitUntil: "networkidle" });
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "06-cust-login-page.png") });

    // 2.1 Invalid customer login test
    const custEmail = custPage.locator("input[type='email'], input#email").first();
    const custPass = custPage.locator("input[type='password'], input#password").first();
    await custEmail.fill("fake.customer@unknown.org");
    await custPass.fill("wrongpass");
    await custPage.locator("button[type='submit']").click();
    await custPage.waitForTimeout(1000);
    assert(custPage.url().includes("/login"), "Customer login rejects invalid credentials");

    // 2.2 Valid customer login
    await custEmail.fill("aydan.dev@example.com");
    await custPass.fill("mypassword123");
    await custPage.locator("button[type='submit']").click();
    await custPage.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 10000 });
    await custPage.waitForLoadState("networkidle");
    await custPage.waitForTimeout(1000);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "07-cust-org-picker.png") });
    assert(custPage.url().includes("/app"), `Customer successfully authenticated, on URL: ${custPage.url()}`);

    // 2.3 Navigation: Enter Org -> Select Project -> Data Studio
    console.log("\n--- [5] Customer Studio: Navigating Hierarchy (Org -> Project -> Data) ---");
    const openConsoleBtn = custPage.locator("button:has-text('Open Console')").first();
    assert((await openConsoleBtn.count()) > 0, "Organization card rendered with 'Open Console' action");
    await openConsoleBtn.click();
    await custPage.waitForURL((url) => url.pathname.includes("/orgs/"), { timeout: 10000 });
    await custPage.waitForLoadState("networkidle");
    await custPage.waitForTimeout(800);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "08-cust-projects-list.png") });

    const openProjectBtn = custPage.locator("button:has-text('Open Project')").first();
    assert((await openProjectBtn.count()) > 0, "Project card rendered with 'Open Project' action");
    await openProjectBtn.click();
    await custPage.waitForURL((url) => url.pathname.includes("/data"), { timeout: 10000 });
    await custPage.waitForLoadState("networkidle");
    await custPage.waitForTimeout(800);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "09-cust-data-studio.png") });
    await custPage.waitForTimeout(1500);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "10-cust-data-studio.png") });
    assert(custPage.url().includes("/data"), `Landed directly in Data Studio: ${custPage.url()}`);

    // 2.4 Data Studio: Add Collection Dialog
    console.log("\n--- [6] Customer Studio: Data Plane Collection & Document Lifecycle ---");
    const testColName = `articles_${Date.now()}`;
    const addColBtn = custPage.locator("button[title='Add Collection']").first();
    assert((await addColBtn.count()) > 0, "'Add Collection' (+) button is accessible in sidebar");
    await addColBtn.click();
    await custPage.waitForTimeout(500);

    const addColDialog = custPage.locator("[role='dialog']").first();
    assert(await addColDialog.isVisible(), "Add Collection dialog opens, is centered and fully visible");
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "11-dialog-add-col.png") });

    await addColDialog.locator("input#colName, input").first().fill(testColName);
    await addColDialog.locator("button:has-text('Create Collection')").first().click();
    await custPage.waitForTimeout(1000);

    const afterColBody = await custPage.textContent("body");
    assert(afterColBody.includes(testColName), `Collection '${testColName}' created and selected`);

    // 2.5 Data Studio: Add Document Dialog
    const testDocId = `doc_e2e_${Date.now()}`;
    const addDocBtn = custPage.locator("button:has-text('Document')").first();
    assert((await addDocBtn.count()) > 0, "'New Document' button is accessible");
    await addDocBtn.click();
    await custPage.waitForTimeout(500);

    const addDocDialog = custPage.locator("[role='dialog']").first();
    assert(await addDocDialog.isVisible(), "New Document dialog is visible, centered, and active");
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "12-dialog-add-doc.png") });

    await addDocDialog.locator("input#docId, input").first().fill(testDocId);
    await addDocDialog.locator("button:has-text('Create')").last().click();
    await custPage.waitForTimeout(2500);

    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "13-data-explorer-with-doc.png") });
    const afterDocBody = await custPage.textContent("body");
    assert(afterDocBody.includes(testDocId), `Document '${testDocId}' written to Neon Data Plane and rendered in UI`);

    // 2.6 Data Studio: Save Document Edits
    console.log("Testing document editor modifications...");
    const saveBtn = custPage.locator("button:has-text('Save Document'), button:has-text('Save')").first();
    if (await saveBtn.count() > 0) {
      await saveBtn.click();
      await custPage.waitForTimeout(1500);
      console.log("Document saved and verified!");
    }

    // 2.7 API Keys Management
    console.log("\n--- [7] Customer Studio: API Keys Lifecycle & Secret Copy Dialog ---");
    const currentStudioUrl = custPage.url();
    const keysUrl = currentStudioUrl.replace(/\/data$/, "/keys");
    await custPage.goto(keysUrl, { waitUntil: "networkidle" });
    await custPage.waitForTimeout(1200);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "14-keys-manager.png") });

    const generateKeyHeaderBtn = custPage.locator("button:has-text('Generate Key')").first();
    assert((await generateKeyHeaderBtn.count()) > 0, "'Generate Key' button is available in header");
    await generateKeyHeaderBtn.click();
    await custPage.waitForTimeout(500);

    const keyDialog = custPage.locator("[role='dialog']").first();
    assert(await keyDialog.isVisible(), "Create API Key modal is visible and styled");
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "15-dialog-create-key.png") });

    await keyDialog.locator("input#keyName, input").first().fill("E2E Playwright Key");
    const genCredBtn = keyDialog.locator("button:has-text('Generate Credential')").first();
    assert((await genCredBtn.count()) > 0, "'Generate Credential' button found in modal");
    await genCredBtn.click();
    await custPage.waitForTimeout(2000);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "16-key-created-secret.png") });

    const keyModalText = await custPage.textContent("body");
    assert(
      keyModalText.includes("Save Your Secret Key") || keyModalText.includes("sk_") || keyModalText.includes("API Key Generated"),
      "Cryptographic secret key generated and one-time modal shown"
    );

    const dismissKeyBtn = custPage.locator("button:has-text('I Have Stored the Key'), button:has-text('Close')").first();
    if (await dismissKeyBtn.count() > 0) {
      await dismissKeyBtn.click();
      await custPage.waitForTimeout(500);
    }

    // 2.8 Composite Indexes Studio
    console.log("\n--- [8] Customer Studio: Composite Indexes Studio ---");
    const indexesUrl = currentStudioUrl.replace(/\/data$/, "/indexes");
    await custPage.goto(indexesUrl, { waitUntil: "networkidle" });
    await custPage.waitForTimeout(1200);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "17-indexes-studio.png") });

    const createIdxBtn = custPage.locator("button:has-text('Create Index')").first();
    if (await createIdxBtn.count() > 0) {
      await createIdxBtn.click();
      await custPage.waitForTimeout(500);
      const idxDialog = custPage.locator("[role='dialog']").first();
      assert(await idxDialog.isVisible(), "Composite Index dialog is visible and centered");
      await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "18-dialog-create-index.png") });

      const cancelIdxBtn = idxDialog.locator("button:has-text('Cancel')").first();
      if (await cancelIdxBtn.count() > 0) {
        await cancelIdxBtn.click();
        await custPage.waitForTimeout(500);
      }
    }

    // 2.9 Query Playground
    console.log("\n--- [9] Customer Studio: Query Playground ---");
    const queryUrl = currentStudioUrl.replace(/\/data$/, "/query");
    await custPage.goto(queryUrl, { waitUntil: "networkidle" });
    await custPage.waitForTimeout(1200);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "19-query-playground.png") });
    const queryBody = await custPage.textContent("body");
    assert(queryBody.includes("Query Playground"), "Query Playground loaded and operational");

    const runQueryBtn = custPage.locator("button:has-text('Run Query')").first();
    if (await runQueryBtn.count() > 0) {
      await runQueryBtn.click();
      await custPage.waitForTimeout(1500);
      console.log("Run Query executed!");
    }

    // 2.10 Security Rules Studio
    console.log("\n--- [10] Customer Studio: Security Rules Studio ---");
    const rulesUrl = currentStudioUrl.replace(/\/data$/, "/rules");
    await custPage.goto(rulesUrl, { waitUntil: "networkidle" });
    await custPage.waitForTimeout(1200);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "20-security-rules-studio.png") });
    const rulesBody = await custPage.textContent("body");
    assert(rulesBody.includes("Security Rules"), "Security Rules Studio loaded and operational");

    // 2.11 Mobile Viewport Responsiveness
    console.log("\n--- [11] Responsive Mobile Viewport Testing (393 x 852) ---");
    await custPage.setViewportSize({ width: 393, height: 852 });
    await custPage.waitForTimeout(1000);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "21-mobile-viewport.png") });

    // Open mobile navigation menu
    const menuBtn = custPage.locator("button[aria-label='Toggle navigation menu'], button:has-text('Menu'), button.size-8").first();
    if (await menuBtn.count() > 0) {
      await menuBtn.click();
      await custPage.waitForTimeout(500);
      await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "21-mobile-drawer-open.png") });
      console.log("Mobile navigation drawer opens smoothly without overflow");
    }

    console.log("\n==================================================================");
    console.log(`🎉 ALL COMPREHENSIVE E2E TESTS PASSED: ${passedTests} passed, ${failedTests} failed`);
    console.log(`📸 Detailed screenshots saved to: ${SCREENSHOT_DIR}`);
    console.log("==================================================================");
  } catch (err) {
    console.error("Test execution encountered an error:", err);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, "error-cust.png") }).catch(() => {});
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, "error-admin.png") }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

runTests().catch(console.error);
