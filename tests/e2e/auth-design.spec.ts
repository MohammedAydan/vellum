import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const screens = ["login", "signup", "admin-login", "admin-setup"] as const;

for (const screen of screens) {
  for (const locale of ["en", "ar"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`${screen}: ${locale}/${theme}, 320px, accessible and no overflow`, async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 900 });
        await page.addInitScript(({ locale, theme }) => {
          localStorage.setItem("vellum.locale", locale);
          localStorage.setItem("vellum_theme", theme);
        }, { locale, theme });
        await page.route("**/v1/**", async (route) => {
          if (route.request().url().includes("setup-status")) {
            return route.fulfill({ json: {
              initialized: screen !== "admin-setup", requiresSetup: screen === "admin-setup",
              ownerCount: screen === "admin-setup" ? 0 : 1, totalUsers: 1, tokenRequired: true,
            } });
          }
          return route.fulfill({ status: 401, json: { error: { message: "Unauthenticated" } } });
        });
        const admin = screen.startsWith("admin");
        await page.goto(admin ? "http://127.0.0.1:3001/admin/login" : `http://127.0.0.1:3000/${screen}`);
        await expect(page.locator("h1")).toBeVisible();
        await expect(page.locator("input").first()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        await expect(page.locator("html")).toHaveClass(new RegExp(theme));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const input of await page.locator("input").all()) {
          await expect(input).toHaveAccessibleName(/.+/);
          expect((await input.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        }
        await page.keyboard.press("Tab");
        await expect(page.locator(":focus")).toBeVisible();
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
        expect(axe.violations).toEqual([]);
      });
    }
  }
}

for (const screen of screens) {
  test(`${screen}: submits the original auth contract`, async ({ page }) => {
    let request: { path: string; body: unknown; token?: string } | undefined;
    await page.route("**/v1/**", async (route) => {
      if (route.request().url().includes("setup-status")) {
        return route.fulfill({ json: { requiresSetup: screen === "admin-setup", tokenRequired: true } });
      }
      if (route.request().method() === "POST") {
        request = { path: new URL(route.request().url()).pathname, body: route.request().postDataJSON(), token: route.request().headers()["x-setup-token"] };
      }
      return route.fulfill({ status: 400, json: { error: { message: "Test response" } } });
    });
    const admin = screen.startsWith("admin");
    await page.goto(admin ? "http://127.0.0.1:3001/admin/login" : `http://127.0.0.1:3000/${screen}`);
    await page.locator("input").first().waitFor();
    const prefix = screen === "admin-setup" ? "setup" : "";
    if (screen === "signup") await page.locator("#name").fill("Auth Test");
    if (screen === "admin-setup") {
      await page.locator("#setupName").fill("Auth Test");
      await page.locator("#setupToken").fill("fixture-token-not-a-secret");
    }
    await page.locator(`#${prefix ? "setupEmail" : "email"}`).fill("test@example.com");
    await page.locator(`#${prefix ? "setupPassword" : "password"}`).fill("fixture-password-not-a-secret");
    await page.locator('button[type="submit"]').click();
    await expect.poll(() => request?.path).toBe({ login: "/v1/auth/sign-in/email", signup: "/v1/auth/sign-up/email", "admin-login": "/v1/admin/login", "admin-setup": "/v1/admin/setup-owner" }[screen]);
    expect(request?.body).toEqual({ email: "test@example.com", password: "fixture-password-not-a-secret", ...(["signup", "admin-setup"].includes(screen) ? { name: "Auth Test" } : {}) });
    if (screen === "admin-setup") expect(request?.token).toBe("fixture-token-not-a-secret");
  });
}
