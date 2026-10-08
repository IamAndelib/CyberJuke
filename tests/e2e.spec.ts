import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubMusic, stubYouTube } from './stubs';

/**
 * Runs against live Firestore (read-only). Audio is never asserted: YouTube may be
 * unreachable from CI/sandboxes, and the UI must cope with that.
 */

async function waitForTracks(page: Page) {
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
}

const cssVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('live tracks load on Home', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  const rows = page.getByTestId('track-row');
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  const titles = await page.getByTestId('track-title').allInnerTexts();
  expect(titles.every((t) => t.trim().length > 0)).toBe(true);
  await expect(rows.first()).toContainText('by @');
  await expect(page.getByTestId('sort-latest')).toHaveAttribute('aria-selected', 'true');
  // Home has no Play all (genre pages and Library keep theirs).
  await expect(page.getByTestId('home-play-all')).toHaveCount(0);
});

test('a genre chip filters the list', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  const chip = page.getByTestId('genre-chip').first();
  const genre = (await chip.getAttribute('data-genre'))!;
  expect(genre).toBeTruthy();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('chip-all')).toHaveAttribute('aria-selected', 'false');
  await waitForTracks(page);
  const tags = await page.getByTestId('track-list').locator('.tag').allInnerTexts();
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t.trim()).toBe(genre);
  // Back to all
  await page.getByTestId('chip-all').click();
  await expect(page.getByTestId('chip-all')).toHaveAttribute('aria-selected', 'true');
});

test('tapping a track shows the mini player, which opens Now Playing', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  const title = (await page.getByTestId('track-title').nth(1).innerText()).trim();
  await page.getByTestId('track-play').nth(1).click();

  const mini = page.getByTestId('mini-player');
  await expect(mini).toBeVisible();
  await expect(page.getByTestId('mini-title')).toHaveText(title);
  await expect(page.getByTestId('track-row').nth(1)).toHaveClass(/is-current/);

  await page.getByTestId('mini-open').click();
  const np = page.getByTestId('now-playing');
  await expect(np).toHaveClass(/open/);
  await expect(page.getByTestId('np-title')).toHaveText(title);
  await expect(page.getByTestId('np-post')).toContainText('Posted by @');
  // Up Next holds the rest of the list after the tapped track.
  await expect(page.getByTestId('upnext-row').first()).toBeVisible();

  // Remove one from Up Next.
  const before = await page.getByTestId('upnext-row').count();
  await page.getByTestId('upnext-remove').first().click();
  await expect(page.getByTestId('upnext-row')).toHaveCount(before - 1);

  // Toggles reflect state.
  await page.getByTestId('np-repeat').click();
  await expect(page.getByTestId('np-repeat')).toHaveAttribute('data-mode', 'all');
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('np-close').click();
  await expect(np).not.toHaveClass(/open/);
});

test('like from the track menu adds it to Library', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  const title = (await page.getByTestId('track-title').first().innerText()).trim();
  await page.getByTestId('track-more').first().click();
  await expect(page.getByTestId('track-menu')).toBeVisible();
  await page.getByTestId('menu-like').click();
  await expect(page.getByTestId('toast').last()).toContainText('Added to Liked');

  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-liked').click();
  const liked = page.getByTestId('liked-list');
  await expect(liked.getByTestId('track-title')).toHaveText([title]);

  // Persists across reloads (Preferences -> localStorage on the web).
  await page.reload();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-title')).toHaveText([title]);
});

test('switching theme changes the CSS variables', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await cssVar(page, '--color-bg')).toBe('#000');
  expect(await cssVar(page, '--color-fg')).toBe('#efe5c0');

  await page.getByTestId('tab-settings').click();
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await cssVar(page, '--color-bg')).toBe('#efe5c0');
  expect(await cssVar(page, '--color-fg')).toBe('#000');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(239, 229, 192)');

  await page.getByTestId('theme-c64').click();
  expect(await cssVar(page, '--color-bg')).toBe('#2a2ab8');

  await page.getByTestId('theme-brutalist').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'brutalist');
  expect(await cssVar(page, '--color-bg')).toBe('#080810');
  expect(await cssVar(page, '--color-fg')).toBe('#c0d0e8');
  await expect(page.getByTestId('theme-grid')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'brutalist');
});

test('a saved GRiD theme migrates to Brutalist', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('CapacitorStorage.settings', JSON.stringify({ theme: 'grid', showNsfw: false, quality: 'high' }));
    }
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'brutalist');
  expect(await cssVar(page, '--color-bg')).toBe('#080810');
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('theme-brutalist')).toHaveAttribute('aria-pressed', 'true');
});

