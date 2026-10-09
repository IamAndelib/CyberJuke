import { expect, test } from '../fixtures';
import { expectStable, nextFrame, openSearch, scrollTo, scrollTopOf, start, waitForTracks } from '../helpers';

/** Scroll memory, back-to-top, and the overlay scrollbar / A–Z fast scroller. */

test('Genres remembers the grid position across a genre page, and each genre list too', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('screen-genres').locator('.topbar-sub')).toContainText(/\d+ genres/);
  await scrollTo(page, 'screen-genres', 1500);
  const y = await scrollTopOf(page, 'screen-genres');
  expect(y).toBeGreaterThan(1400);
  // The genre tile in the middle of the screen.
  const genre = await page.evaluate(() => {
    const mid = innerHeight / 2;
    const tiles = [...document.querySelectorAll('[data-testid="genre-grid"] [data-testid="genre-tile"]')];
    const t = tiles.find((el) => {
      const r = el.getBoundingClientRect();
      return r.top <= mid && r.bottom >= mid - 80;
    });
    return t?.getAttribute('data-genre') ?? '';
  });
  expect(genre).toBeTruthy();
  const tile = (g: string) => page.locator(`[data-testid="genre-grid"] [data-testid="genre-tile"][data-genre="${g}"]`);
  await tile(genre).click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await waitForTracks(page);
  await page.getByTestId('genre-back').click();
  await expect(page.getByTestId('genre-grid')).toBeVisible();
  await expect.poll(() => scrollTopOf(page, 'screen-genres')).toBeGreaterThan(y - 10);
  expect(Math.abs((await scrollTopOf(page, 'screen-genres')) - y)).toBeLessThanOrEqual(10);
  await tile(genre).click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('genre-grid')).toBeVisible();
  await expect.poll(() => scrollTopOf(page, 'screen-genres')).toBeGreaterThan(y - 10);

  // A long genre list: scroll it, leave, reopen, and it's where you were.
  await scrollTo(page, 'screen-genres', 0);
  const top = (await page.getByTestId('genre-grid').getByTestId('genre-tile').first().getAttribute('data-genre'))!;
  await tile(top).click();
  await waitForTracks(page);
  await scrollTo(page, 'screen-genre', 900);
  const listY = await scrollTopOf(page, 'screen-genre');
  expect(listY).toBeGreaterThan(800);
  await page.getByTestId('genre-back').click();
  await expect(page.getByTestId('genre-grid')).toBeVisible();
  expect(await scrollTopOf(page, 'screen-genres')).toBeLessThanOrEqual(10);
  await tile(top).click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await expect.poll(() => scrollTopOf(page, 'screen-genre')).toBeGreaterThan(listY - 10);
  expect(Math.abs((await scrollTopOf(page, 'screen-genre')) - listY)).toBeLessThanOrEqual(10);
});

test('Home keeps its loaded pages and scroll position across tab switches', async ({ page, backend }) => {
  await start(page);
  const rows = page.getByTestId('track-row');
  // Scroll past two pages (24 posts each).
  await expect
    .poll(async () => {
      await scrollTo(page, 'screen-home', 1e6);
      return rows.count();
    })
    .toBeGreaterThan(48);
  const target = await page.getByTestId('screen-home').evaluate((el) => {
    const row = el.querySelectorAll('[data-testid="track-row"]')[40] as HTMLElement;
    el.scrollTo(0, row.offsetTop - 120);
    return el.scrollTop;
  });
  // Let a page that was already on its way land.
  const count = await expectStable(() => rows.count(), 800);
  const firstPages = () => backend.queries.filter((q) => !q.startAt && !q.select).length;
  const fetched = firstPages();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('screen-library')).toBeVisible();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('screen-home')).toBeVisible();
  // Nothing lost and no refetch: every loaded row is back at once.
  expect(await rows.count()).toBeGreaterThanOrEqual(count);
  expect(firstPages()).toBe(fetched);
  await expect.poll(async () => Math.abs((await scrollTopOf(page, 'screen-home')) - target)).toBeLessThanOrEqual(10);
});

