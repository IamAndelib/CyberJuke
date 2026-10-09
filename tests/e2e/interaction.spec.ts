import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { box, openNowPlaying, openSearch, playerCalls, scrollTo, scrollTopOf, seedStorage, start, toastsGone, touchDrag, touchSwipe, touchTap, waitForTracks } from '../helpers';

/**
 * Wave 1c interaction: navigation in place (P4, P5, SM7, M10), undo toasts and confirm
 * sheets (C1, M1, M3), favourites that don't move under the finger (M8), row taps
 * (M9, P10), Search (P9, P7), play contexts and full lists (P2, P3, P8), Settings (C3, U2).
 */

const queues = async (page: Page) =>
  (await playerCalls(page)).filter((c) => c[0] === 'setQueue').map((c) => c[1] as { n: number; context: { label: string; mode: string } });

/** Wall time in the page has moved on by `ms` (a condition, not a sleep). */
async function elapsed(page: Page, ms: number): Promise<void> {
  const t0 = await page.evaluate(() => performance.now());
  await expect.poll(() => page.evaluate(() => performance.now()), { intervals: [50] }).toBeGreaterThan(t0 + ms);
}

test('an artist opens in place on Home; Back returns to the same scroll position (P4, SM7)', async ({ page }) => {
  await start(page);
  await scrollTo(page, 'screen-home', 900);
  // Mark Home's DOM: it must survive the round trip (kept mounted, not rebuilt).
  await page.getByTestId('screen-home').evaluate((el) => ((el as unknown as { __mark: number }).__mark = 1));
  const row = page.locator('[data-testid="track-row"]:visible').filter({ has: page.locator('.row-artist', { hasText: /^[^,]+$/ }) }).nth(12);
  await row.getByTestId('track-more').click();
  // (the click may scroll its row into view: this is where we leave from)
  const y = await scrollTopOf(page, 'screen-home');
  expect(y).toBeGreaterThan(300);
  await page.getByTestId('menu-more-by').first().click();
  const artist = page.getByTestId('screen-artist');
  await expect(artist).toBeVisible();
  await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('screen-home')).toBeHidden();
  await page.getByTestId('artist-back').click();
  await expect(artist).toHaveCount(0);
  await expect(page.getByTestId('screen-home')).toBeVisible();
  expect(Math.abs((await scrollTopOf(page, 'screen-home')) - y)).toBeLessThanOrEqual(2);
  expect(await page.getByTestId('screen-home').evaluate((el) => (el as unknown as { __mark?: number }).__mark)).toBe(1);
});

test('visited tabs keep their place; each tab keeps its own pages (SM7, P4)', async ({ page }) => {
  await start(page);
  await scrollTo(page, 'screen-home', 700);
  const y = await scrollTopOf(page, 'screen-home');
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-grid').getByTestId('genre-tile').first().click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('screen-home')).toBeVisible();
  expect(Math.abs((await scrollTopOf(page, 'screen-home')) - y)).toBeLessThanOrEqual(2);
  // Hidden tabs are kept but not rendered, and can't be reached.
  const hidden = page.locator('[data-pane="genres"]');
  await expect(hidden).toHaveAttribute('inert', '');
  expect(await hidden.evaluate((el) => getComputedStyle(el).contentVisibility)).toBe('hidden');
  // Back on Genres, its genre page is still open.
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
});

test('tapping the tab you are on scrolls to the top, then goes back to its root (P5)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-grid').locator('[data-testid="genre-tile"][data-genre="pop"]').click();
  await waitForTracks(page);
  await scrollTo(page, 'screen-genre', 600);
  await page.getByTestId('tab-genres').click();
  await expect.poll(() => scrollTopOf(page, 'screen-genre')).toBe(0);
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('screen-genre')).toHaveCount(0);
  await expect(page.getByTestId('genre-grid')).toBeVisible();
});

test('Back closes lyrics, then Now Playing; the app is inert only once the sheet is open (M10, SM5)', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await openNowPlaying(page);
  await expect.poll(() => page.locator('.app').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
  await page.getByTestId('np-lyrics-toggle').click();
  await expect(page.getByTestId('np-lyrics')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('np-lyrics')).toHaveCount(0);
  await expect(page.getByTestId('now-playing')).toHaveClass(/open/);
  // Closing: inert goes at once, before the sheet has slid away.
  const inertAtClose = await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    return (document.querySelector('.app') as HTMLElement).inert;
  });
  expect(inertAtClose).toBe(false);
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
});

