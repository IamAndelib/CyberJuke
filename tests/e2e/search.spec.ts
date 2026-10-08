import { expect, test } from '../fixtures';
import { musicCalls, openSearch, scrollTo, start, waitForTracks } from '../helpers';

/** Search: Jukebox (the local catalog), Global (the music plugin) and Here (the screen it was opened from). */

const BOT_TEXT = "Global search isn't available on this network right now, try again later";

test('search opens straight to the latest tracks, in chunks, with no hint text', async ({ page }) => {
  await start(page);
  const newest = (await page.getByTestId('track-title').first().textContent())!.trim();
  await openSearch(page);
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
  const latest = page.getByTestId('search-latest');
  await expect(latest).toBeVisible();
  await expect(page.getByTestId('search-hint')).toHaveCount(0);
  await expect(page.getByTestId('search')).not.toContainText('Search all');
  await expect(latest.getByTestId('track-title').first()).toHaveText(newest);
  const rows = latest.getByTestId('track-row');
  expect(await rows.count()).toBe(60);
  await scrollTo(page, 'search', 1e6);
  await expect.poll(() => rows.count()).toBeGreaterThan(60);
  const title = (await rows.nth(3).getByTestId('track-title').textContent())!.trim();
  await rows.nth(3).getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);
});

test('search finds an artist from the first page and plays it; Escape closes', async ({ page }) => {
  await start(page);
  const row = page.getByTestId('track-row').filter({ has: page.locator('.row-artist', { hasText: /^[^,]{4,}$/ }) }).first();
  const artist = (await row.locator('.row-artist').textContent())!.trim();
  const title = (await row.getByTestId('track-title').textContent())!.trim();
  await openSearch(page);
  await page.getByTestId('search-input').fill(artist);
  const results = page.getByTestId('search-results');
  const hit = results.getByTestId('track-row').filter({ hasText: title }).filter({ hasText: artist }).first();
  await expect(hit).toBeVisible();
  await hit.getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);
  await page.getByTestId('search-clear').click();
  await expect(page.getByTestId('search-latest')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search')).toHaveCount(0);
  await expect(page.getByTestId('screen-home')).toBeVisible();
});

test('search tolerates a typo and offers genre chips', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  await page.getByTestId('search-input').fill('electronik');
  await expect(page.getByTestId('search-genre').first()).toBeVisible();
  const genre = (await page.getByTestId('search-genre').first().getAttribute('data-genre'))!;
  await page.getByTestId('search-genre').first().click();
  await expect(page.getByTestId('search')).toHaveCount(0);
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await expect(page.locator('.topbar-title')).toHaveText(genre);
});

test('search header: lean, same height in both modes, underline on the rule, 44px targets', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  const header = page.getByTestId('search').locator('header.search-bar');
  const jukebox = (await header.boundingBox())!;
  expect(jukebox.height).toBeLessThanOrEqual(96);
  expect(await page.locator('.search-field').evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');

  await page.getByTestId('search-input').fill('lumen');
  await page.getByTestId('mode-global').click();
  await expect(page.getByTestId('search-input')).toHaveValue('lumen');
  await expect(page.getByTestId('search-input')).toBeFocused();
  await expect(page.getByTestId('filter-songs')).toBeVisible();
  const global = (await header.boundingBox())!;
  expect(global.height).toBe(jukebox.height);

  const on = page.getByTestId('mode-global');
  const under = await on.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const a = getComputedStyle(el, '::after');
    return { bottom: r.bottom - parseFloat(a.bottom), h: parseFloat(a.height), bg: a.backgroundColor };
  });
  expect(Math.abs(under.bottom - (global.y + global.height))).toBeLessThanOrEqual(1);
  expect(under.h).toBe(2);
  expect(under.bg).not.toBe('rgba(0, 0, 0, 0)');
  for (const id of ['mode-jukebox', 'mode-global', 'filter-songs', 'filter-albums']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.width, id).toBeGreaterThanOrEqual(44);
    expect(b.height, id).toBeGreaterThanOrEqual(44);
  }
  await on.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('mode-jukebox')).toBeFocused();
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('mode-global')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('mode-global')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveValue('lumen');
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/youtube/i);
});