test('back-to-top shows after scrolling, scrolls to the top, and stays clear of the other buttons', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  const btn = page.getByTestId('screen-home').getByTestId('back-to-top');
  await expect(btn).toBeHidden();
  await scrollTo(page, 'screen-home', 500);
  await expect(btn).toBeHidden();
  await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-label', 'Back to top');
  const b = (await btn.boundingBox())!;
  const f = (await page.getByTestId('search-fab').boundingBox())!;
  const m = (await page.getByTestId('mini-player').boundingBox())!;
  expect(b.width).toBeGreaterThanOrEqual(44);
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.x + b.width + 8).toBeLessThanOrEqual(f.x);
  expect(b.y + b.height + 4).toBeLessThanOrEqual(m.y);
  expect(Math.abs(b.x + b.width / 2 + 2 - page.viewportSize()!.width / 2)).toBeLessThanOrEqual(4);
  await btn.click();
  await expect.poll(() => scrollTopOf(page, 'screen-home')).toBe(0);
  await expect(btn).toBeHidden();
});

test('the last row stays clear of back-to-top and search buttons at the end of a list', async ({ page }) => {
  await start(page);
  await page.getByTestId('sort-saved').click();
  await page.getByTestId('range-all').click();
  await expect(page.getByTestId('saved-list')).toBeVisible();
  // Most saved (100 rows) renders in chunks: scroll until the end shows.
  await expect
    .poll(async () => {
      await scrollTo(page, 'screen-home', 1e6);
      return page.getByTestId('saved-list').locator('.list-foot:not(.end)').count();
    })
    .toBe(0);
  await scrollTo(page, 'screen-home', 1e6);
  const btn = page.getByTestId('screen-home').getByTestId('back-to-top');
  await expect(btn).toBeVisible();
  const more = (await page.getByTestId('track-more').last().boundingBox())!;
  const b = (await btn.boundingBox())!;
  const f = (await page.getByTestId('search-fab').boundingBox())!;
  expect(more.y + more.height).toBeLessThanOrEqual(Math.min(b.y, f.y));
});

