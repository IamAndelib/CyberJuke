/** Shared steps and waits for the e2e specs. No fixed sleeps: every wait is on a condition. */
import { expect, type Locator, type Page } from '@playwright/test';

export async function waitForTracks(page: Page): Promise<void> {
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
}

/** Load the app and wait for Home's first page. */
export async function start(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await waitForTracks(page);
}

export async function openSearch(page: Page): Promise<void> {
  await page.getByTestId('search-fab').click();
  await expect(page.getByTestId('search')).toBeVisible();
  await expect(page.getByTestId('search-input')).toBeFocused();
}

/** Two animation frames: layout, observers and rAF work from the last change have run. */
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

export const scrollTopOf = (page: Page, testid: string) => page.getByTestId(testid).evaluate((el) => el.scrollTop);

/** Scroll a screen and wait until the position holds for a frame (content may grow meanwhile). */
export async function scrollTo(page: Page, testid: string, y: number): Promise<void> {
  const el = page.getByTestId(testid);
  await el.evaluate((e, v) => e.scrollTo(0, v), y);
  await expect
    .poll(async () => {
      const a = await el.evaluate((e) => e.scrollTop);
      await nextFrame(page);
      return a === (await el.evaluate((e) => e.scrollTop));
    })
    .toBe(true);
}

/** Every visible toast has gone. */
export async function toastsGone(page: Page): Promise<void> {
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 10_000 });
}

/** Play the i-th row and open Now Playing, waiting for the sheet to finish sliding in. */
export async function playAndOpen(page: Page, i = 0): Promise<void> {
  await page.getByTestId('track-play').nth(i).click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await openNowPlaying(page);
}

export async function openNowPlaying(page: Page): Promise<void> {
  await page.getByTestId('mini-open').click();
  const np = page.getByTestId('now-playing');
  await expect(np).toHaveClass(/open/);
  await expect.poll(() => np.evaluate((el) => getComputedStyle(el).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
}

/** Calls the fake JukeMusic plugin received (and shares). */
export const musicCalls = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeMusicCalls: unknown[][] }).__cyberjukeMusicCalls);
/** Calls the web player made that the native plugin would receive. */
export const playerCalls = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukePlayerCalls?: unknown[][] }).__cyberjukePlayerCalls ?? []);

export const setLyricsMode = (page: Page, mode: string) => page.evaluate((m) => ((window as unknown as { __cyberjukeLyricsMode: string }).__cyberjukeLyricsMode = m), mode);

/** Seed localStorage before the app starts, once per test (not again on reload). */
export async function seedStorage(page: Page, items: Record<string, unknown>): Promise<void> {
  await page.addInitScript((it) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    for (const [k, v] of Object.entries(it)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }, items);
}

/** Settings as the app stores them (Capacitor Preferences on the web). */
export const SETTINGS_KEY = 'CapacitorStorage.settings';

/**
 * Assert that `read()` keeps returning the same value for `ms` (something that must
 * NOT happen within a time window, e.g. auto-scroll staying paused).
 */
export async function expectStable<T>(read: () => Promise<T>, ms: number): Promise<T> {
  const first = await read();
  const end = Date.now() + ms;
  while (Date.now() < end) expect((await read()) as unknown).toEqual(first);
  return first;
}

/** Gesture pacing: real time between touch moves, so velocity math sees a real drag. */
const pace = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A one-finger drag through CDP touch events (real touchstart/move/end). */
export async function touchDrag(page: Page, x: number, y0: number, y1: number, ms: number, steps = 12): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const pt = (y: number) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y0) });
  for (let i = 1; i <= steps; i++) {
    if (ms) await pace(ms / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y0 + ((y1 - y0) * i) / steps) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

export const box = async (l: Locator) => (await l.boundingBox())!;

export const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** Screenshots go to test-results/screenshots (never committed). */
export async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `test-results/screenshots/${name}.png` });
}
