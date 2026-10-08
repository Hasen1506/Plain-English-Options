import { defineConfig, devices } from "@playwright/test";

const MOCK_PORT = 8787;
const WEB_PORT = 4174;
const VENUES_PORT = 8788;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 2,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    launchOptions: {
      // local sandboxes can point at a system Chromium; CI uses Playwright's own
      executablePath: process.env.PW_CHROMIUM || undefined,
      args: ["--no-proxy-server"],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1100, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  // PW_EXTERNAL_SERVERS=1: mock + preview already running (slow sandboxes start them by hand)
  webServer: process.env.PW_EXTERNAL_SERVERS ? undefined : [
    {
      command: `node --experimental-strip-types --no-warnings tests/mock/server.ts ${MOCK_PORT}`,
      port: MOCK_PORT,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `node --experimental-strip-types --no-warnings tests/mock/venues-server.ts ${VENUES_PORT}`,
      port: VENUES_PORT,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npx vite build --mode e2e --logLevel warn && npx vite preview --mode e2e --outDir dist-e2e --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