test('a double tap on a row plays once; tapping the playing row opens Now Playing, a paused one resumes (M9)', async ({ page }) => {
  await start(page);
  const play = page.getByTestId('track-play').nth(2);
  await play.dblclick();
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  expect(await queues(page)).toHaveLength(1);
  await elapsed(page, 550);
  await play.click();
  await expect(page.getByTestId('now-playing')).toHaveClass(/open/);
  expect(await queues(page)).toHaveLength(1); // not restarted
  await page.getByTestId('np-close').click();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  await page.getByTestId('mini-toggle').click();
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Play');
  await elapsed(page, 550);
  await play.click();
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  expect(await queues(page)).toHaveLength(1);
});

/** The Genres grid in its final order (it reorders once the whole catalog has loaded). */
async function genresLoaded(page: Page): Promise<void> {
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('screen-genres').locator('.topbar-sub')).toContainText('genres on the Jukebox');
}

test('the second tap of a double tap on a tile does not land on the new page (M9)', async ({ page }) => {
  await page.goto('/');
  await genresLoaded(page);
  const tile = page.getByTestId('genre-grid').getByTestId('genre-tile').nth(6);
  await expect(tile).toBeVisible();
  const b = await box(tile);
  await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await waitForTracks(page);
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
});

test('a long press on a row opens its menu, and lifting the finger plays nothing (P10)', async ({ page }) => {
  await start(page);
  const b = await box(page.getByTestId('track-play').nth(1));
  const cdp = await page.context().newCDPSession(page);
  const pt = [{ x: b.x + 40, y: b.y + b.height / 2, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await expect(page.getByTestId('track-menu')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(page.getByTestId('track-menu')).toBeVisible();
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
});

test('however long the finger stays down, lifting it after a long press does nothing; the next tap works (P10)', async ({ page }) => {
  await start(page);
  const b = await box(page.getByTestId('track-play').nth(1));
  const cdp = await page.context().newCDPSession(page);
  const pt = [{ x: b.x + 40, y: b.y + b.height / 2, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await expect(page.getByTestId('track-menu')).toBeVisible();
  // Held well past the menu opening.
  await elapsed(page, 2000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(page.getByTestId('track-menu')).toBeVisible();
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
  await page.getByTestId('menu-like').click();
  await expect(page.getByTestId('toast').last()).toHaveText('Added to Liked songs');
});

test('a scroll that starts on a row never opens its menu (P10)', async ({ page }) => {
  await start(page);
  const b = await box(page.getByTestId('track-play').nth(1));
  const cdp = await page.context().newCDPSession(page);
  const x = b.x + 40;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: b.y + 20, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: b.y - 40, id: 1 }] });
  await elapsed(page, 700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(page.getByTestId('track-menu')).toBeHidden();
});

test('favouriting a genre tile: a plain toast, Favourites follows at once; removing has Undo (C1, M1, P6)', async ({ page }) => {
  await page.goto('/');
  await genresLoaded(page);
  const grid = page.getByTestId('genre-grid');
  const genre = (await grid.getByTestId('genre-cell').nth(3).getAttribute('data-genre'))!;
  // By name: the tile moves between the grid and ★ Favourites.
  const cellOf = (g: string) => grid.locator(`[data-testid="genre-cell"][data-genre="${g}"]`);
  const star = cellOf(genre).getByTestId('genre-fav');
  await expect(star.locator('svg')).toHaveAttribute('data-icon', 'starOutline');
  await star.click();
  // Adding: a confirmation, nothing to undo (tapping the star again does that).
  const toast = page.getByTestId('toast').last();
  await expect(toast).toHaveText(`${genre} added to Favourites`);
  await expect(toast.getByTestId('toast-action')).toHaveCount(0);
  // It moves up into ★ Favourites at once, starred; no copy stays in the grid.
  const favs = page.getByTestId('fav-genres');
  await expect(favs.getByTestId('genre-tile')).toHaveText([genre]);
  await expect(favs.getByTestId('genre-fav').locator('svg')).toHaveAttribute('data-icon', 'star');
  await expect(cellOf(genre)).toHaveCount(0);

  // Favourite a second one, then unfavourite the first from the Favourites section: it goes
  // at once, and Undo puts it back first.
  const other = (await grid.getByTestId('genre-cell').nth(5).getAttribute('data-genre'))!;
  await cellOf(other).getByTestId('genre-fav').click();
  await expect(favs.getByTestId('genre-tile')).toHaveText([genre, other]);
  // One message at a time: the newer one replaces the last.
  await expect(page.getByTestId('toast')).toHaveCount(1);
  await expect(page.getByTestId('toast')).toHaveText(`${other} added to Favourites`);
  await favs.getByTestId('genre-fav').first().click();
  await expect(favs.getByTestId('genre-tile')).toHaveText([other]);
  // Back in the grid, unstarred.
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  const removed = page.getByTestId('toast').last();
  await expect(removed).toContainText(`${genre} removed from Favourites`);
  const undo = removed.getByTestId('toast-action');
  expect((await box(undo)).height).toBeGreaterThanOrEqual(48);
  expect(await removed.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto');
  await undo.click();
  await expect(favs.getByTestId('genre-tile')).toHaveText([genre, other]);
  await expect(cellOf(genre)).toHaveCount(0);
});

/** Star a genre tile, then unstar it in ★ Favourites: leaves the "removed … Undo" toast on screen. */
async function removedToast(page: Page, nth: number) {
  const grid = page.getByTestId('genre-grid');
  const genre = (await grid.getByTestId('genre-cell').nth(nth).getAttribute('data-genre'))!;
  const star = grid.locator(`[data-testid="genre-cell"][data-genre="${genre}"]`).getByTestId('genre-fav');
  await star.click();
  await page.getByTestId('fav-genres').locator(`[data-testid="genre-cell"][data-genre="${genre}"]`).getByTestId('genre-fav').click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  const toast = page.getByTestId('toast').last();
  await expect(toast).toContainText('removed from Favourites');
  return { toast, star };
}

test('a toast swiped left or right goes; a short drag springs back; a swipe from Undo does not undo', async ({ page }) => {
  await page.goto('/');
  await genresLoaded(page);
  for (const dir of [-1, 1]) {
    const { toast, star } = await removedToast(page, 2);
    const b = await box(toast);
    const y = b.y + b.height / 2;
    const x = b.x + b.width / 3;
    await touchSwipe(page, x, x + dir * b.width * 0.6, y, 200);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    // Dismissed, not undone.
    await expect(star).toHaveAttribute('aria-pressed', 'false');
  }

  // A short drag springs back: the toast stays, back in place, and still has its Undo.
  const { toast, star } = await removedToast(page, 4);
  const b = await box(toast);
  await touchSwipe(page, b.x + b.width / 3, b.x + b.width / 3 + 30, b.y + b.height / 2, 600);
  await expect(toast).toBeVisible();
  await expect.poll(() => toast.evaluate((el) => getComputedStyle(el).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
  await expect(toast.getByTestId('toast-action')).toBeVisible();

  // A swipe that starts on the Undo button dismisses; it doesn't press Undo.
  const undo = await box(toast.getByTestId('toast-action'));
  await touchSwipe(page, undo.x + undo.width / 2, undo.x + undo.width / 2 - b.width * 0.6, undo.y + undo.height / 2, 200);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await expect(star).toHaveAttribute('aria-pressed', 'false');
});

test('after swiping a toast away, the next tap on the heart works the first time', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await openNowPlaying(page);
  const heart = page.getByTestId('np-like');
  for (const how of ['flick', 'slow'] as const) {
    await heart.click();
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'false');
    const toast = page.getByTestId('toast').last();
    await expect(toast).toContainText('Removed from Liked');
    const b = await box(toast);
    const x = b.x + b.width / 3;
    await touchSwipe(page, x, x + b.width * 0.7, b.y + b.height / 2, how === 'flick' ? 90 : 500, how === 'flick' ? 4 : 12);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    // One finger tap, straight after: it likes the song.
    await touchTap(page, heart);
    await expect(heart, `after a ${how} swipe`).toHaveAttribute('aria-pressed', 'true');
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('toast')).toHaveCount(1);
    await page.getByTestId('toast').last().getByTestId('toast-action').click();
    await heart.click();
  }
});

test('a toast goes as soon as the user does something else: a scroll, a tap elsewhere, the wheel', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await openNowPlaying(page);
  const heart = page.getByTestId('np-like');
  const toast = page.getByTestId('toast');

  // Liked, then a finger scrolls Now Playing: the toast goes at once.
  await heart.click();
  await expect(toast).toHaveText('Added to Liked songs');
  const np = await box(page.getByTestId('now-playing'));
  await touchDrag(page, np.x + np.width / 2, np.y + np.height * 0.7, np.y + np.height * 0.4, 300);
  await expect(toast).toHaveCount(0);

  // Unliked, then a tap somewhere else (the shuffle button): gone.
  await heart.click();
  await expect(toast).toContainText('Removed from Liked');
  await page.getByTestId('np-shuffle').click();
  await expect(toast).toHaveCount(0);
  await page.getByTestId('np-shuffle').click();

  // The mouse wheel counts too.
  await heart.click();
  await expect(toast).toHaveCount(1);
  await page.mouse.move(np.x + np.width / 2, np.y + np.height / 2);
  await page.mouse.wheel(0, 200);
  await expect(toast).toHaveCount(0);

  // Undo on the toast itself still works.
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await toast.getByTestId('toast-action').click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(toast).toHaveCount(0);
});

test('Clear history asks first, away from Play; Undo brings the plays back (M3, M1)', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').nth(0).click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await page.getByTestId('track-play').nth(1).click();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('screen-library').locator('.topbar-sub')).toHaveText('On this device');
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('recent-list').getByTestId('track-row')).toHaveCount(2);
  const clear = page.getByTestId('lib-clear');
  const play = page.getByTestId('lib-play-all');
  await expect(play).toHaveText(/Play$/);
  expect((await box(play)).y - (await box(clear)).y).toBeGreaterThan(40);
  await clear.click();
  const sheet = page.getByTestId('confirm-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('confirm-ok')).toHaveText('Clear 2 plays');
  await page.getByTestId('confirm-cancel').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('recent-list').getByTestId('track-row')).toHaveCount(2);
  await clear.click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('recent-list').getByTestId('track-row')).toHaveCount(0);
  // Clear has gone with the plays: focus stays on the page, not lost to the document.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="screen-library"]'))).toBe(true);
  const toast = page.getByTestId('toast').last();
  await expect(toast).toContainText('Cleared 2 plays');
  await toast.getByTestId('toast-action').click();
  await expect(page.getByTestId('recent-list').getByTestId('track-row')).toHaveCount(2);
});

