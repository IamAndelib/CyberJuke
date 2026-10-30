import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { box, expectStable, isFeedQuery, nextFrame, openNowPlaying, playAndOpen, scrollTo, scrollTopOf, start, waitForTracks } from '../helpers';

/**
 * Motion and touch: text selection, the marquee, press feedback, pull-to-refresh,
 * the click guard, touch targets, and the mini player swipe.
 */

/** Hold one finger still at (x, y) for `ms` (a long-press), through CDP touch events. */
async function longPress(page: Page, x: number, y: number, ms = 800): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  // Gesture timing, not a wait for the app: the finger stays down this long.
  await new Promise((r) => setTimeout(r, ms));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const selection = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? '');

test('a long-press or double tap selects no text; inputs still can', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const title = page.getByTestId('screen-genres').locator('.topbar-title');
  await expect(title).toHaveText(/genres/i);
  const b = (await title.boundingBox())!;
  await longPress(page, b.x + 20, b.y + b.height / 2);
  expect(await selection(page)).toBe('');
  await title.dblclick();
  expect(await selection(page)).toBe('');

  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  await expect(page.locator('.art img').first()).toHaveAttribute('draggable', 'false');
  expect(await page.locator('.art img').first().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-user-drag'))).toBe('none');
  await page.getByTestId('search-fab').click();
  const input = page.getByTestId('search-input');
  await input.fill('select me');
  await input.selectText();
  expect(await input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('select me');
  expect(await input.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text');
});

// ---- Pull to refresh -------------------------------------------------------------------

type Renders = { counts: Record<string, number>; reset(): void };
const renders = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.counts }));
const resetRenders = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.reset());

/**
 * One finger down at (x, y) through CDP; returns move(dx, dy) and end(). Each move continues
 * from where the last one left the finger (starting over from (x, y) would jump the finger
 * back up, which the browser scrolls natively and the pull rightly gives up on).
 */
async function finger(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  let cx = x;
  let cy = y;
  return {
    async move(dx: number, dy: number, steps = 10) {
      const [x0, y0] = [cx, cy];
      for (let i = 1; i <= steps; i++) {
        cx = x0 + (dx * i) / steps;
        cy = y0 + (dy * i) / steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx, y: cy, id: 1 }] });
        await nextFrame(page);
      }
    },
    async end() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    },
    /** The system takes the gesture over (an edge swipe, a palm). */
    async cancel() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await cdp.detach();
    },
  };
}

/** Waits until nothing has rendered for `quiet` ms (late chunk fills and image loads included). */
async function rendersSettle(page: Page, quiet = 400, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  let last = JSON.stringify(await renders(page));
  let since = Date.now();
  while (Date.now() - since < quiet) {
    if (Date.now() > end) throw new Error('renders never settled');
    await nextFrame(page);
    const now = JSON.stringify(await renders(page));
    if (now !== last) [last, since] = [now, Date.now()];
  }
}

const offsetOf = (page: Page, testid: string) =>
  page.getByTestId(testid).locator('.screen-body').evaluate((el) => {
    const t = getComputedStyle(el).transform;
    return t === 'none' ? 0 : new DOMMatrix(t).m42;
  });

