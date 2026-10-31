/** Shared steps and waits for the e2e specs. No fixed sleeps: every wait is on a condition. */
import { expect, type Locator, type Page } from '@playwright/test';
import { FAKE_TRACK_MS, setImagesOffline } from './fixtures/youtube';

export { FAKE_TRACK_MS };

/**
 * The screen showing has its rows. Visited tabs and covered pages stay mounted (hidden),
 * so only what's visible counts.
 */
export async function waitForTracks(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="track-row"]:visible').first()).toBeVisible();
  await expect(page.locator('[data-testid="skeleton"]:visible')).toHaveCount(0);
}

/**
 * A Latest or genre page (PAGE_SIZE rows), not a catalog page (300) or the freshness
 * check (25). All three send a field mask, so the size tells them apart.
 */
export const isFeedQuery = (q: { limit?: number } | null | undefined): boolean => q?.limit === 24;

/** The feed requests (24 rows) the fake backend got for a genre, by name. */
export const requestsFor = (backend: { queries: { limit?: number; where?: unknown }[] }, genre: string): number =>
  backend.queries.filter((q) => isFeedQuery(q) && JSON.stringify(q.where).includes(`"${genre}"`)).length;

/** Load the app and wait for Home's first page. */
/**
 * Next until nothing of the list is left ahead in Up next: its last song plays. (A tap on a row
 * further down plays it but keeps what it jumps over, so it doesn't get there.)
 */
export async function toListEnd(page: Page): Promise<void> {
  const rows = page.locator('[data-testid="upnext-row"][data-section="list"]');
  const title = page.getByTestId('np-title');
  while ((await rows.count()) > 0) {
    const t = (await title.textContent())!;
    await page.getByTestId('np-next').click();
    await expect(title).not.toHaveText(t);
  }
}

export async function start(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await waitForTracks(page);
}

export async function openSearch(page: Page): Promise<void> {
  await page.getByTestId('search-fab').click();
  await expect(page.getByTestId('search')).toBeVisible();
  await expect(page.getByTestId('search-input')).toBeFocused();
}

/**
 * Settings: the button at the top right of Home (Settings is a page over Home, not a tab).
 * From another tab, Home first (where Settings may still be open); showing already, nothing.
 */
export async function openSettings(page: Page): Promise<void> {
  const settings = page.getByTestId('screen-settings');
  if (await settings.isVisible()) return;
  const home = page.getByTestId('tab-home');
  if ((await home.getAttribute('aria-current')) !== 'page') await home.click();
  await page.getByTestId('open-settings').click();
  await expect(settings).toBeVisible();
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
export const playerCalls = (page: Page) => page.evaluate(() => window.__cyberjukePlayerCalls ?? []);

/** What the page told the Android window (windowChrome.ts), of one kind: 'bars', 'background' or 'firstScreen'. */
export const windowChrome = (page: Page, kind: 'bars' | 'background' | 'firstScreen') =>
  page.evaluate((k) => (window as unknown as { __cyberjukeWindowChrome: [string, string][] }).__cyberjukeWindowChrome.filter(([c]) => c === k).map(([, v]) => v), kind);
/** Android back, as native sends it to the page while its back callback is on (app/back.ts). */
export const androidBack = (page: Page) => page.evaluate(() => void document.dispatchEvent(new Event('backbutton')));
/** What the page told native about back (true: it has something to close) and each move to the background, in order. */
export const backCalls = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeBack: (boolean | 'background')[] }).__cyberjukeBack.slice());

/** How much of the current track native reports loaded ahead, in ms (0: the track the app reopens on). */
export const bufferedAhead = (page: Page, ms: number) => page.evaluate((v) => (window as unknown as { __cyberjukeBufferedAhead(ms: number): void }).__cyberjukeBufferedAhead(v), ms);

declare global {
  interface Window {
    /** recordOpens: the URLs window.open was asked for. */
    __opened?: string[];
    /** The fixture's hook: fake the page's visibility (setVisibility). */
    __cyberjukeVisibility: (state: 'hidden' | 'visible') => void;
    /** The fake YouTube player's hook (fakeYt). */
    __cyberjukeYt: { stall(): void; resume(): void; end(): void; error(code: number): void };
    /** The web player's test hooks (trackError, waitingForNetwork). */
    __cyberjukeTrackError: (e: { skipped?: boolean; kind?: string; resumes?: boolean }) => void;
    __cyberjukeWaitingForNetwork: (on: boolean) => void;
  }
}

/** Record window.open instead of opening anything (read them with [opened]). */
export async function recordOpens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const urls: string[] = (window.__opened = []);
    window.open = ((url: string) => {
      urls.push(String(url));
      return null;
    }) as typeof window.open;
  });
}
export const opened = (page: Page) => page.evaluate(() => window.__opened ?? []);

/** Says which liked songs native has saved whole (the browser build's stand-in, `__cyberjukeCache`). */
export async function saved(page: Page, audioIds: string[]): Promise<void> {
  await page.evaluate((ids) => (window as unknown as { __cyberjukeCache: { saved(ids: string[]): void } }).__cyberjukeCache.saved(ids), audioIds);
}

/** The device loses (or gets back) its connection: the browser's, the stub backend's and the image hosts'. */
export async function setOffline(page: Page, backend: { offline: boolean }, off: boolean): Promise<void> {
  backend.offline = off;
  setImagesOffline(page, off);
  await page.context().setOffline(off);
}