test('Search opens on Jukebox; Global shows every filter; the bridge appears for few results', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('search-input').fill('the');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect(page.getByTestId('search-bridge')).toHaveCount(0);
  await page.getByTestId('search-input').fill('qzxv nebulon');
  await expect(page.getByTestId('search-empty')).toBeVisible();
  const bridge = page.getByTestId('search-bridge');
  await expect(bridge).toHaveText('Search globally for “qzxv nebulon” →');
  await bridge.click();
  await expect(page.getByTestId('mode-global')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('filter-songs')).toHaveAttribute('aria-checked', 'true');
  const results = page.getByTestId('global-results');
  await expect(results).toHaveAttribute('data-filter', 'songs');
  await expect(results.getByTestId('track-row')).toHaveCount(10);
  await results.getByTestId('load-more').click();
  await expect(results.getByTestId('track-row')).toHaveCount(20);
  for (const f of ['albums', 'artists', 'playlists'] as const) {
    await page.getByTestId(`filter-${f}`).click();
    await expect(page.getByTestId('global-results')).toHaveAttribute('data-filter', f);
    await expect(page.getByTestId('music-row').first()).toBeVisible();
    const kinds = await page.getByTestId('music-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    expect(new Set(kinds)).toEqual(new Set([f === 'albums' ? 'album' : f === 'artists' ? 'artist' : 'playlist']));
  }
  await page.getByTestId('music-open').first().click();
  await expect(page.getByTestId('screen-album').getByTestId('track-row').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-album')).toHaveCount(0);
  await expect(page.getByTestId('search')).toBeVisible();
  await page.getByTestId('filter-artists').click();
  await page.getByTestId('music-open').first().click();
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  await expect(page.locator('.topbar-title')).toHaveText('qzxv nebulon');
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'Search in qzxv nebulon');
  await page.getByTestId('search-close').click();
  await page.getByTestId('tab-home').click();
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveCount(0);
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-empty')).toBeVisible();
});

test('Global search runs from the first letter, debounced; no "at least 2 letters" text', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  await page.getByTestId('mode-global').click();
  await expect(page.getByTestId('global-idle')).toBeVisible();
  await expect(page.getByTestId('search')).not.toContainText(/at least/i);
  await page.getByTestId('search-input').fill('q');
  await expect(page.getByTestId('global-results')).toBeVisible();
  expect(await musicCalls(page)).toContainEqual(['search', 'q', 'songs']);
  const n = (await musicCalls(page)).length;
  await page.getByTestId('search-input').pressSequentially('rst', { delay: 30 });
  // The stub credits songs to the query: results for "qrst" mean the last query landed.
  await expect(page.getByTestId('global-results').locator('.row-artist').first()).toContainText('qrst');
  const after = (await musicCalls(page)).slice(n).filter((c) => c[0] === 'search');
  expect(after).toEqual([['search', 'qrst', 'songs']]);
});

test('a Global track shows "From Global search", and no visible text names YouTube', async ({ page }) => {
  const seen: string[] = [];
  const grab = async () => seen.push(await page.evaluate(() => document.body.innerText));
  await start(page);
  await grab();
  await openSearch(page);
  await grab();
  await page.getByTestId('mode-global').click();
  await grab();
  await page.getByTestId('search-input').fill('Night Owls');
  const results = page.getByTestId('global-results');
  await expect(results.getByTestId('track-row').first()).toBeVisible();
  await grab();
  await results.getByTestId('track-play').nth(2).click();
  await page.getByTestId('search-close').click();
  await page.getByTestId('mini-open').click();
  await expect(page.getByTestId('np-global')).toHaveText('From Global search');
  await expect(page.getByTestId('np-post')).toHaveCount(0);
  await expect(page.getByTestId('np-genre')).toHaveCount(0);
  await expect(page.getByTestId('np-artist')).toBeVisible();
  await grab();
  await page.getByTestId('np-more').click();
  await expect(page.getByTestId('menu-open-post')).toHaveCount(0);
  await expect(page.getByTestId('menu-open-youtube')).toHaveCount(0); // only while blocked
  await expect(page.getByTestId('menu-more-by').first()).toBeVisible();
  await page.getByTestId('menu-like').click();
  await page.getByTestId('np-close').click();
  for (const t of ['genres', 'artists', 'library', 'settings'] as const) {
    await page.getByTestId(`tab-${t}`).click();
    await expect(page.getByTestId(`screen-${t}`)).toBeVisible();
    await grab();
  }
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-row')).toHaveCount(1);
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('recent-list').getByTestId('track-row').first()).toBeVisible();
  await page.getByTestId('tab-settings').click();
  await page.locator('details').evaluateAll((els) => els.forEach((d) => ((d as HTMLDetailsElement).open = true)));
  await grab();
  for (const text of seen) expect(text).not.toMatch(/youtube/i);
});