test('pull to refresh: follows the finger on a rubber band with no re-render, then refreshes', async ({ page }) => {
  await start(page);
  const ptr = page.getByTestId('ptr');
  // Let Home settle first (the catalog arriving re-renders the genre chips and Home).
  await expect(page.getByTestId('genre-chip').first()).toBeVisible();
  await rendersSettle(page);
  await resetRenders(page);
  const f = await finger(page, 200, 320);
  await f.move(0, 60);
  const small = await offsetOf(page, 'screen-home');
  expect(small).toBeGreaterThan(10);
  expect(small).toBeLessThan(60 * 0.65);
  await expect(ptr).toHaveText('[ pull to refresh ]');
  await f.move(0, 400);
  const big = await offsetOf(page, 'screen-home');
  // A rubber band: far less than the finger, never past the limit.
  expect(big).toBeGreaterThan(56);
  expect(big).toBeLessThan(140);
  await expect(ptr).toHaveText('[ release to refresh ]');
  // The drag re-rendered nothing of the screen.
  const counts = await renders(page);
  for (const c of ['App', 'Screen', 'Home', 'TrackRow']) expect(counts[c] ?? 0, c).toBe(0);
  // Watch the refreshing state from inside the page (round trips can be slower than it).
  await ptr.evaluate((el) => {
    const w = window as unknown as { __busy: { on?: number; off?: number; label?: string } };
    w.__busy = {};
    new MutationObserver(() => {
      const now = performance.now();
      if (el.getAttribute('aria-busy') === 'true') w.__busy.on ??= (w.__busy.label = el.textContent ?? '', now);
      else if (w.__busy.on != null) w.__busy.off ??= now;
    }).observe(el, { attributes: true, attributeFilter: ['aria-busy'] });
  });
  await f.end();
  const busy = () => page.evaluate(() => (window as unknown as { __busy: { on?: number; off?: number; label?: string } }).__busy);
  await expect.poll(async () => (await busy()).off != null).toBe(true);
  const b = await busy();
  expect(b.label).toBe('[ refreshing… ]');
  // The spinner stayed up at least 400 ms, then everything sprang back.
  expect(b.off! - b.on!).toBeGreaterThanOrEqual(395);
  await expect.poll(() => offsetOf(page, 'screen-home')).toBe(0);
  // At rest the content carries no transform at all.
  await expect.poll(() => page.getByTestId('screen-home').locator('.screen-body').evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
});

test('pull to refresh: a short pull springs back, a sideways swipe is ignored', async ({ page, backend }) => {
  await start(page);
  const latest = () => backend.queries.filter((q) => isFeedQuery(q) && !q.startAt).length;
  const before = latest();
  let f = await finger(page, 200, 320);
  await f.move(0, 70);
  expect(await offsetOf(page, 'screen-home')).toBeGreaterThan(10);
  await f.end();
  await expect.poll(() => offsetOf(page, 'screen-home')).toBe(0);
  // Sideways (and a little down): the genre chips' swipe, not a pull.
  f = await finger(page, 300, 320);
  await f.move(-160, 40);
  expect(await offsetOf(page, 'screen-home')).toBe(0);
  await f.end();
  await expectStable(async () => latest(), 600);
  expect(latest()).toBe(before);
});

test('pull to refresh: a pull the system takes over springs back without refreshing', async ({ page }) => {
  await start(page);
  const ptr = page.getByTestId('ptr');
  // Any refresh at all, however short, is seen from inside the page.
  await ptr.evaluate((el) => {
    const w = window as unknown as { __refreshed: boolean };
    w.__refreshed = false;
    new MutationObserver(() => {
      if (el.getAttribute('aria-busy') === 'true') w.__refreshed = true;
    }).observe(el, { attributes: true, attributeFilter: ['aria-busy'] });
  });
  const f = await finger(page, 200, 320);
  await f.move(0, 400);
  await expect(ptr).toHaveText('[ release to refresh ]');
  await f.cancel();
  await expect.poll(() => offsetOf(page, 'screen-home')).toBe(0);
  await expectStable(() => page.evaluate(() => (window as unknown as { __refreshed: boolean }).__refreshed), 600);
  expect(await page.evaluate(() => (window as unknown as { __refreshed: boolean }).__refreshed)).toBe(false);
});

// ---- Back-to-top and the search button --------------------------------------------------

test('a tap that stops back-to-top plays nothing; a tap after it does', async ({ page }) => {
  await start(page);
  const screen = page.getByTestId('screen-home');
  await screen.evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect(screen.getByTestId('back-to-top')).toBeVisible();
  // All in the page, so the tap surely lands mid-jump: finger down and up on the
  // button, then a tap (finger down, click) on a row while the list moves.
  const run = await screen.evaluate((el) => {
    const touch = (target: Element, type: string) => target.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }));
    const btn = el.querySelector('[data-testid="back-to-top"]')!;
    const from = el.scrollTop;
    touch(btn, 'pointerdown');
    touch(btn, 'pointerup');
    const play = [...el.querySelectorAll<HTMLElement>('[data-testid="track-play"]')].find((b) => b.getBoundingClientRect().top > 200)!;
    touch(play, 'pointerdown');
    touch(play, 'pointerup');
    const click = new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true });
    play.dispatchEvent(click);
    return { from, swallowed: click.defaultPrevented, at: el.scrollTop };
  });
  expect(run.swallowed).toBe(true);
  // The jump stopped where the finger came down, far from the top.
  expect(run.at).toBeGreaterThan(run.from / 2);
  await expectStable(() => scrollTopOf(page, 'screen-home'), 400);
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
  // Nothing moving now: a tap plays the row.
  await screen.getByTestId('track-play').nth(5).click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
});

