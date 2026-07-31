import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.E2E_WEB_PORT || 4173);
const apiPort = Number(process.env.E2E_API_PORT || 4100);
const webUrl = process.env.E2E_WEB_URL || `http://127.0.0.1:${webPort}`;
const apiUrl = process.env.E2E_API_URL || `http://127.0.0.1:${apiPort}`;
const reuseExistingServer = !process.env.CI && process.env.E2E_REUSE_EXISTING_SERVER === "true";
const useWindowsServerHarness = process.platform === "win32" && !reuseExistingServer;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: useWindowsServerHarness ? "./scripts/playwright-global-setup.ts" : undefined,
  use: {
    baseURL: webUrl,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: webUrl,
          localStorage: [
            {
              name: "qf_cookie_consent",
              value: JSON.stringify({
                choice: "essential",
                version: 1,
                updatedAtUtc: "2026-07-30T00:00:00.000Z",
                expiresAtUtc: "2099-01-01T00:00:00.000Z",
              }),
            },
          ],
        },
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: useWindowsServerHarness ? undefined : [
    {
      command: "node --import tsx scripts/e2e-api-server.ts",
      url: `http://127.0.0.1:${apiPort}/v1/health`,
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      command: `node web/node_modules/vite/bin/vite.js web --host 127.0.0.1 --port ${webPort}`,
      url: webUrl,
      env: { VITE_API_BASE_URL: apiUrl },
      reuseExistingServer,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chrome",
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices["Pixel 5"] },
    },
  ],
});
