/**
 * The shared Playwright fixture. Every test gets, by default:
 * - the fake Cyberspace backend (Firestore runQuery over a synthetic Jukebox, and the
 *   Firebase login): `backend`, configured with `test.use({ backendOptions })`;
 * - the fake JukeMusic plugin (Global search, artist pages, lyrics):
 *   `test.use({ musicOptions })`, or `musicOptions: false` for none;
 * - stand-ins for YouTube thumbnails and the IFrame player;
 * - checks after the test: no CSP violation and no uncaught page error.
 * `test.use({ live: true })` (only in @live tests) talks to the real Firestore instead.
 */
import { test as base, expect } from '@playwright/test';
import { stubBackend, type Backend, type BackendOptions } from './backend';
import { stubMusic, type MusicStubOptions } from './music';
import { stubYouTube } from './youtube';

export { expect };
export { ATTACHMENT_ONLY_GENRE, AUTH_USER, BANNED_POST, MEMBERS_POSTS } from './data';
export type { Backend } from './backend';

interface Options {
  backendOptions: BackendOptions;
  musicOptions: MusicStubOptions | false;
  live: boolean;
  /** Uncaught page errors matching these are tolerated (a test that causes one on purpose). */
  allowPageErrors: RegExp[];
}

interface Fixtures {
  backend: Backend;
  /** CSP violations seen so far (the test fails if any are left at the end). */
  csp: string[];
  pageErrors: string[];
  stubs: void;
}

export const test = base.extend<Options & Fixtures>({
  backendOptions: [{}, { option: true }],
  musicOptions: [{}, { option: true }],
  live: [false, { option: true }],
  allowPageErrors: [[], { option: true }],

  csp: [
    async ({ page }, use) => {
      const seen: string[] = [];
      await page.exposeFunction('__cspReport', (v: string) => seen.push(v));
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          (window as unknown as { __cspReport?: (v: string) => void }).__cspReport?.(`${e.effectiveDirective} blocked ${e.blockedURI || e.sample || '(inline)'}`);
        });
      });
      page.on('console', (m) => {
        if (/Content Security Policy/i.test(m.text())) seen.push(m.text());
      });
      await use(seen);
      expect(seen, 'Content Security Policy violations').toEqual([]);
    },
    { auto: true },
  ],

  pageErrors: [
    async ({ page, allowPageErrors }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => {
        if (!allowPageErrors.some((r) => r.test(e.message))) errors.push(e.message);
      });
      await use(errors);
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],

  backend: [
    async ({ page, live, backendOptions }, use) => {
      await use(live ? (null as unknown as Backend) : await stubBackend(page, backendOptions));
    },
    { auto: true },
  ],

  stubs: [
    async ({ page, musicOptions }, use) => {
      await stubYouTube(page);
      if (musicOptions !== false) await stubMusic(page, musicOptions);
      await use();
    },
    { auto: true },
  ],
});