test('the scroll to the top from a tap on the tab you are on is stopped by a tap, which plays nothing (P5, M6)', async ({ page }) => {
  await start(page);
  const screen = page.getByTestId('screen-home');
  await screen.evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect.poll(() => scrollTopOf(page, 'screen-home')).toBeGreaterThan(0);
  const run = await screen.evaluate((el) => {
    const touch = (target: Element, type: string) => target.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }));
    const from = el.scrollTop;
    (document.querySelector('[data-testid="tab-home"]') as HTMLElement).click();
    const play = [...el.querySelectorAll<HTMLElement>('[data-testid="track-play"]')].find((b) => b.getBoundingClientRect().top > 200)!;
    touch(play, 'pointerdown');
    touch(play, 'pointerup');
    const click = new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true });
    play.dispatchEvent(click);
    return { from, swallowed: click.defaultPrevented, at: el.scrollTop };
  });
  expect(run.swallowed).toBe(true);
  expect(run.at).toBeGreaterThan(run.from / 2);
  await expectStable(() => scrollTopOf(page, 'screen-home'), 400);
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
});

test('the back-to-top and search buttons show their press, and the search button tucks away scrolling down', async ({ page }) => {
  await start(page);
  const screen = page.getByTestId('screen-home');
  const fab = page.getByTestId('search-fab');
  // A quick press still shows for a moment (released at once, kept ~100 ms). The finger
  // drifts past the tap slop, so it shows the press without opening Search (tapThrough).
  const held = await fab.evaluate(async (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true, clientX: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', isPrimary: true, bubbles: true, clientX: 40 }));
    const at = performance.now();
    const on = el.hasAttribute('data-pressed');
    await new Promise<void>((r) => {
      const check = () => (!el.hasAttribute('data-pressed') ? r() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    return { on, ms: performance.now() - at };
  });
  expect(held.on).toBe(true);
  expect(held.ms).toBeGreaterThanOrEqual(90);
  await expect(page.getByTestId('search')).toHaveCount(0);

  // Scrolling down hides it; up brings it back; the top always shows it.
  const dock = page.locator('.fab');
  for (let y = 100; y <= 700; y += 100) await scrollTo(page, 'screen-home', y);
  await expect(dock).toHaveClass(/\baway\b/);
  await expect(fab).toBeHidden();
  await scrollTo(page, 'screen-home', 600);
  await scrollTo(page, 'screen-home', 500);
  await expect(dock).not.toHaveClass(/\baway\b/);
  await expect(fab).toBeVisible();
  for (let y = 600; y <= 1000; y += 100) await scrollTo(page, 'screen-home', y);
  await expect(dock).toHaveClass(/\baway\b/);
  // Another tab: back in view.
  await page.getByTestId('tab-genres').click();
  await expect(fab).toBeVisible();
  await page.getByTestId('tab-home').click();
  await scrollTo(page, 'screen-home', 0);
  await expect(dock).not.toHaveClass(/\baway\b/);

  // The back-to-top button is 48px and presses the same way.
  await screen.evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  const top = screen.getByTestId('back-to-top');
  await expect(top).toBeVisible();
  const tb = await box(top);
  expect(tb.width).toBeCloseTo(48, 1);
  expect(tb.height).toBeCloseTo(48, 1);

  // Reduced motion keeps the press: a change of colour, not motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await fab.evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true, clientX: 0 }));
    const on = el.hasAttribute('data-pressed');
    el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', isPrimary: true, bubbles: true, clientX: 40 }));
    return on;
  });
  expect(reduced).toBe(true);
});

// ---- Fast scroller ----------------------------------------------------------------------

test('fast scroller: 24px to grab, a tap does nothing, the thumb is kept out of the back gesture', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('grid-sort-az').click();
  const screen = page.getByTestId('screen-artists');
  await expect(screen.getByTestId('az-head').first()).toBeVisible();
  const exclusions = () => page.evaluate(() => (window as unknown as { __cyberjukeGestureExclusion: unknown[] }).__cyberjukeGestureExclusion.slice());
  await page.mouse.move(200, 400);
  await page.mouse.wheel(0, 600);
  const sb = screen.getByTestId('scrollbar');
  await expect(sb).toHaveClass(/draggable/);
  await expect(sb).toHaveClass(/\bon\b/);
  const thumb = screen.getByTestId('scroll-thumb');
  const tb = await box(thumb);
  expect(tb.width).toBe(24);
  expect(tb.x + tb.width).toBeCloseTo(page.viewportSize()!.width, 0);
  // While it shows, its rect is excluded from the back gesture.
  await expect
    .poll(async () => {
      const last = (await exclusions()).at(-1) as { left: number; top: number; width: number; height: number } | null;
      return last && Math.abs(last.left - tb.x) <= 1 && Math.abs(last.width - tb.width) <= 1 && last.height >= 48;
    })
    .toBe(true);
  // A tap on the resting thumb doesn't move the list.
  const y0 = await scrollTopOf(page, 'screen-artists');
  await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height - 4);
  await nextFrame(page);
  expect(await scrollTopOf(page, 'screen-artists')).toBe(y0);
  await expect(sb).not.toHaveClass(/dragging/);
  // Once it fades, the exclusion is cleared.
  await expect(sb).not.toHaveClass(/\bon\b/, { timeout: 3000 });
  await expect.poll(async () => (await exclusions()).at(-1)).toBeNull();
});

