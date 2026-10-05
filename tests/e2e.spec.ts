import { expect, test, type Page } from '@playwright/test';

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
  await expect(page.getByTestId('home-section-title')).toHaveText(/latest/i);
});

test('a genre chip filters the list', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  const chip = page.getByTestId('genre-chip').first();
  const genre = (await chip.getAttribute('data-genre'))!;
  expect(genre).toBeTruthy();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('home-section-title')).toHaveText(genre);
  await waitForTracks(page);
  const tags = await page.getByTestId('track-list').locator('.tag').allInnerTexts();
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t.trim()).toBe(genre);
  // Back to all
  await page.getByTestId('chip-all').click();
  await expect(page.getByTestId('home-section-title')).toHaveText(/latest/i);
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

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'c64');
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
