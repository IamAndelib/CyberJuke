import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against a test build (`vite build --mode test`: the production build plus the
 * dev-only test hooks) served by `vite preview`. The fixture in tests/fixtures stubs
 * the Cyberspace backend, the music plugin and YouTube, so nothing needs the network;
 * tests tagged @live use the real, read-only Firestore and are skipped unless
 * PW_LIVE=1 (or `--grep @live`).
 *
 * In sandboxes the bundled browser may not match, so a system Chromium can be used
 * (PW_CHROMIUM_PATH, or /opt/pw-browsers if present), and HTTPS_PROXY is passed to the
 * browser while localhost bypasses it (only @live tests leave the machine).
 */
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.PW_CHROMIUM_PATH || (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
// Playwright's `proxy` option also proxies loopback, so pass Chromium flags directly.
const args = proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=localhost;127.0.0.1'] : [];

const PORT = 4174;
// Kept under node_modules: already ignored by git and ESLint, never shipped.
const OUT = 'node_modules/.cache/cyberjuke-e2e';
const live = !!process.env.PW_LIVE;

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  grepInvert: live ? undefined : /@live/,
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://localhost:${PORT}`,
    launchOptions: { executablePath, args },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'e2e', testMatch: /e2e\/.*\.spec\.ts/ },
    { name: 'screenshots', testMatch: /screenshots\/.*\.spec\.ts/ },
  ],
  webServer: {
    command: `npx vite build --mode test --outDir ${OUT} --emptyOutDir && npx vite preview --outDir ${OUT} --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