// ---- Mini player and Now Playing ------------------------------------------------------

test('a long title scrolls in the mini player and Now Playing; short ones and reduced motion keep the ellipsis', async ({ page }) => {
  await start(page);
  const rows = page.getByTestId('track-row');
  const long = rows.filter({ hasText: '(Official Video)' }).first();
  // Load pages until one has a title too long for the players.
  await expect
    .poll(async () => {
      if (await long.count()) return true;
      await scrollTo(page, 'screen-home', 1e6);
      return false;
    })
    .toBe(true);
  const title = (await long.getByTestId('track-title').textContent())!.trim();
  await long.getByTestId('track-play').click();
  const mini = page.getByTestId('mini-title');
  await expect(mini).toHaveText(title);
  await expect(mini.locator('.marquee')).toHaveClass(/\brun\b/);
  // A transform animation that holds still first, then moves left.
  const anim = await mini.locator('.marquee-text').evaluate((el) => {
    const a = el.getAnimations()[0];
    const kf = (a.effect as KeyframeEffect).getKeyframes();
    return { n: el.getAnimations().length, hold: kf[1].offset as number, end: String(kf[2].transform), duration: Number(a.effect!.getTiming().duration) };
  });
  expect(anim.n).toBe(1);
  expect(anim.end).toMatch(/translateX\(-\d+(\.\d+)?px\)/);
  expect(anim.hold * anim.duration).toBeCloseTo(1500, -1);

  await openNowPlaying(page);
  await expect(page.getByTestId('np-title')).toHaveText(title);
  await expect(page.getByTestId('np-title').locator('.marquee')).toHaveClass(/\brun\b/);
  // Under Now Playing the mini player's title holds still.
  await expect(mini.locator('.marquee')).not.toHaveClass(/\brun\b/);
  await page.getByTestId('np-close').click();
  await expect(mini.locator('.marquee')).toHaveClass(/\brun\b/);

  // A title that fits doesn't move.
  const titles = await page.getByTestId('track-title').allTextContents();
  const i = titles.reduce((best, t, j) => (t.trim().length < titles[best].trim().length ? j : best), 0);
  await page.getByTestId('track-play').nth(i).click();
  await expect(mini).toHaveText(titles[i].trim());
  await expect(mini.locator('.marquee')).not.toHaveClass(/\brun\b/);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await long.getByTestId('track-play').click();
  await expect(mini).toHaveText(title);
  await nextFrame(page);
  await expect(mini.locator('.marquee')).not.toHaveClass(/\brun\b/);
  expect(await mini.locator('.marquee').evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
});

test('swipe up on the mini player opens Now Playing; sideways does nothing', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  const mini = await box(page.getByTestId('mini-player'));
  const title = await page.getByTestId('mini-title').textContent();
  const cx = mini.x + mini.width / 3;
  const cy = mini.y + mini.height / 2;
  // Sideways: no skip, nothing opens.
  let f = await finger(page, cx + 80, cy);
  await f.move(-120, 0, 6);
  await f.end();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  await expect(page.getByTestId('mini-title')).toHaveText(title!);
  f = await finger(page, cx, cy);
  await f.move(0, -80, 6);
  await f.end();
  await expect(page.getByTestId('now-playing')).toHaveClass(/open/);
});