test('lists play with their context: Home is a radio, a genre plays its whole list, Play turns shuffle off (P2, P3, P8)', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await expect.poll(async () => (await queues(page)).at(-1)?.context).toEqual({ label: 'Home · Latest', mode: 'radio' });

  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-grid').locator('[data-testid="genre-tile"][data-genre="pop"]').click();
  await waitForTracks(page);
  const sub = page.getByTestId('screen-genre').locator('.topbar-sub');
  await expect(sub).toHaveText(/^\d+ tracks?$/);
  const total = Number(/\d+/.exec((await sub.textContent())!)![0]);
  const loaded = await page.getByTestId('screen-genre').getByTestId('track-row').count();
  expect(total).toBeGreaterThan(loaded);
  await page.getByTestId('genre-shuffle').click();
  await expect.poll(async () => (await queues(page)).at(-1)?.context).toEqual({ label: 'pop', mode: 'list' });
  expect((await queues(page)).at(-1)!.n).toBe(total);
  await openNowPlaying(page);
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('np-close').click();
  await expect(page.getByTestId('genre-play-all')).toHaveText(/Play$/);
  await page.getByTestId('genre-play-all').click();
  await expect.poll(async () => (await queues(page)).length).toBe(3);
  await openNowPlaying(page);
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'false');
});