test('back-to-top: finger down stops a fling, finger up jumps to the top, with no click needed', async ({ page }) => {
  await start(page);
  await openSearch(page);
  await expect(page.getByTestId('search-latest').getByTestId('track-row').first()).toBeVisible();
  const screen = page.getByTestId('search');
  const btn = screen.getByTestId('back-to-top');
  await screen.evaluate((el) => el.scrollTo(0, el.clientHeight * 2));
  await expect(btn).toBeVisible();
  // Touch pointer events on the button, as a finger sends them.
  await page.evaluate(() => {
    const w = window as unknown as { __press: (type: string, dy?: number) => boolean };
    w.__press = (type, dy = 0) => {
      const btn = document.querySelector('[data-testid="search"] [data-testid="back-to-top"]') as HTMLElement;
      const r = btn.getBoundingClientRect();
      const e = new PointerEvent(type, { pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 + dy });
      btn.dispatchEvent(e);
      return e.defaultPrevented;
    };
  });
  type Press = { __press: (type: string, dy?: number) => boolean };
  // A fling: a long native smooth scroll still under way when the button is pressed.
  const run = await screen.evaluate(async (el) => {
    const press = (window as unknown as Press).__press;
    const btn = el.querySelector('[data-testid="back-to-top"]') as HTMLElement;
    let clicks = 0;
    btn.addEventListener('click', () => clicks++);
    el.scrollBy({ top: 4000, behavior: 'smooth' });
    // Wait until the fling is moving.
    const start = el.scrollTop;
    await new Promise<void>((r) => {
      const check = () => (el.scrollTop > start + 50 ? r() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    const prevented = press('pointerdown');
    // Finger still down: the fling has stopped, and nothing jumps yet.
    const held: number[] = [];
    await new Promise<void>((r) => {
      const t0 = performance.now();
      const tick = () => {
        held.push(el.scrollTop);
        if (performance.now() - t0 < 300) requestAnimationFrame(tick);
        else r();
      };
      requestAnimationFrame(tick);
    });
    const seen: number[] = [];
    const onScroll = () => seen.push(el.scrollTop);
    el.addEventListener('scroll', onScroll);
    press('pointerup');
    // Until the top is reached (or 3 s).
    await new Promise<void>((r) => {
      const t0 = performance.now();
      const check = () => (el.scrollTop === 0 || performance.now() - t0 > 3000 ? r() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    el.removeEventListener('scroll', onScroll);
    return { start, held, seen, end: el.scrollTop, clicks, prevented };
  });
  expect(run.prevented).toBe(true);
  expect(run.held[0]).toBeGreaterThan(run.start);
  // Stopped: one frame of momentum already on its way may still land, then nothing moves.
  expect(run.held.length).toBeGreaterThan(5);
  expect(new Set(run.held.slice(2)).size).toBe(1);
  expect(run.clicks).toBe(0);
  expect(run.end).toBe(0);
  expect(new Set(run.seen).size).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < run.seen.length; i++) expect(run.seen[i]).toBeLessThanOrEqual(run.seen[i - 1]);
  await expectStable(() => screen.evaluate((el) => el.scrollTop), 300); // no momentum came back
  await expect(btn).toBeHidden();

  // A finger that moves 10px or more on the button is scrolling: no jump.
  await screen.evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect(btn).toBeVisible();
  const kept = await screen.evaluate((el) => {
    const press = (window as unknown as Press).__press;
    const from = el.scrollTop;
    press('pointerdown');
    press('pointermove', 12);
    press('pointerup', 12);
    return { from, now: el.scrollTop };
  });
  expect(kept.now).toBe(kept.from);
  await expectStable(() => screen.evaluate((el) => el.scrollTop), 400);
  expect(await screen.evaluate((el) => el.scrollTop)).toBe(kept.from);

  // A touch on the list during the jump stops it where it is.
  const at = await screen.evaluate(async (el) => {
    const press = (window as unknown as Press).__press;
    const row = el.querySelector('[data-testid="track-row"]') as HTMLElement;
    const from = el.scrollTop;
    press('pointerdown');
    press('pointerup');
    await new Promise<void>((r) => {
      const check = () => (el.scrollTop < from - 20 ? r() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    row.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }));
    return el.scrollTop;
  });
  expect(at).toBeGreaterThan(0);
  await expectStable(() => screen.evaluate((el) => el.scrollTop), 500);
  expect(await screen.evaluate((el) => el.scrollTop)).toBe(at);

  // Keyboard still works (Enter clicks it).
  await expect(btn).toBeVisible();
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => screen.evaluate((el) => el.scrollTop)).toBe(0);

  // Reduced motion: straight to the top on finger up.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await screen.evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect(btn).toBeVisible();
  const instant = await screen.evaluate((el) => {
    const press = (window as unknown as Press).__press;
    press('pointerdown');
    const down = el.scrollTop;
    press('pointerup');
    return { down, up: el.scrollTop };
  });
  expect(instant.down).toBeGreaterThan(0);
  expect(instant.up).toBe(0);
});

test('scrollbar: appears while scrolling, fades, and drags on a long list; A–Z letter only while dragging', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('grid-sort-az').click();
  const screen = page.getByTestId('screen-artists');
  await expect(screen.getByTestId('az-head').first()).toBeVisible();
  // Every chunk rendered: the list has its full height.
  const n = Number(/\d+/.exec((await screen.locator('.topbar-sub').textContent())!)![0]);
  await expect(screen.getByTestId('artist-tile')).toHaveCount(n);
  const sb = screen.getByTestId('scrollbar');
  expect(await screen.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(0);
  await expect(sb).not.toHaveClass(/\bon\b/);
  await expect(screen.getByTestId('scroll-label')).toHaveCount(0);
  await expect(screen.locator('.sb-label')).toHaveCount(0);

  // Ordinary scrolling shows the thumb but never the letter popup.
  const popup = screen.getByTestId('az-popup');
  await screen.evaluate((el) => {
    const w = window as unknown as { __popSeen: boolean };
    w.__popSeen = false;
    const pop = el.querySelector('[data-testid="az-popup"]')!;
    new MutationObserver(() => {
      if (pop.classList.contains('on')) w.__popSeen = true;
    }).observe(pop, { attributes: true, attributeFilter: ['class'] });
  });
  for (const f of [0.1, 0.2, 0.3]) {
    await screen.evaluate((el, frac) => el.scrollTo(0, el.scrollHeight * frac), f);
    await nextFrame(page);
  }
  await page.mouse.move(200, 400);
  await page.mouse.wheel(0, 600);
  await expect(sb).toHaveClass(/\bon\b/);
  await expect(sb).toHaveClass(/draggable/);
  await nextFrame(page);
  await expect(popup).not.toHaveClass(/\bon\b/);
  expect(await page.evaluate(() => (window as unknown as { __popSeen: boolean }).__popSeen)).toBe(false);
  await expect(sb).not.toHaveClass(/\bon\b/, { timeout: 2500 });

  const topLetter = () =>
    screen.evaluate((el) => {
      const top = el.querySelector('.topbar')!.getBoundingClientRect().bottom + 8;
      let cur = '';
      for (const h of el.querySelectorAll<HTMLElement>('.az-head')) if (h.offsetParent && h.getBoundingClientRect().top <= top) cur = h.dataset.letter!;
      return cur;
    });

  await screen.evaluate((el) => el.scrollBy(0, 10));
  const thumb = screen.getByTestId('scroll-thumb');
  const tb = (await thumb.boundingBox())!;
  // 24px to grab at rest (clear of the tiles' stars), wider once dragging.
  expect(tb.width).toBe(24);
  const before = await screen.evaluate((el) => el.scrollTop);
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 10);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 250, { steps: 6 });
  await expect(sb).toHaveClass(/dragging/);
  expect((await thumb.boundingBox())!.width).toBeCloseTo(48, 1);
  await expect(popup).toHaveClass(/\bon\b/);
  await expect.poll(async () => (await popup.textContent()) === (await topLetter())).toBe(true);
  const pb = (await popup.locator('.az-pop-letter').boundingBox())!;
  expect(pb.width).toBeGreaterThanOrEqual(90);
  expect(Math.abs(pb.x + pb.width / 2 - page.viewportSize()!.width / 2)).toBeLessThanOrEqual(8);
  // Holding still mid-drag keeps it up (longer than the 600 ms fade).
  await expectStable(() => popup.getAttribute('class'), 900);
  await page.mouse.move(tb.x + tb.width / 2, 2000, { steps: 6 });
  await expect.poll(() => screen.evaluate((el) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) <= 2)).toBe(true);
  await expect.poll(async () => (await popup.textContent()) === (await topLetter())).toBe(true);
  await page.mouse.up();
  expect(await screen.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  await expect(sb).not.toHaveClass(/dragging/);
  await expect(popup).not.toHaveClass(/\bon\b/, { timeout: 1500 });
  const track = (await screen.locator('.sb-track').boundingBox())!;
  const fab = (await page.getByTestId('search-fab').boundingBox())!;
  expect(track.y + track.height).toBeLessThanOrEqual(fab.y);
  // The drag never pulled to refresh.
  await expect(screen.locator('.screen-body')).toHaveCSS('transform', 'none');
});

test('scrollbar: no letter popup in Popular order; reduced motion has no fade transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const screen = page.getByTestId('screen-genres');
  await expect(screen.getByTestId('genre-tile').first()).toBeVisible();
  await page.getByTestId('grid-sort-popular').click();
  await screen.evaluate((el) => el.scrollTo(0, 600));
  await expect(screen.getByTestId('scrollbar')).toHaveClass(/\bon\b/);
  await expect(screen.getByTestId('az-popup')).toHaveCount(0);
  const dur = await screen.getByTestId('scrollbar').evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(dur).toBeLessThan(0.01);
});

test('A–Z letter: a letter whose genres are all in Favourites is skipped, not shown over the one before', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('grid-sort-az').click();
  const screen = page.getByTestId('screen-genres');
  const sections = screen.getByTestId('az-section');
  await expect(sections.nth(2)).toBeVisible();
  const [first, second] = [(await sections.nth(0).getAttribute('data-letter'))!, (await sections.nth(1).getAttribute('data-letter'))!];
  // Every genre under the second letter starred (last first, so no tile slides under the next tap).
  const stars = sections.nth(1).getByTestId('genre-fav');
  for (let i = (await stars.count()) - 1; i >= 0; i--) await stars.nth(i).click();
  await expect(screen.locator(`[data-testid="az-section"][data-letter="${second}"]`)).toBeHidden();
  // Scrolled into the first letter's tiles: the letter is the first one.
  await screen.evaluate((el, l) => {
    const h = el.querySelector<HTMLElement>(`.az-head[data-letter="${l}"]`)!;
    const head = el.querySelector('.topbar')!.getBoundingClientRect().height;
    el.scrollTo(0, el.scrollTop + h.getBoundingClientRect().top - el.getBoundingClientRect().top - head + 30);
  }, first);
  // The letters are read again there (as after any resize).
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: vp.width, height: vp.height - 1 });
  await nextFrame(page);
  await nextFrame(page);
  await expect(screen.locator('.az-pop-letter')).toHaveText(first);
});