test('Next is off at the end of the queue in both players; repeat is a toggle; 48px targets; 12px text', async ({ page }) => {
  await start(page);
  // The last row: whatever comes after it, both Next buttons agree.
  await page.getByTestId('track-play').last().click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  const miniOff = await page.getByTestId('mini-next').isDisabled();
  await openNowPlaying(page);
  expect(await page.getByTestId('np-next').isDisabled()).toBe(miniOff);
  const repeat = page.getByTestId('np-repeat');
  await expect(repeat).toHaveAttribute('aria-pressed', 'false');
  await repeat.click();
  await expect(repeat).toHaveAttribute('aria-pressed', 'true');
  // Repeat wraps around: Next does something in both.
  await expect(page.getByTestId('np-next')).toBeEnabled();
  for (let i = 0; i < 2; i++) await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'off');
  await expect(repeat).toHaveAttribute('aria-pressed', 'false');

  // The seek bar's touch area and the [lyrics] toggle are 48px.
  expect((await box(page.getByTestId('seek'))).height).toBeCloseTo(48, 1);
  const flip = await page.getByTestId('np-lyrics-toggle').evaluate((el) => {
    const a = getComputedStyle(el, '::after');
    const r = el.getBoundingClientRect();
    return r.height - 2 * parseFloat(a.top);
  });
  expect(flip).toBeGreaterThanOrEqual(48);
  await page.getByTestId('np-close').click();
  for (const id of ['mini-toggle', 'mini-next']) {
    const b = await box(page.getByTestId(id));
    expect(b.width).toBeGreaterThanOrEqual(48);
    expect(b.height).toBeGreaterThanOrEqual(48);
  }
  const t = await box(page.getByTestId('mini-toggle'));
  const n = await box(page.getByTestId('mini-next'));
  expect(n.x - (t.x + t.width)).toBeGreaterThanOrEqual(8);
  for (const sel of ['.tag', '.mtag', '.lyr-credit'])
    for (const size of await page.locator(sel).evaluateAll((els) => els.filter((e) => e.isConnected).map((e) => parseFloat(getComputedStyle(e).fontSize))))
      if (!Number.isNaN(size)) expect(size, sel).toBeGreaterThanOrEqual(12);
});