/** The app goes to the background or comes back: `document.visibilityState` and its event (the fixture's hook). */
export const setVisibility = (page: Page, state: 'hidden' | 'visible') => page.evaluate((s) => window.__cyberjukeVisibility(s), state);

/**
 * Fake the page's clock (before the app loads): its timers, Date and performance. Time
 * still passes at its usual pace, and `runFor` runs a long stretch of it in an instant: the
 * fake player ends its tracks, the app's timers fire, in order. A request in flight when
 * `runFor` starts hits its timeout like any other timer, so let requests settle first.
 */
export const clockStart = (page: Page) => page.clock.install();

/** Run `ms` of the faked clock (clockStart), firing everything due in it. */
export const runFor = (page: Page, ms: number) => page.clock.runFor(ms);


/**
 * Hours of listening on the faked clock, a track at a time: each jump lands at the end of the
 * track playing (`fastForward`: what was due in between fires once, as after the phone's
 * sleep), then the next one starts; exactly `ceil(ms / (FAKE_TRACK_MS + 200))` tracks end. The
 * clock is paused meanwhile, so the stretch is as long as asked whatever the test's own pace.
 * `runFor` would fire the player's position poll once a second of the night (minutes of test
 * time); the music, the history and the app's hourly habits come out the same.
 */
export async function playOn(page: Page, ms: number): Promise<void> {
  // A few seconds ahead: on a busy machine a second can pass before the pause is set.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5000);
  // A track still starting up (the fake player's 150 ms) plays first.
  await runFor(page, 200);
  for (let left = ms; left > 0; left -= FAKE_TRACK_MS + 200) {
    await page.clock.fastForward(FAKE_TRACK_MS);
    await runFor(page, 200);
  }
  await page.clock.resume();
}

/** How many tracks end during `playOn(page, ms)`. */
export const tracksEndedIn = (ms: number) => Math.ceil(ms / (FAKE_TRACK_MS + 200));

/** Record every message shown from now on (toastsSeen), also those gone again by the time a test looks. */
export const recordToasts = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __toastsSeen: string[] };
    w.__toastsSeen = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-testid="toast"]')) {
        const text = el.textContent ?? '';
        if (w.__toastsSeen.at(-1) !== text) w.__toastsSeen.push(text);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
export const toastsSeen = (page: Page) => page.evaluate(() => (window as unknown as { __toastsSeen?: string[] }).__toastsSeen ?? []);

/**
 * The fake YouTube player (the fixture's hook): the current track stalls, resumes, ends, or fails
 * with a player error `code` (100, 101, 150: removed, private or not embeddable; the app skips it).
 */
export const fakeYt = (page: Page, action: 'stall' | 'resume' | 'end' | 'error', code = 150) =>
  page.evaluate(([a, c]) => (a === 'error' ? window.__cyberjukeYt.error(c) : window.__cyberjukeYt[a]()), [action, code] as const);

/**
 * Home has settled after the start: the catalog's idle load (the 300-row pages that follow the
 * first screen) has been answered and the genre chips are the catalog's 24. Before a test counts
 * requests or drops them (`failNext`), and before it reads a chip then taps it.
 */
export async function homeSettled(page: Page, backend: { queries: { limit?: number }[] }): Promise<void> {
  await expect.poll(() => backend.queries.some((q) => q.limit === 300)).toBe(true);
  await expect(page.getByTestId('genre-chip')).toHaveCount(24);
}

/** Tap Home's i-th genre chip and return the genre it stands for (read off the pressed chip). */
export async function pickGenre(page: Page, i: number): Promise<string> {
  await page.getByTestId('genre-chip').nth(i).click();
  const pressed = page.locator('[data-testid="genre-chip"][aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  return (await pressed.getAttribute('data-genre'))!;
}

/** What native would report in a `trackError` about the current track (the web player's hook). */
export const trackError = (page: Page, e: { skipped?: boolean; kind?: string; resumes?: boolean }) => page.evaluate((v) => window.__cyberjukeTrackError(v), e);

/** Native waits for the network (or no longer does): the web player's hook for that state. */
export const waitingForNetwork = (page: Page, on: boolean) => page.evaluate((v) => window.__cyberjukeWaitingForNetwork(v), on);

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

/**
 * A one-finger drag through CDP touch events (real touchstart/move/end). With
 * `stamped`, the events carry timestamps `ms` apart in total, so velocity math sees
 * exactly that duration however slow the machine is (no real waiting).
 */
export async function touchDrag(page: Page, x: number, y0: number, y1: number, ms: number, steps = 12, stamped = false): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const pt = (y: number) => [{ x, y, id: 1 }];
  const t0 = Date.now() / 1000;
  const at = (i: number) => (stamped ? { timestamp: t0 + (ms / 1000) * (i / steps) } : {});
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y0), ...at(0) });
  for (let i = 1; i <= steps; i++) {
    if (ms && !stamped) await pace(ms / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y0 + ((y1 - y0) * i) / steps), ...at(i) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], ...at(steps) });
  await cdp.detach();
}

/** A sideways finger drag from (x0, y) to (x1, y) over `ms` (touch events, like a phone). */
export async function touchSwipe(page: Page, x0: number, x1: number, y: number, ms: number, steps = 10): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x: number) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0) });
  for (let i = 1; i <= steps; i++) {
    if (ms) await pace(ms / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x0 + ((x1 - x0) * i) / steps) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** A finger tap (touch events, not a mouse click) at the middle of `l`. */
export async function touchTap(page: Page, l: Locator): Promise<void> {
  const b = (await l.boundingBox())!;
  const pt = [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
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
