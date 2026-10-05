import { expect, test, type Page } from '@playwright/test';
import { stubYouTube } from './stubs';

/**
 * Phone-size screenshots of every screen, saved to media/web-screenshots/.
 * Run with: npm run screenshots
 * Data is live Firestore; YouTube thumbnails/player are synthetic stand-ins
 * (see stubs.ts) because sandboxes can't reach YouTube.
 */

const OUT = 'media/web-screenshots';

async function settle(page: Page) {
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function openHome(page: Page, theme?: string) {
  if (theme) {
    await page.addInitScript((t) => {
      localStorage.setItem('CapacitorStorage.settings', JSON.stringify({ theme: t, showNsfw: false, quality: 'high' }));
    }, theme);
  }
  await stubYouTube(page);
  await page.goto('/');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await settle(page);
}

test('screens (dark)', async ({ page }) => {
  await openHome(page);
  await shot(page, '01-home');

  // Play the 2nd track, like it and the 4th one so Library has content.
  await page.getByTestId('track-play').nth(1).click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  for (const i of [1, 3, 5]) {
    await page.getByTestId('track-more').nth(i).click();
    await page.getByTestId('menu-like').click();
  }
  await page.waitForTimeout(3500); // let toasts clear
  await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await shot(page, '02-home-playing');

  await page.getByTestId('track-more').nth(2).click();
  await page.waitForTimeout(400);
  await shot(page, '03-track-menu');
  await page.getByTestId('menu-add-queue').click();
  await page.waitForTimeout(3500);

  await page.getByTestId('mini-open').click();
  await page.waitForTimeout(1200);
  await shot(page, '04-now-playing');
  await page.getByTestId('now-playing').locator('.np-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(300);
  await shot(page, '05-now-playing-up-next');
  await page.getByTestId('np-close').click();

  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('genre-tile').first()).toBeVisible();
  await settle(page);
  await shot(page, '06-genres');

  await page.getByTestId('genre-tile').first().click();
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await settle(page);
  await shot(page, '07-genre-list');

  await page.getByTestId('tab-library').click();
  await settle(page);
  await shot(page, '08-library');

  await page.getByTestId('tab-settings').click();
  await settle(page);
  await shot(page, '09-settings');
  await page.getByTestId('about').scrollIntoViewIfNeeded();
  await shot(page, '10-settings-about');
});

for (const theme of ['light', 'c64', 'vt320', 'matrix', 'bubblegum']) {
  test(`home (${theme})`, async ({ page }) => {
    await openHome(page, theme);
    await page.getByTestId('track-play').nth(0).click();
    await page.waitForTimeout(800);
    await shot(page, `home-${theme}`);
  });
}

test('now playing (grid)', async ({ page }) => {
  await openHome(page, 'grid');
  await page.getByTestId('track-play').nth(2).click();
  await page.getByTestId('mini-open').click();
  await page.waitForTimeout(1500);
  await shot(page, 'now-playing-grid');
});