test('Search: the last query comes back selected, recent searches can be reused and cleared (P9)', async ({ page }) => {
  await start(page);
  await openSearch(page);
  const input = page.getByTestId('search-input');
  await input.fill('lumen');
  await input.press('Enter');
  await page.getByTestId('search-close').click();
  await openSearch(page);
  await expect(input).toHaveValue('lumen');
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 5]);
  await page.getByTestId('search-clear').click();
  const recent = page.getByTestId('recent-search');
  await expect(recent).toHaveText([/lumen/]);
  // Kept across a restart (the query itself isn't).
  await page.reload();
  await waitForTracks(page);
  await openSearch(page);
  await expect(input).toHaveValue('');
  await expect(recent).toHaveText([/lumen/]);
  await recent.first().click();
  await expect(input).toHaveValue('lumen');
  await expect(page.getByTestId('search-results').or(page.getByTestId('search-empty'))).toBeVisible();
  await page.getByTestId('search-clear').click();
  await page.getByTestId('recent-search-remove').first().click();
  await expect(page.getByTestId('recent-searches')).toHaveCount(0);
});

test.describe('Global results', () => {
  test.use({ musicOptions: { delay: 1500 } });
  test('stay on screen, dimmed with a progress line, while the next ones load (P7)', async ({ page }) => {
    await page.goto('/');
    await openSearch(page);
    await page.getByTestId('mode-global').click();
    const input = page.getByTestId('search-input');
    await input.fill('night');
    await expect(page.getByTestId('global-results')).toBeVisible();
    await input.fill('night owls');
    await expect(page.getByTestId('global-stale')).toBeVisible();
    await expect(page.getByTestId('global-loading')).toBeVisible();
    await expect(page.getByTestId('skeleton')).toHaveCount(0);
    await expect(page.getByTestId('global-results').locator('.row-artist').first()).toContainText('night owls');
    await expect(page.getByTestId('global-stale')).toHaveCount(0);
  });
});

