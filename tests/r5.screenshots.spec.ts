import { expect, test, type Page } from '@playwright/test';
import { stubAuth, stubMusic, stubYouTube } from './stubs';

/**
 * Round 5 screenshots: Here search on an artist page (releases row and tracks, and
 * "Searching all songs…" while the full song list loads), and the top of Settings
 * with Account first. Dark at 412px. Saved to media/web-screenshots/r5-*.png.
 * Run with: npm run screenshots
 */

const OUT = 'media/web-screenshots';

async function open(page: Page) {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.settings', JSON.stringify({ theme: 'dark', showNsfw: false, quality: 'high' }));
  });
  await stubYouTube(page);
  await stubMusic(page, { topSongPages: 3, songPageDelay: 1500 });
  await stubAuth(page);
  await page.goto('/');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
}

async function settle(page: Page) {
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

test('artist page Here search', async ({ page }) => {
  await open(page);
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  await expect(page.getByTestId('artist-top').getByTestId('track-row').first()).toBeVisible();
  await page.getByTestId('search-fab').click();
  await page.getByTestId('search-input').fill('rarity');
  await expect(page.getByTestId('here-loading')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/r5-artist-here-loading.png` });
  await expect(page.getByTestId('here-loading')).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId('search-input').fill('neon');
  await expect(page.getByTestId('here-releases')).toBeVisible();
  await settle(page);
  await page.getByTestId('search-input').blur();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/r5-artist-here-results.png` });
});

test('Settings top: Account first', async ({ page }) => {
  await open(page);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('account')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: `${OUT}/r5-settings-top.png` });
});