test('genres tab lists genres and opens a genre list', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const tile = page.getByTestId('genre-tile').first();
  await expect(tile).toBeVisible();
  const genre = (await tile.getAttribute('data-genre'))!;
  await tile.click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await waitForTracks(page);
  await expect(page.getByTestId('genre-play-all')).toBeEnabled();
  await expect(page.locator('.topbar-title')).toHaveText(new RegExp(genre, 'i'));
  await page.getByTestId('genre-back').click();
  await expect(page.getByTestId('genre-grid')).toBeVisible();
});

test('?autoplay=latest starts the newest track (CI hook)', async ({ page }) => {
  await page.goto('/?autoplay=latest');
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await waitForTracks(page);
  const first = (await page.getByTestId('track-title').first().innerText()).trim();
  await expect(page.getByTestId('mini-title')).toHaveText(first);
});

test('NSFW is hidden by default and the toggle persists', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const toggle = page.getByTestId('nsfw-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('nsfw-toggle')).toHaveAttribute('aria-checked', 'true');
});

async function openSearch(page: Page) {
  await page.getByTestId('search-fab').click();
  await expect(page.getByTestId('search')).toBeVisible();
  await expect(page.getByTestId('search-input')).toBeFocused();
}

test('search finds a live artist from the first page and plays it', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  // Pick a row with a real artist name.
  const rows = page.getByTestId('track-row');
  let artist = '';
  let title = '';
  for (let i = 0; i < (await rows.count()); i++) {
    const a = (await rows.nth(i).locator('.row-artist').innerText()).trim();
    if (a && a !== 'Unknown artist' && /[a-z]{3}/i.test(a)) {
      artist = a;
      title = (await rows.nth(i).getByTestId('track-title').innerText()).trim();
      break;
    }
  }
  expect(artist).toBeTruthy();

  await openSearch(page);
  await expect(page.getByTestId('search-latest')).toBeVisible();
  await page.getByTestId('search-input').fill(artist);
  const results = page.getByTestId('search-results');
  await expect(results).toBeVisible();
  const hit = results.getByTestId('track-row').filter({ hasText: title }).first();
  await expect(hit).toBeVisible();
  await hit.getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);

  // Clear, then Escape closes search.
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

test('the search button sits above the tab bar, then above the mini player', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  const fab = page.getByTestId('search-fab');
  const box = async (l: Locator) => (await l.boundingBox())!;
  expect((await box(fab)).y + (await box(fab)).height).toBeLessThanOrEqual((await box(page.locator('.tabbar'))).y);
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  const f = await box(fab);
  expect(f.y + f.height).toBeLessThanOrEqual((await box(page.getByTestId('mini-player'))).y);
  expect(f.width).toBeGreaterThanOrEqual(44);

  // The last row's ⋯ can scroll clear of the button (Most saved is a finite list).
  await page.getByTestId('sort-saved').click();
  await page.getByTestId('range-all').click();
  await expect(page.getByTestId('saved-list')).toBeVisible();
  const screen = page.getByTestId('screen-home');
  await screen.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(300);
  const m = await box(page.getByTestId('track-more').last());
  expect(m.y + m.height).toBeLessThanOrEqual((await box(fab)).y);

  // Hidden in Settings.
  await page.getByTestId('tab-settings').click();
  await expect(fab).toHaveCount(0);
});

test('Most saved, all time, lists tracks by descending saves', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  await page.getByTestId('sort-saved').click();
  await expect(page.getByTestId('sort-saved')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('range-month')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('range-all').click();
  const saves = page.getByTestId('saved-list').getByTestId('track-saves');
  await expect(saves.first()).toBeVisible();
  const counts = (await saves.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-saves')))));
  expect(counts.length).toBeGreaterThanOrEqual(10);
  expect(counts[0]).toBeGreaterThan(1);
  for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
  expect(counts.every((c) => c >= 1)).toBe(true);
  await expect(saves.first()).toHaveText(String(counts[0]));

  // The sort survives a tab switch.
  await page.getByTestId('tab-library').click();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('sort-saved')).toHaveAttribute('aria-selected', 'true');
});