test('the artist page says when the Jukebox could not load, and Retry loads it (P7)', async ({ page }) => {
  // The catalog (field-masked, 300-row pages) fails until let through.
  let failing = true;
  await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    const q = route.request().method() === 'POST' ? JSON.parse(route.request().postData() ?? '{}').structuredQuery : null;
    if (failing && q?.limit === 300) return route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    return route.fallback();
  });
  await page.goto('/');
  await openSearch(page);
  await page.getByTestId('mode-global').click();
  await page.getByTestId('search-input').fill('Lumen');
  await page.getByTestId('filter-artists').click();
  await page.getByTestId('music-open').first().click();
  const jukebox = page.getByTestId('screen-artist').getByTestId('artist-jukebox');
  await expect(jukebox.getByTestId('error')).toContainText("Couldn't load the Jukebox");
  await expect(jukebox.getByTestId('skeleton')).toHaveCount(0);
  failing = false;
  await jukebox.getByTestId('retry').click();
  await expect(jukebox.getByTestId('error')).toHaveCount(0);
  await expect(jukebox.getByTestId('track-row').first().or(jukebox.locator('.section-note'))).toBeVisible();
});

test('Autoplay is on by default and the setting is kept; Settings lines are short (C3, U2)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const toggle = page.getByTestId('autoplay-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const settings = page.getByTestId('screen-settings');
  await expect(settings).toContainText('Plays similar songs when your list ends.');
  for (const line of ['Hidden by default.', 'Low saves data.', 'Shows a button on Home when new tracks are posted.', 'Auto switches when IPv6 gets blocked.']) {
    await expect(settings).toContainText(line);
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('autoplay-toggle')).toHaveAttribute('aria-checked', 'false');
});

test('saved settings without the Autoplay key keep it on', async ({ page }) => {
  await seedStorage(page, { 'CapacitorStorage.settings': { theme: 'dark', showNsfw: false, quality: 'high' } });
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('autoplay-toggle')).toHaveAttribute('aria-checked', 'true');
  await toastsGone(page);
});