test.describe('Global behind a bot check', () => {
  test.use({ musicOptions: { botCheck: true } });
  test('shows the empty state, then the bot-check message', async ({ page }) => {
    await page.goto('/');
    await openSearch(page);
    await page.getByTestId('mode-global').click();
    await expect(page.getByTestId('global-idle')).toBeVisible();
    expect(await musicCalls(page)).toHaveLength(0);
    await page.getByTestId('search-input').fill('ab');
    await expect(page.getByTestId('global-error')).toContainText(BOT_TEXT);
  });
});

test('Here: search from a genre page is scoped to it; Home and the grids have no Here', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveCount(0);
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'Search the Jukebox');
  await expect(page.getByTestId('search-latest')).toBeVisible();
  await page.getByTestId('search-close').click();
  await page.getByTestId('tab-genres').click();
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveCount(0);
  await page.getByTestId('search-close').click();

  const tile = page.getByTestId('genre-grid').locator('[data-testid="genre-tile"][data-genre="pop"]');
  await tile.click();
  await expect(page.getByTestId('screen-genre').getByTestId('track-row').first()).toBeVisible();
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'Search in pop');
  const list = page.getByTestId('here-list');
  await expect(list.getByTestId('track-row').first()).toBeVisible();
  const tags = await list.locator('.tag').allTextContents();
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t.trim()).toBe('pop');
  const firstTitle = (await list.getByTestId('track-title').first().textContent())!.trim();
  await page.getByTestId('search-input').fill(firstTitle);
  const results = page.getByTestId('here-results');
  await expect(results.getByTestId('track-title').first()).toBeVisible();
  for (const t of await results.locator('.tag').allTextContents()) expect(t.trim()).toBe('pop');
  await page.getByTestId('mode-jukebox').click();
  await expect(page.getByTestId('search-input')).toHaveValue(firstTitle);
  await expect(page.getByTestId('search-results')).toBeVisible();
  await page.getByTestId('mode-global').click();
  await expect(page.getByTestId('global-results')).toBeVisible();
  await page.getByTestId('mode-here').click();
  await expect(page.getByTestId('here-results')).toBeVisible();
});

test('Here: search from an album page searches the album, above it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  await page.getByTestId('artist-albums').getByTestId('release-card').first().click();
  const album = page.getByTestId('screen-album');
  await expect(album.getByTestId('track-row').first()).toBeVisible();
  const title = (await page.getByTestId('album-title').textContent())!.trim();
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', `Search in ${title}`);
  await expect(page.getByTestId('here-list').getByTestId('track-row')).toHaveCount(8);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search')).toHaveCount(0);
  await expect(album).toBeVisible();
});

test('the members-only and banned posts never show signed out', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  for (const q of ['Velvet Underground Hours', 'Banned Broadcast']) {
    await page.getByTestId('search-input').fill(q);
    await expect(page.getByTestId('search-results').or(page.getByTestId('search-empty'))).toBeVisible();
    await expect(page.getByTestId('search').getByTestId('track-title').getByText(q, { exact: true })).toHaveCount(0);
  }
  await page.getByTestId('search-close').click();
  await waitForTracks(page);
});
