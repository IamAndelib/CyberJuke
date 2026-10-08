import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { box, expectStable, nextFrame, openNowPlaying, playAndOpen, scrollTo, scrollTopOf, start, waitForTracks } from '../helpers';

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

/** One finger down at (x, y) through CDP; returns move(dx, dy) and end(). */
async function finger(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  return {
    async move(dx: number, dy: number, steps = 10) {
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps, id: 1 }] });
        await nextFrame(page);
      }
    },
    async end() {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    },
  };
}

const offsetOf = (page: Page, testid: string) =>
  page.getByTestId(testid).locator('.screen-body').evaluate((el) => {
    const t = getComputedStyle(el).transform;
    return t === 'none' ? 0 : new DOMMatrix(t).m42;
  });

test('pull to refresh: follows the finger on a rubber band with no re-render, then refreshes', async ({ page }) => {
  await start(page);
  const ptr = page.getByTestId('ptr');
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
  const t0 = Date.now();
  await f.end();
  await expect(ptr).toHaveText('[ refreshing… ]');
  await expect(ptr).toHaveAttribute('aria-busy', 'true');
  await expect(ptr).not.toHaveAttribute('aria-busy', 'true');
  // The spinner stayed up at least 400 ms, then everything sprang back.
  expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  await expect.poll(() => offsetOf(page, 'screen-home')).toBe(0);
  // At rest the content carries no transform at all.
  await expect.poll(() => page.getByTestId('screen-home').locator('.screen-body').evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
});

test('pull to refresh: a short pull springs back, a sideways swipe is ignored', async ({ page, backend }) => {
  await start(page);
  const latest = () => backend.queries.filter((q) => !q.select && !q.startAt).length;
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

test('the back-to-top and search buttons show their press, and the search button tucks away scrolling down', async ({ page }) => {
  await start(page);
  const screen = page.getByTestId('screen-home');
  const fab = page.getByTestId('search-fab');
  // A quick tap still shows the press for a moment (released at once, kept ~120 ms).
  const held = await fab.evaluate(async (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', isPrimary: true, bubbles: true }));
    const at = performance.now();
    const on = el.classList.contains('pressed');
    await new Promise<void>((r) => {
      const check = () => (!el.classList.contains('pressed') ? r() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    return { on, ms: performance.now() - at };
  });
  expect(held.on).toBe(true);
  expect(held.ms).toBeGreaterThanOrEqual(100);

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
  expect(tb.width).toBe(48);
  expect(tb.height).toBe(48);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await fab.evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true }));
    const on = el.classList.contains('pressed');
    el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', isPrimary: true, bubbles: true }));
    return on;
  });
  expect(reduced).toBe(false);
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
  expect((await box(page.getByTestId('seek'))).height).toBe(48);
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
    for (const size of await page.locator(sel).evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)))) expect(size, sel).toBeGreaterThanOrEqual(12);
});

test('the track menu keeps its content while it slides away', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-more').first().click();
  const menu = page.getByTestId('track-menu');
  await expect(menu.getByTestId('menu-share')).toBeVisible();
  const seen = await menu.evaluate(async (el) => {
    const cancel = el.querySelector('.sheet-item.cancel') as HTMLElement;
    cancel.click();
    const items: number[] = [];
    await new Promise<void>((r) => {
      const t0 = performance.now();
      const tick = () => {
        items.push(el.querySelectorAll('.sheet-item').length);
        if (performance.now() - t0 < 150) requestAnimationFrame(tick);
        else r();
      };
      requestAnimationFrame(tick);
    });
    return items;
  });
  // Still all there while it moves (the slide-out takes 200 ms).
  expect(seen.length).toBeGreaterThan(2);
  expect(Math.min(...seen)).toBeGreaterThan(2);
  await expect(menu).toBeHidden();
  await expect(menu.locator('.sheet-item')).toHaveCount(0);
});

test('Now Playing says where the music comes from; under shuffle instead of the position', async ({ page }) => {
  await start(page);
  await playAndOpen(page, 0);
  const from = page.getByTestId('np-from');
  // Home's Latest feed starts a radio from the tapped track.
  const seed = (await page.getByTestId('np-title').textContent())!.trim();
  await expect(from).toContainText(`Radio · ${seed}`);
  await page.getByTestId('np-shuffle').click();
  await expect(from).toHaveText(`Radio · ${seed}`);
  await page.getByTestId('np-shuffle').click();
  await expect(from).not.toHaveText(`Radio · ${seed}`);
  await expect(from).toContainText(`Radio · ${seed}`);
});