test('hearting a genre adds Favorite genres, which survive a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const grid = page.getByTestId('genre-grid');
  await expect(grid).toBeVisible();
  await expect(page.getByTestId('fav-genres')).toHaveCount(0);
  await expect(page.locator('.genre-count')).toHaveCount(0);
  await expect(page.locator('.fineprint')).not.toContainText('grows as you browse');
  // Wait for the full catalog list.
  await expect(page.locator('.topbar-sub')).toContainText(/\d+ genres/);
  expect(await grid.getByTestId('genre-tile').count()).toBeGreaterThan(100);

  const second = grid.getByTestId('genre-cell').nth(1);
  const genre = (await second.getAttribute('data-genre'))!;
  const heart = second.getByTestId('genre-fav');
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  const favs = page.getByTestId('fav-genres');
  await expect(favs.getByTestId('genre-tile')).toHaveText([genre]);

  await page.reload();
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('fav-genres').getByTestId('genre-tile')).toHaveText([genre]);
  // Favorites lead Home's chips.
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('genre-chip').first()).toHaveAttribute('data-genre', genre);

  // Un-hearting removes the section.
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('fav-genres').getByTestId('genre-fav').click();
  await expect(page.getByTestId('fav-genres')).toHaveCount(0);
});

test('the play icon is optically centred in its round button', async ({ page }) => {
  await stubYouTube(page);
  await page.goto('/');
  await waitForTracks(page);
  await page.getByTestId('track-play').first().click();
  await page.getByTestId('mini-open').click();
  const btn = page.getByTestId('np-toggle');
  await expect(btn).toHaveAttribute('aria-label', 'Pause');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-label', 'Play');

  for (const b of [btn, page.getByTestId('mini-toggle')]) {
    if (b !== btn) await page.getByTestId('np-close').click();
    const icon = b.locator('svg[data-icon="play"]');
    await expect(icon).toHaveAttribute('shape-rendering', 'geometricPrecision');
    const m = await b.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const p = el.querySelector('svg path')!.getBoundingClientRect();
      return { bx: r.left + r.width / 2, by: r.top + r.height / 2, left: p.left, top: p.top, w: p.width, h: p.height };
    });
    // Right-pointing triangle: centroid is a third of the way in from the flat side.
    const centroidX = m.left + m.w / 3;
    expect(Math.abs(centroidX - m.bx)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(m.top + m.h / 2 - m.by)).toBeLessThanOrEqual(1);
    // Its box leans right of centre by less than a sixth of its width.
    const lean = m.left + m.w / 2 - m.bx;
    expect(lean).toBeGreaterThan(0);
    expect(lean).toBeLessThan(m.w / 6 + 1);
  }
});

// ---- Round 2: search list, scroll memory, back-to-top, Artists, Global ---------------

const scrollTopOf = (page: Page, testid: string) => page.getByTestId(testid).evaluate((el) => el.scrollTop);
async function scrollTo(page: Page, testid: string, y: number) {
  await page.getByTestId(testid).evaluate((el, v) => el.scrollTo(0, v), y);
  await page.waitForTimeout(250);
}
const BOT_TEXT = "Global search isn't available on this network right now, try again later";

test('search opens straight to the latest tracks, with no hint text', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  const newest = (await page.getByTestId('track-title').first().innerText()).trim();
  await openSearch(page);
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
  const latest = page.getByTestId('search-latest');
  await expect(latest).toBeVisible();
  await expect(page.getByTestId('search-hint')).toHaveCount(0);
  await expect(page.getByTestId('search')).not.toContainText('Search all');
  await expect(latest.getByTestId('track-title').first()).toHaveText(newest);
  // Rendered in chunks of 60, more added near the bottom.
  const rows = latest.getByTestId('track-row');
  expect(await rows.count()).toBe(60);
  await scrollTo(page, 'search', 1e6);
  await expect.poll(() => rows.count()).toBeGreaterThan(60);
  // Tapping a row plays the list from there.
  const title = (await rows.nth(3).getByTestId('track-title').innerText()).trim();
  await rows.nth(3).getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);
});

