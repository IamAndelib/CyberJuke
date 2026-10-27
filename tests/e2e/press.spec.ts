import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { openNowPlaying, start } from '../helpers';

// U3: press feedback the way Android's View shows it (ui/press.ts).

/** Now Playing on a track with a genre tag, credited to one artist. */
async function openNowPlayingOnTagged(page: Page): Promise<void> {
  const row = page.getByTestId('track-row').filter({ has: page.locator('.tag') }).filter({ hasNotText: ',' }).first();
  await row.getByTestId('track-play').click();
  await openNowPlaying(page);
}

/** A quick touch tap (down, up, click in one task) on `el`; frames until `next` shows. */
function quickTapFrames(page: Page, testid: string, next: string) {
  return page.getByTestId(testid).first().evaluate(async (el, nextId) => {
    const shows = () => !!document.querySelector<HTMLElement>(`[data-testid="${nextId}"]`)?.checkVisibility();
    const t0 = performance.now();
    const ev = { pointerType: 'touch', isPrimary: true, bubbles: true } as const;
    el.dispatchEvent(new PointerEvent('pointerdown', ev));
    el.dispatchEvent(new PointerEvent('pointerup', ev));
    (el as HTMLElement).click();
    const frames: { t: number; pressed: boolean; next: boolean }[] = [];
    await new Promise<void>((r) => {
      const f = () => {
        const n = shows();
        frames.push({ t: performance.now() - t0, pressed: el.classList.contains('pressed'), next: n });
        if (n || performance.now() - t0 > 3000) r();
        else requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
    return frames;
  }, next);
}

// These replace the screen they are on, which used to go before a quick tap's press painted.
for (const { name, open, testid, next } of [
  { name: 'the Settings button', open: async (_page: Page) => undefined, testid: 'open-settings', next: 'screen-settings' },
  { name: "Settings' Back arrow", open: async (page: Page) => page.getByTestId('open-settings').click(), testid: 'settings-back', next: 'screen-home' },
  {
    name: "a genre page's Back arrow",
    open: async (page: Page) => {
      await page.getByTestId('tab-genres').click();
      await page.getByTestId('genre-grid').getByTestId('genre-tile').first().click();
    },
    testid: 'genre-back',
    next: 'genre-grid',
  },
  { name: 'the search button', open: async (_page: Page) => undefined, testid: 'search-fab', next: 'search-input' },
  { name: "Search's close arrow", open: async (page: Page) => page.getByTestId('search-fab').click(), testid: 'search-close', next: 'search-fab' },
  { name: "Now Playing's genre", open: openNowPlayingOnTagged, testid: 'np-genre', next: 'screen-genre' },
  { name: "Now Playing's artist", open: openNowPlayingOnTagged, testid: 'np-artist', next: 'screen-artist' },
]) {
  test(`a quick tap on ${name} paints its press, then the screen changes at once`, async ({ page }) => {
    await start(page);
    await open(page);
    await expect(page.getByTestId(testid).first()).toBeVisible();
    const run = await quickTapFrames(page, testid, next);
    const before = run.filter((f) => !f.next);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((f) => f.pressed)).toBe(true);
    expect(run.at(-1)!.next).toBe(true);
    // Android's timing: one painted frame, not a hold.
    expect(before.length).toBeLessThanOrEqual(4);
  });
}

test('reduced motion keeps the press: it is a change of colour, not motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page);
  const run = await quickTapFrames(page, 'open-settings', 'screen-settings');
  const before = run.filter((f) => !f.next);
  expect(before.length).toBeGreaterThan(0);
  expect(before.every((f) => f.pressed)).toBe(true);
});

/** Touch down and up on `testid` (no click); the `.pressed` timeline in ms. */
function pressTimeline(page: Page, testid: string, holdMs: number, scroll = false) {
  return page.getByTestId(testid).first().evaluate(
    async (el, [hold, scrollIt]) => {
      const ev = { pointerType: 'touch', isPrimary: true, bubbles: true } as const;
      const seen: { t: number; on: boolean }[] = [];
      const t0 = performance.now();
      const watch = () => seen.push({ t: performance.now() - t0, on: el.classList.contains('pressed') });
      el.dispatchEvent(new PointerEvent('pointerdown', ev));
      watch();
      if (scrollIt) el.closest('.screen')!.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, hold as number));
      watch();
      el.dispatchEvent(new PointerEvent('pointerup', ev));
      watch();
      const until = performance.now() + 400;
      while (performance.now() < until) {
        await new Promise((r) => requestAnimationFrame(r));
        watch();
      }
      return seen;
    },
    [holdMs, scroll] as const,
  );
}

test('a control outside a list shows its press at once, and keeps it about 100 ms after a quick tap', async ({ page }) => {
  await start(page);
  const seen = await pressTimeline(page, 'tab-genres', 10);
  expect(seen[0].on).toBe(true);
  const off = seen.find((s, i) => i > 2 && !s.on)!;
  expect(off.t).toBeGreaterThanOrEqual(90);
  expect(off.t).toBeLessThan(300);
});

test('in a list, a touch waits the tap timeout before pressing, a quick tap shows as it lifts, and a scroll cancels it', async ({ page }) => {
  await start(page);
  // Down, and not yet pressed: it may be the start of a scroll.
  const quick = await pressTimeline(page, 'track-play', 20);
  expect(quick[0].on).toBe(false);
  // Lifted quickly: pressed then, for about 100 ms.
  expect(quick[2].on).toBe(true);
  expect(quick.at(-1)!.on).toBe(false);
  // Held: pressed after the timeout.
  const held = await pressTimeline(page, 'track-play', 160);
  expect(held[1].on).toBe(true);
  // A scroll before the timeout: never pressed.
  const scrolled = await pressTimeline(page, 'track-play', 160, true);
  expect(scrolled.every((s) => !s.on)).toBe(true);
});

test("a pressed See all keeps its text visible (it inverted to the text's own colour)", async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-tile').first().click();
  const all = page.getByTestId('artist-albums').getByTestId('see-all');
  await expect(all).toBeVisible();
  // Held down (:active), as a slow press shows it.
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="artist-albums"] [data-testid="see-all"]' });
  await cdp.send('CSS.enable');
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
  const [fg, bg] = await all.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
  expect(fg).not.toBe(bg);
});
