import { test, expect } from "@playwright/test";
import { mockApi, seedSession, ORG_ID, PROJECT_ID } from "./helpers.js";

const stamp = "2026-11-01T12:00:00.000Z";
const user = {
  id: "auth-user-1", email: "alice@example.invalid", emailVerified: true, displayName: "Alice Test",
  photoUrl: null, phoneNumber: null, phoneVerified: false, isDisabled: false, isAnonymous: false,
  customClaims: { role: "reader" }, metadata: {}, createdAt: stamp, updatedAt: stamp, lastSignInAt: stamp,
};
const config = {
  id: "auth-config", projectId: PROJECT_ID, authServiceSuspended: false, suspensionReason: null,
  maxUsersQuota: 1000, maxSignupsPerHour: 100, enableEmailPassword: true, requireEmailVerification: true,
  enableAnonymousAuth: false, enableTotpMfa: true, enableUserProjection: false, projectionCollectionPath: "users",
  passwordMinLength: 12, passwordRequireUppercase: true, passwordRequireNumber: true, passwordRequireSymbol: true,
  accessTokenTtlSeconds: 900, refreshTokenTtlDays: 30, jwtKeyId: "key-label", jwtPublicKeyPem: "test-public-key",
  oauthProviders: {}, hasCustomSmtpConfig: false, createdAt: stamp, updatedAt: stamp,
};

test("Auth Studio panels and dialogs survive module extraction", async ({ page }, testInfo) => {
  await mockApi(page); await seedSession(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/auth/admin/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/config")) return route.fulfill({ json: config });
    if (path.endsWith("/users/auth-user-1")) return route.fulfill({ json: {
      user, identities: [{ id: "identity", provider: "email", providerUserId: user.email, createdAt: stamp, lastSignInAt: stamp }],
      sessions: [], mfa: { enabled: false, factorType: null, enrolledAt: null },
    } });
    if (path.endsWith("/users")) return route.fulfill({ json: { users: [user], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Unmocked auth fixture route" } } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:3000/app/orgs/${ORG_ID}/projects/${PROJECT_ID}/auth`);
  await expect(page.getByText("End-User Auth Studio", { exact: true })).toBeVisible();
  await expect(page.getByText("Alice Test", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("auth-users-desktop.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Create User", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Create End User", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("auth-create-desktop.png"), fullPage: true, animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Import JSON", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Import End Users", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Sign-In Providers", exact: true }).click();
  await expect(page.getByText("Sign-In Providers", { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("auth-providers-desktop.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Configure", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Policies & Projection", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("auth-policies-desktop.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("tab", { name: "Users Directory", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.locator("#detail-email")).toHaveValue(user.email);
  await page.screenshot({ path: testInfo.outputPath("auth-inspector-mobile.png"), fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
});