test('Genres remembers the grid position across a genre page, and each genre list too', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  await expect(page.locator('.topbar-sub')).toContainText(/\d+ genres/);
  await scrollTo(page, 'screen-genres', 1500);
  const y = await scrollTopOf(page, 'screen-genres');
  expect(y).toBeGreaterThan(1400);
  const genre = await page.evaluate(() => {
    const el = document.elementFromPoint(innerWidth / 4, innerHeight / 2)?.closest('[data-testid="genre-tile"]');
    return el?.getAttribute('data-genre') ?? '';
  });
  expect(genre).toBeTruthy();
  const tile = (g: string) => page.locator(`[data-testid="genre-grid"] [data-testid="genre-tile"][data-genre="${g}"]`);
  await tile(genre).click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await waitForTracks(page);
  await page.getByTestId('genre-back').click();
  await expect(page.getByTestId('genre-grid')).toBeVisible();
  expect(Math.abs((await scrollTopOf(page, 'screen-genres')) - y)).toBeLessThanOrEqual(10);
  // Escape goes back too, and keeps the position.
  await tile(genre).click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('genre-grid')).toBeVisible();
  expect(Math.abs((await scrollTopOf(page, 'screen-genres')) - y)).toBeLessThanOrEqual(10);

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

test('Home keeps its loaded pages and scroll position across tab switches', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  const rows = page.getByTestId('track-row');
  // Scroll past two pages (24 each).
  for (let i = 0; i < 12 && (await rows.count()) <= 48; i++) {
    await scrollTo(page, 'screen-home', 1e6);
    await page.waitForTimeout(600);
  }
  expect(await rows.count()).toBeGreaterThan(48);
  const target = await page.getByTestId('screen-home').evaluate((el) => {
    const row = el.querySelectorAll('[data-testid="track-row"]')[40] as HTMLElement;
    el.scrollTo(0, row.offsetTop - 120);
    return el.scrollTop;
  });
  await page.waitForTimeout(250);
  const count = await rows.count();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('screen-library')).toBeVisible();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('screen-home')).toBeVisible();
  expect(await rows.count()).toBe(count); // no refetch, nothing lost
  expect(Math.abs((await scrollTopOf(page, 'screen-home')) - target)).toBeLessThanOrEqual(10);
});

test('back-to-top shows after scrolling, scrolls to the top, and stays clear of the other buttons', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  const btn = page.getByTestId('screen-home').getByTestId('back-to-top');
  await expect(btn).toBeHidden();
  await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, el.clientHeight * 0.8));
  await page.waitForTimeout(250);
  await expect(btn).toBeHidden();
  await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-label', 'Back to top');

  const b = (await btn.boundingBox())!;
  const f = (await page.getByTestId('search-fab').boundingBox())!;
  const m = (await page.getByTestId('mini-player').boundingBox())!;
  expect(b.width).toBeGreaterThanOrEqual(44);
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.x + b.width + 8).toBeLessThanOrEqual(f.x); // no overlap with the search button (shadow included)
  expect(b.y + b.height + 4).toBeLessThanOrEqual(m.y); // above the mini player
  const vw = page.viewportSize()!.width;
  expect(Math.abs(b.x + b.width / 2 + 2 - vw / 2)).toBeLessThanOrEqual(4); // bottom-centre

  await btn.click();
  await expect.poll(() => scrollTopOf(page, 'screen-home')).toBe(0);
  await expect(btn).toBeHidden();
});

test('the last row stays clear of back-to-top and search buttons at the end of a list', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  await page.getByTestId('sort-saved').click();
  await page.getByTestId('range-all').click();
  await expect(page.getByTestId('saved-list')).toBeVisible();
  await scrollTo(page, 'screen-home', 1e6);
  const btn = page.getByTestId('screen-home').getByTestId('back-to-top');
  await expect(btn).toBeVisible();
  const more = (await page.getByTestId('track-more').last().boundingBox())!;
  const b = (await btn.boundingBox())!;
  const f = (await page.getByTestId('search-fab').boundingBox())!;
  expect(more.y + more.height).toBeLessThanOrEqual(Math.min(b.y, f.y));
});

test('Artists tab lists artists; a heart adds Favorite artists, which survive a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  await expect(page.getByTestId('screen-artists')).toBeVisible();
  await expect(page.locator('.topbar-sub')).toContainText(/\d{3} artists on the Jukebox/);
  const grid = page.getByTestId('artist-grid');
  expect(await grid.getByTestId('artist-tile').count()).toBeGreaterThan(300);
  await expect(page.getByTestId('fav-artists')).toHaveCount(0);
  // "and" / "&" never split a name.
  const names = await grid.getByTestId('artist-tile').evaluateAll((els) => els.map((e) => e.getAttribute('data-artist')!));
  expect(names.some((n) => / & /.test(n))).toBe(true);
  expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);

  const second = grid.getByTestId('artist-cell').nth(1);
  const artist = (await second.getAttribute('data-artist'))!;
  await second.getByTestId('artist-fav').click();
  await expect(second.getByTestId('artist-fav')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('fav-artists').getByTestId('artist-tile')).toHaveText([artist]);

  await page.reload();
  await page.getByTestId('tab-artists').click();
  await expect(page.getByTestId('fav-artists').getByTestId('artist-tile')).toHaveText([artist]);
  await page.getByTestId('fav-artists').getByTestId('artist-fav').click();
  await expect(page.getByTestId('fav-artists')).toHaveCount(0);
});

