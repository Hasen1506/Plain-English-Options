import { defineConfig } from "@playwright/test";
// Visual before/after screenshots (412×915 @2x) against the running e2e stack; never run in CI.
export default defineConfig({
  testDir: "tests/visual",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined, args: ["--no-proxy-server"] },
  },
});
