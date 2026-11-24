import { defineConfig, devices } from "@playwright/test";

/** Real-browser SDK compatibility matrix: Chromium, Firefox and WebKit. */
export default defineConfig({
  testDir: "./tests/compat-browser",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4510", headless: true },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node tests/compat-browser/mock-server.mjs",
    url: "http://127.0.0.1:4510",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
