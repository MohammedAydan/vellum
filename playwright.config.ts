import { defineConfig, devices } from "@playwright/test";

/**
 * `pnpm` is not guaranteed to be on PATH in every environment (locally it is
 * only reachable through corepack). Resolve the package manager portably so the
 * preview servers start the same way the rest of the monorepo's scripts do.
 */
const pm = "corepack pnpm";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    trace: "on-first-retry",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `${pm} --filter @vellum/dashboard preview --port 3000 --host 127.0.0.1`,
      url: "http://127.0.0.1:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: `${pm} --filter @vellum/admin preview --port 3001 --host 127.0.0.1`,
      url: "http://127.0.0.1:3001",
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
});
