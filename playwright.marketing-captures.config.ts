import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.MARKETING_CAPTURE_WEB_PORT || 4193);
const apiOrigin = process.env.MARKETING_CAPTURE_API_ORIGIN || "http://127.0.0.1:4194";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /marketing-product-captures\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${webPort}`,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node web/node_modules/vite/bin/vite.js web --host 127.0.0.1 --port ${webPort}`,
    url: `http://127.0.0.1:${webPort}`,
    env: { VITE_API_BASE_URL: apiOrigin },
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "marketing-captures", use: { ...devices["Desktop Chrome"] } }],
});
