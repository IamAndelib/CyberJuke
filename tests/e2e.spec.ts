import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubYouTube } from './stubs';

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
  await expect(page.getByTestId('search-hint')).toContainText(/Search all \d{3,} tracks/);
  await page.getByTestId('search-input').fill(artist);
  const results = page.getByTestId('search-results');
  await expect(results).toBeVisible();
  const hit = results.getByTestId('track-row').filter({ hasText: title }).first();
  await expect(hit).toBeVisible();
  await hit.getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);

  // Clear, then Escape closes search.
  await page.getByTestId('search-clear').click();
  await expect(page.getByTestId('search-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search')).toHaveCount(0);
  await expect(page.getByTestId('screen-home')).toBeVisible();
});

test('search tolerates a typo and offers genre chips', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  await expect(page.getByTestId('search-hint')).toBeVisible();
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
