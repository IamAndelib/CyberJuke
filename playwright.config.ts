import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the production build (vite build + vite preview) and the live,
 * read-only Firestore. In sandboxes the bundled browser may not match, so a
 * system Chromium can be used (PW_CHROMIUM_PATH, or /opt/pw-browsers if present),
 * and HTTPS_PROXY is passed to the browser while localhost bypasses it.
 */
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.PW_CHROMIUM_PATH || (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
// Playwright's `proxy` option also proxies loopback, so pass Chromium flags directly.
const args = proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=localhost;127.0.0.1'] : [];

const PORT = 4173;

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://localhost:${PORT}`,
    launchOptions: { executablePath, args },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'e2e', testMatch: /e2e\.spec\.ts/ },
    { name: 'screenshots', testMatch: /screenshots\.spec\.ts/ },
  ],
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