test('a sheet is modal: what is behind it is inert and takes no pan, focus goes in and comes back', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await openNowPlaying(page);
  const np = page.getByTestId('now-playing');
  const more = page.getByTestId('np-more');
  await more.click();
  const menu = page.getByTestId('track-menu');
  await expect(menu).toBeVisible();
  // Now Playing (and the app under it) can't be touched or scrolled from under the sheet.
  await expect.poll(() => np.evaluate((el) => (el as HTMLElement).inert)).toBe(true);
  expect(await page.locator('.app').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
  expect(await menu.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  expect(await page.locator('.sheet-wrap.open').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  // Focus is in the sheet; Cancel gives it back to the ⋯ button, and Now Playing is live again.
  await expect.poll(() => menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await menu.getByRole('button', { name: '[Cancel]' }).click();
  await expect.poll(() => np.evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  await expect(more).toBeFocused();
  expect(await page.locator('.app').evaluate((el) => (el as HTMLElement).inert)).toBe(true); // still behind Now Playing

  // From a row: the app is inert while the menu is up, and comes back after.
  await page.getByTestId('np-close').click();
  await expect.poll(() => page.locator('.app').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  const rowMore = page.getByTestId('track-more').nth(1);
  await rowMore.click();
  await expect.poll(() => page.locator('.app').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect.poll(() => page.locator('.app').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  await expect(rowMore).toBeFocused();
});

test('a toast never covers back-to-top or the block banner, and a plain one lets taps through', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  const home = page.getByTestId('screen-home');
  await home.evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  const top = home.getByTestId('back-to-top');
  await expect(top).toBeVisible();
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  // Unliked from a row's ⋯ menu: an Undo toast, clear of back-to-top, which still works.
  const row = page.locator('[data-testid="screen-home"] [data-testid="track-more"]').nth(30);
  await row.click();
  await page.getByTestId('menu-like').click();
  await row.click();
  await page.getByTestId('menu-like').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toHaveText(/Removed from Liked/);
  expect(overlaps(await box(toast), await box(top))).toBe(false);
  await touchTap(page, top);
  await expect.poll(() => scrollTopOf(page, 'screen-home')).toBe(0);

  // A plain toast, wherever it sits, never takes a tap: the tap lands on what's under it.
  await expect(toast).toHaveCount(0);
  await page.getByTestId('track-more').first().click();
  await page.getByTestId('menu-like').click();
  await expect(toast).toHaveText('Added to Liked songs');
  expect(await toast.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  // While YouTube is blocked, the banner sits above the mini player: the toast sits above both.
  await page.evaluate(() => (window as unknown as { __cyberjukeBlock: { blocked(e: unknown): void } }).__cyberjukeBlock.blocked({ until: Date.now() + 5 * 60_000, reason: 'BOT_CHECK' }));
  const banner = page.getByTestId('block-banner');
  await expect(banner).toBeVisible();
  await page.getByTestId('track-more').first().click();
  await page.getByTestId('menu-like').click();
  await expect(toast).toHaveText(/Removed from Liked/);
  const t = await box(toast);
  expect(t.y + t.height).toBeLessThanOrEqual((await box(banner)).y);
});

test('a second tap where a starred tile was does not star the tile that took its place', async ({ page }) => {
  await page.goto('/');
  await genresLoaded(page);
  const grid = page.getByTestId('genre-grid');
  const favs = page.getByTestId('fav-genres').getByTestId('genre-tile');
  // One favourite already: the next fills its row, so the grid below doesn't move.
  const first = (await grid.getByTestId('genre-cell').nth(0).getAttribute('data-genre'))!;
  await grid.getByTestId('genre-cell').nth(0).getByTestId('genre-fav').click();
  await expect(favs).toHaveText([first]);
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 5000 });
  const genre = (await grid.getByTestId('genre-cell').nth(3).getAttribute('data-genre'))!;
  const next = (await grid.getByTestId('genre-cell').nth(4).getAttribute('data-genre'))!;
  const b = await box(grid.getByTestId('genre-cell').nth(3).getByTestId('genre-fav'));
  // A double tap on the star: the first stars it (it moves up), the second lands on the next.
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await elapsed(page, 150);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await elapsed(page, 300);
  await expect(favs).toHaveText([first, genre]);
  const nextStar = grid.locator(`[data-testid="genre-cell"][data-genre="${next}"]`).getByTestId('genre-fav');
  await expect(nextStar).toHaveAttribute('aria-pressed', 'false');
  // It took the starred one's place; a moment later, a tap there works again.
  expect(Math.abs((await box(nextStar)).y - b.y)).toBeLessThan(2);
  await elapsed(page, 800);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(favs).toHaveText([first, genre, next]);
});

test('starring from the keyboard keeps focus on the star, which moves with its tile', async ({ page }) => {
  await page.goto('/');
  await genresLoaded(page);
  const grid = page.getByTestId('genre-grid');
  const genre = (await grid.getByTestId('genre-cell').nth(2).getAttribute('data-genre'))!;
  const focused = () => page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a ? `${a.dataset.testid}:${a.closest('[data-genre]')?.getAttribute('data-genre')}:${a.closest('[data-testid="fav-genres"]') ? 'favs' : 'grid'}` : null;
  });
  await grid.locator(`[data-testid="genre-cell"][data-genre="${genre}"]`).getByTestId('genre-fav').focus();
  await page.keyboard.press('Enter');
  await expect.poll(focused).toBe(`genre-fav:${genre}:favs`);
  await page.keyboard.press('Enter');
  await expect.poll(focused).toBe(`genre-fav:${genre}:grid`);
});
