/**
 * The shared Playwright fixture. Every test gets, by default:
 * - the fake Cyberspace backend (Firestore runQuery over a synthetic Jukebox, and the
 *   Firebase login): `backend`, configured with `test.use({ backendOptions })`;
 * - the fake JukeMusic plugin (Global search, artist pages, lyrics):
 *   `test.use({ musicOptions })`, or `musicOptions: false` for none;
 * - stand-ins for YouTube thumbnails and the IFrame player, and for Jukebox MP3s on
 *   latex.gg with their covers;
 * - no handover grace: a lost connection counts as offline at once;
 * - `window.__cyberjukeVisibility(state)` to fake the page going to the background and back;
 * - checks after the test: no CSP violation and no uncaught page error.
 * `test.use({ live: true })` (only in @live tests) talks to the real Firestore instead.
 */
import { test as base, expect } from '@playwright/test';
import { stubBackend, type Backend, type BackendOptions } from './backend';
import { stubMusic, type MusicStubOptions } from './music';
import { stubLatex } from './latex';
import { stubYouTube } from './youtube';

export { expect };
export { ATTACHMENT_ONLY_GENRE, AUTH_USER, AUTH_USER_B, BANNED_POST, MEMBERS_POSTS, MP3_POSTS, coverUrl, mp3Url } from './data';
export { FAKE_MP3_SECONDS } from './latex';
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
      // Offline at once: the handover grace (core/network.ts) only where a test sets it.
      await page.addInitScript(() => (window.__cyberjukeOfflineGraceMs = 0));
      // The page's visibility, faked: the app follows document.visibilityState and its event.
      await page.addInitScript(() => {
        let forced: 'hidden' | 'visible' | null = null;
        const real = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')!.get!;
        Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => forced ?? real.call(document) });
        Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => document.visibilityState === 'hidden' });
        window.__cyberjukeVisibility = (state) => {
          forced = state;
          document.dispatchEvent(new Event('visibilitychange'));
        };
      });
      await stubYouTube(page);
      await stubLatex(page);
      if (musicOptions !== false) await stubMusic(page, musicOptions);
      await use();
    },
    { auto: true },
  ],
});