test('an artist page puts the Jukebox first, then More by and Albums; an album opens and plays', async ({ page }) => {
  await stubYouTube(page);
  await stubMusic(page);
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  const tile = page.getByTestId('artist-grid').getByTestId('artist-tile').first();
  const artist = (await tile.getAttribute('data-artist'))!;
  await tile.click();
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  await expect(page.locator('.topbar-title')).toHaveText(artist);

  const jukebox = page.getByTestId('artist-jukebox');
  const more = page.getByTestId('artist-more');
  const albums = page.getByTestId('artist-albums');
  await expect(jukebox).toContainText('Shared on the Jukebox');
  await expect(jukebox.getByTestId('track-row').first()).toBeVisible();
  await expect(jukebox.getByTestId('track-row').first()).toContainText('by @');
  await expect(more).toContainText(`More by ${artist}`);
  await expect(more.getByTestId('track-row').first()).toBeVisible();
  await expect(albums.getByTestId('album-card').first()).toBeVisible();
  const y = async (l: Locator) => (await l.boundingBox())!.y;
  expect(await y(jukebox)).toBeLessThan(await y(more));
  expect(await y(more)).toBeLessThan(await y(albums));
  // "More by" lists songs crediting the artist and no "by @poster".
  await expect(more.locator('.by')).toHaveCount(0);
  for (const a of await more.locator('.row-artist').allInnerTexts()) expect(a.toLowerCase()).toContain(artist.toLowerCase());
  // Load more appends a page.
  const before = await more.getByTestId('track-row').count();
  await more.getByTestId('load-more').click();
  await expect.poll(() => more.getByTestId('track-row').count()).toBeGreaterThan(before);

  // Play from More by.
  const firstMore = (await more.getByTestId('track-title').first().innerText()).trim();
  await page.getByTestId('artist-more-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(firstMore);

  // Album page.
  const albumTitle = (await albums.locator('.shelf-title').first().innerText()).trim();
  await albums.getByTestId('album-card').first().click();
  const album = page.getByTestId('screen-album');
  await expect(album).toBeVisible();
  await expect(album.getByTestId('album-title')).toBeVisible();
  await expect(album.getByTestId('album-artist')).toHaveText(artist); // empty subtitle falls back to the artist
  await expect(album.getByTestId('track-row')).toHaveCount(8);
  expect(albumTitle.length).toBeGreaterThan(0);
  const first = (await album.getByTestId('track-title').first().innerText()).trim();
  await page.getByTestId('album-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(first);
  await page.getByTestId('album-back').click();
  await expect(album).toHaveCount(0);
  await expect(page.getByTestId('screen-artist')).toBeVisible();

  // Artist page scroll memory.
  await scrollTo(page, 'screen-artist', 500);
  const ay = await scrollTopOf(page, 'screen-artist');
  await page.getByTestId('artist-back').click();
  await expect(page.getByTestId('artist-grid')).toBeVisible();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  await expect.poll(() => scrollTopOf(page, 'screen-artist')).toBeGreaterThan(ay - 10);
  expect(Math.abs((await scrollTopOf(page, 'screen-artist')) - ay)).toBeLessThanOrEqual(10);
});

test('a failed Global request only affects its own sections', async ({ page }) => {
  await stubMusic(page, { botCheck: true });
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  await expect(page.getByTestId('artist-jukebox').getByTestId('track-row').first()).toBeVisible();
  await expect(page.getByTestId('artist-more').getByTestId('global-error')).toContainText(BOT_TEXT);
  await expect(page.getByTestId('albums-error')).toBeVisible();
});

test('in Now Playing, the genre opens its genre page and the artist opens the artist page', async ({ page }) => {
  await stubMusic(page);
  await page.goto('/');
  await waitForTracks(page);
  const rows = page.getByTestId('track-row');
  let i = 0;
  for (; i < (await rows.count()); i++) {
    const r = rows.nth(i);
    if ((await r.locator('.tag').count()) && (await r.locator('.row-artist').innerText()).trim() !== 'Unknown artist') break;
  }
  const genre = (await rows.nth(i).locator('.tag').innerText()).trim();
  await rows.nth(i).getByTestId('track-play').click();
  await page.getByTestId('mini-open').click();
  await expect(page.getByTestId('now-playing')).toHaveClass(/open/);
  await page.getByTestId('np-genre').click();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await expect(page.locator('.topbar-title')).toHaveText(genre);
  await expect(page.getByTestId('tab-genres')).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('mini-open').click();
  await page.getByTestId('np-artist').click();
  if (await page.getByTestId('artist-chooser').isVisible()) await page.getByTestId('chooser-artist').first().click();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  await expect(page.getByTestId('tab-artists')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('artist-jukebox').getByTestId('track-row').first()).toBeVisible();

  // The ⋯ menu offers "More by <artist>".
  await page.getByTestId('artist-jukebox').getByTestId('track-more').first().click();
  await expect(page.getByTestId('menu-more-by').first()).toContainText('More by ');
});

test('several credited artists open a chooser from Now Playing', async ({ page }) => {
  await stubMusic(page);
  await page.goto('/');
  await openSearch(page);
  await page.getByTestId('mode-global').click();
  await page.getByTestId('search-input').fill('Lumen');
  const results = page.getByTestId('global-results');
  // The stub credits its second song to "Lumen, Tycho".
  const row = results.getByTestId('track-row').filter({ hasText: 'Lumen, Tycho' }).first();
  await expect(row).toBeVisible();
  await row.getByTestId('track-play').click();
  await page.getByTestId('search-close').click();
  await page.getByTestId('mini-open').click();
  await page.getByTestId('np-artist').click();
  const chooser = page.getByTestId('artist-chooser');
  await expect(chooser).toBeVisible();
  await expect(chooser.getByTestId('chooser-artist')).toHaveText(['Lumen', 'Tycho']);
  await chooser.getByTestId('chooser-artist').nth(1).click();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  await expect(page.locator('.topbar-title')).toHaveText('Tycho');
  await expect(chooser).toBeHidden();
});

test('Search always opens on Jukebox; Global shows every filter; the bridge appears for few results', async ({ page }) => {
  await stubYouTube(page);
  await stubMusic(page);
  await page.goto('/');
  await openSearch(page);
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
  // Plenty of results: no bridge.
  await page.getByTestId('search-input').fill('the');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect(page.getByTestId('search-bridge')).toHaveCount(0);
  // No results: the bridge.
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
  // A playlist opens the album page over search; back returns to search.
  await page.getByTestId('music-open').first().click();
  await expect(page.getByTestId('screen-album')).toBeVisible();
  await expect(page.getByTestId('screen-album').getByTestId('track-row').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-album')).toHaveCount(0);
  await expect(page.getByTestId('search')).toBeVisible();
  // An artist opens the artist page.
  await page.getByTestId('filter-artists').click();
  await page.getByTestId('music-open').first().click();
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  await expect(page.locator('.topbar-title')).toHaveText('qzxv nebulon');

  // Reopening search starts on Jukebox again.
  await openSearch(page);
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-empty')).toBeVisible();
});

test('Global search: empty state, short queries, and the bot-check message', async ({ page }) => {
  await stubMusic(page, { botCheck: true });
  await page.goto('/');
  await openSearch(page);
  await page.getByTestId('mode-global').click();
  await expect(page.getByTestId('global-idle')).toBeVisible();
  await page.getByTestId('search-input').fill('a');
  await page.waitForTimeout(600);
  await expect(page.getByTestId('global-idle')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __cyberjukeMusicCalls: unknown[] }).__cyberjukeMusicCalls.length)).toBe(0);
  await page.getByTestId('search-input').fill('ab');
  await expect(page.getByTestId('global-error')).toContainText(BOT_TEXT);
});

test('a Global track shows "From Global search", and no visible text names YouTube', async ({ page }) => {
  await stubYouTube(page);
  await stubMusic(page);
  const seen: string[] = [];
  const grab = async () => seen.push(await page.evaluate(() => document.body.innerText));
  await page.goto('/');
  await waitForTracks(page);
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
  await expect(page.getByTestId('menu-more-by').first()).toBeVisible();
  // Liking works and it shows up in Recently played.
  await page.getByTestId('menu-like').click();
  await page.getByTestId('np-close').click();
  for (const t of ['genres', 'artists', 'library', 'settings'] as const) {
    await page.getByTestId(`tab-${t}`).click();
    await page.waitForTimeout(300);
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
