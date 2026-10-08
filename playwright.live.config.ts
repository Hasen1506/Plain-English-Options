// Opt-in LIVE browser tests (never in CI): the production build in Chromium against
// real venue APIs. Today: Veranta testnet through veranta-sdk, end to end in the UI.
//   npm run test:live:browser
// Behind an HTTP(S) proxy the browser uses HTTPS_PROXY (never printed).
import { defineConfig, devices } from "@playwright/test";

const px = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
let proxy: { server: string; username?: string; password?: string; bypass?: string } | undefined;
if (px) {
  const u = new URL(px);
  proxy = { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined, bypass: "127.0.0.1,localhost" };
}
const PORT = 4175;

export default defineConfig({
  testDir: "tests/live",
  testMatch: /\.browser\.ts$/,
  timeout: 45 * 60_000, // every Veranta step waits for the relayer and the fork: the whole flow can take 20+ minutes
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1100, height: 900 },
    proxy,
    ignoreHTTPSErrors: !!px,
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
  },
  // PW_EXTERNAL_SERVERS=1: `vite preview --port 4175` is already running
  webServer: process.env.PW_EXTERNAL_SERVERS ? undefined : {
    command: `npx vite build --logLevel warn && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