test('the track menu keeps its content while it slides away', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-more').first().click();
  const menu = page.getByTestId('track-menu');
  await expect(menu.getByTestId('menu-share')).toBeVisible();
  const seen = await menu.evaluate(async (el) => {
    const cancel = el.querySelector('.sheet-cancel button') as HTMLElement;
    let ended = false;
    el.addEventListener('transitionend', () => (ended = true));
    cancel.click();
    // First sample once the close has rendered (microtasks only: a slow runner can't let the
    // 200 ms slide finish first), then every frame until the slide ends.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const items: number[] = [el.querySelectorAll('.sheet-item').length];
    await new Promise<void>((r) => {
      const t0 = performance.now();
      const tick = () => {
        if (ended || performance.now() - t0 > 150) return r();
        items.push(el.querySelectorAll('.sheet-item').length);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return items;
  });
  // Still all there while it moves (the slide-out takes 200 ms).
  expect(seen.length).toBeGreaterThanOrEqual(1);
  expect(Math.min(...seen)).toBeGreaterThan(2);
  await expect(menu).toBeHidden();
  await expect(menu.locator('.sheet-item')).toHaveCount(0);
});

test('Now Playing says where the music comes from; a list its position too, but under shuffle', async ({ page }) => {
  await start(page);
  await playAndOpen(page, 0);
  const from = page.getByTestId('np-from');
  // A Home tap: the feed it came from, no position (the rest is autoplay's).
  await expect(from).toHaveText('Playing from Home · Latest');
  // An autoplay song: what autoplay plays, as Up next calls it.
  const seed = (await page.getByTestId('np-title').textContent())!.trim();
  await expect(page.locator('[data-testid="upnext-row"][data-section="autoplay"]').first()).toBeVisible();
  await page.getByTestId('np-next').click();
  await expect(from).toHaveText(`Autoplay · similar to ${seed}`);
  await page.getByTestId('np-close').click();
  // A genre's Play: the list, and where in it.
  await page.getByTestId('tab-genres').click();
  const genre = (await page.getByTestId('genre-tile').nth(5).getAttribute('data-genre'))!;
  await page.getByTestId('genre-tile').nth(5).click();
  await expect(page.locator('[data-testid="track-row"]:visible').nth(1)).toBeVisible();
  await page.locator('[data-testid="genre-play-all"]:visible').click();
  await openNowPlaying(page);
  await expect(from).toHaveText(new RegExp(`^1 of \\d+ · Playing from ${genre}$`));
  await page.getByTestId('np-shuffle').click();
  await expect(from).toHaveText(`Playing from ${genre}`);
  await page.getByTestId('np-shuffle').click();
  await expect(from).toHaveText(new RegExp(` · Playing from ${genre}$`));
});

/** Tiles in a grid once it's whole (it fills in idle time after its first screen). */
async function wholeGridCount(page: Page, screen: Locator): Promise<number> {
  const count = () => screen.getByTestId('genre-tile').count();
  await expect
    .poll(async () => {
      const a = await count();
      await page.waitForTimeout(300);
      return a === (await count());
    })
    .toBe(true);
  return count();
}

test('pull to refresh that fails says so and keeps what was shown', async ({ page, backend }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const screen = page.getByTestId('screen-genres');
  await expect(screen.locator('.topbar-sub')).toContainText('genres on the Jukebox');
  const tiles = await wholeGridCount(page, screen);
  backend.offline = true;
  const f = await finger(page, 200, 320);
  await f.move(0, 400);
  await f.end();
  await expect(page.getByTestId('toast')).toHaveText(/^(Couldn't refresh\. Try again in a moment\.|No carrier\. Connect, then refresh\.)$/);
  await expect(screen.getByTestId('genre-tile')).toHaveCount(tiles);
});

test('pull to refresh offline says to connect, then refresh, and keeps the grid', async ({ page, backend }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const screen = page.getByTestId('screen-genres');
  await expect(screen.locator('.topbar-sub')).toContainText('genres on the Jukebox');
  const tiles = await wholeGridCount(page, screen);
  backend.offline = true;
  await page.context().setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  const f = await finger(page, 200, 320);
  await f.move(0, 400);
  await f.end();
  await expect(page.getByTestId('toast')).toHaveText('No carrier. Connect, then refresh.');
  await expect(screen.getByTestId('genre-tile')).toHaveCount(tiles);
});

/**
 * Every frame from a tap until `ms` later: whether anything of a page underneath is on top
 * anywhere on the screen (hit-tested on a 6×16 grid, every element counted), and whether the
 * page on top lets one underneath show through.
 */
function pageFrames(page: Page, act: (page: Page) => Promise<unknown>, ms = 600) {
  const run = page.evaluate((ms) => {
    // Everything hit-testable for the count; a constructed sheet, which the CSP allows.
    const all = new CSSStyleSheet();
    all.replaceSync('* { pointer-events: auto !important }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, all];
    return new Promise<{ under: string[]; seeThrough: boolean }[]>((done) => {
      const frames: { under: string[]; seeThrough: boolean }[] = [];
      const t0 = performance.now();
      const tick = (ts: number) => {
        const pane = document.querySelector('.tab-pane.on')!;
        const top = pane.querySelector(':scope > .page.top');
        const under = new Set<string>();
        for (let i = 0; i < 6; i++)
          for (let j = 0; j < 16; j++) {
            const el = document.elementFromPoint(((i + 0.5) * innerWidth) / 6, ((j + 0.5) * innerHeight) / 16);
            const pg = el?.closest('.page');
            if (pg && pg.parentElement === pane && pg !== top) under.add(`${el!.tagName.toLowerCase()}.${[...el!.classList].join('.')}`);
          }
        const shown = [...pane.querySelectorAll<HTMLElement>(':scope > .page')].filter((p) => p !== top && p.checkVisibility());
        const seeThrough = !!top && shown.length > 0 && Number(getComputedStyle(top).opacity) < 1;
        frames.push({ under: [...under], seeThrough });
        if (ts - t0 < ms) requestAnimationFrame(tick);
        else {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== all);
          done(frames);
        }
      };
      requestAnimationFrame(tick);
    });
  }, ms);
  return act(page).then(() => run);
}

const opensGrid = (tab: string, tile: string) => async (page: Page) => {
  await page.getByTestId(tab).click();
  await expect(page.getByTestId(tile).first()).toBeVisible();
};

for (const { name, open, tap, next } of [
  { name: 'a genre page', open: opensGrid('tab-genres', 'genre-tile'), tap: 'genre-tile', next: 'screen-genre' },
  { name: 'an artist page', open: opensGrid('tab-artists', 'artist-tile'), tap: 'artist-tile', next: 'screen-artist' },
  { name: 'Search', open: async (_page: Page) => undefined, tap: 'search-fab', next: 'search-input' },
]) {
  test(`${name} covers the screen it opens over from its first frame: nothing of that one shows through or on top`, async ({ page }) => {
    await start(page);
    await open(page);
    const frames = await pageFrames(page, (p) => p.getByTestId(tap).first().click());
    await expect(page.getByTestId(next)).toBeVisible();
    expect(frames.flatMap((f) => f.under)).toEqual([]);
    expect(frames.filter((f) => f.seeThrough)).toHaveLength(0);
  });
}
