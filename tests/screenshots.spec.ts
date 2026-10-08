import { expect, test, type Page } from '@playwright/test';
import { stubMusic, stubYouTube } from './stubs';

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

async function catalogReady(page: Page) {
  await page.getByTestId('search-fab').click();
  await expect(page.getByTestId('search-latest')).toBeVisible();
  await page.getByTestId('search-close').click();
}

async function openHome(page: Page, theme?: string) {
  if (theme) {
    await page.addInitScript((t) => {
      localStorage.setItem('CapacitorStorage.settings', JSON.stringify({ theme: t, showNsfw: false, quality: 'high' }));
    }, theme);
  }
  await stubYouTube(page);
  // These shots show the search-based artist page (the fallback); see members.screenshots for the artist's own page.
  await stubMusic(page, { noArtistPage: true });
  await page.goto('/');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await settle(page);
}

test('screens (dark)', async ({ page }) => {
  await openHome(page);
  await shot(page, '01-home');

  await catalogReady(page);
  await page.getByTestId('sort-saved').click();
  await page.getByTestId('range-all').click();
  await expect(page.getByTestId('track-saves').first()).toBeVisible();
  await settle(page);
  await shot(page, '01b-home-most-saved');
  await page.getByTestId('sort-latest').click();
  await expect(page.getByTestId('track-row').first()).toBeVisible();

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
  await page.getByTestId('np-toggle').click();
  await expect(page.getByTestId('np-toggle')).toHaveAttribute('aria-label', 'Play');
  await page.waitForTimeout(300);
  await shot(page, '04b-now-playing-paused');
  await page.getByTestId('np-toggle').click();
  await page.getByTestId('now-playing').locator('.np-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(300);
  await shot(page, '05-now-playing-up-next');
  await page.getByTestId('np-close').click();

  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('genre-grid')).toBeVisible();
  for (const i of [3, 1]) await page.getByTestId('genre-grid').getByTestId('genre-fav').nth(i).click();
  await expect(page.getByTestId('fav-genres').getByTestId('genre-tile')).toHaveCount(2);
  await settle(page);
  await shot(page, '06-genres');

  await page.getByTestId('genre-tile').first().click();
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await settle(page);
  await shot(page, '07-genre-list');

  await page.getByTestId('search-fab').click();
  await page.getByTestId('search-input').blur();
  await expect(page.getByTestId('search-latest')).toBeVisible();
  await settle(page);
  await shot(page, '07a-search-latest');
  await page.getByTestId('search-input').fill('synth');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await page.getByTestId('search-input').blur();
  await settle(page);
  await shot(page, '07b-search');
  await page.getByTestId('search-input').fill('vaporwave sunset');
  await expect(page.getByTestId('search-bridge')).toBeVisible();
  await page.getByTestId('search-input').blur();
  await settle(page);
  await shot(page, '07c-search-bridge');
  await page.getByTestId('search-bridge').click();
  await expect(page.getByTestId('global-results')).toBeVisible();
  await settle(page);
  await shot(page, '07d-search-global-songs');
  await page.getByTestId('filter-albums').click();
  await expect(page.getByTestId('music-row').first()).toBeVisible();
  await settle(page);
  await shot(page, '07e-search-global-albums');
  await page.getByTestId('filter-artists').click();
  await expect(page.getByTestId('music-row').first()).toBeVisible();
  await settle(page);
  await shot(page, '07f-search-global-artists');
  await page.getByTestId('filter-songs').click();
  await page.getByTestId('global-results').getByTestId('track-play').nth(1).click();
  await page.getByTestId('search-close').click();
  await page.getByTestId('mini-open').click();
  await page.waitForTimeout(1200);
  await shot(page, '07g-now-playing-global');
  await page.getByTestId('np-close').click();

  // Artists: two favorites, then an artist page and an album.
  await page.getByTestId('tab-artists').click();
  await expect(page.getByTestId('artist-grid')).toBeVisible();
  for (const i of [4, 0]) await page.getByTestId('artist-grid').getByTestId('artist-fav').nth(i).click();
  await expect(page.getByTestId('fav-artists').getByTestId('artist-tile')).toHaveCount(2);
  await settle(page);
  await shot(page, '11-artists');
  await page.getByTestId('fav-artists').getByTestId('artist-tile').last().click();
  await expect(page.getByTestId('album-card').first()).toBeVisible();
  await settle(page);
  await shot(page, '12-artist');
  await page.getByTestId('screen-artist').evaluate((el) => {
    const sec = el.querySelector('[data-testid="artist-more"]') as HTMLElement;
    el.scrollTo(0, sec.offsetTop - (el.querySelector('.topbar') as HTMLElement).offsetHeight);
  });
  await page.waitForTimeout(300);
  await shot(page, '12b-artist-more');
  await page.getByTestId('album-card').first().click();
  await expect(page.getByTestId('screen-album').getByTestId('track-row').first()).toBeVisible();
  await settle(page);
  await shot(page, '13-album');
  await page.getByTestId('album-back').click();
  await page.getByTestId('screen-artist').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(400);
  await shot(page, '12c-artist-bottom');

  // Back-to-top on a long list.
  await page.getByTestId('tab-home').click();
  await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect(page.locator('.totop.on')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, '14-back-to-top');
  await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, 0));

  await page.getByTestId('tab-library').click();
  await settle(page);
  await shot(page, '08-library');

  await page.getByTestId('tab-settings').click();
  await settle(page);
  await shot(page, '09-settings');
  await page.getByTestId('about').scrollIntoViewIfNeeded();
  await shot(page, '10-settings-about');
});

for (const theme of ['light', 'c64', 'vt320', 'matrix', 'bubblegum', 'brutalist']) {
  test(`home (${theme})`, async ({ page }) => {
    await openHome(page, theme);
    await page.getByTestId('track-play').nth(0).click();
    await page.waitForTimeout(800);
    await shot(page, `home-${theme}`);
  });
}

test('now playing (brutalist)', async ({ page }) => {
  await openHome(page, 'brutalist');
  await page.getByTestId('track-play').nth(2).click();
  await page.getByTestId('mini-open').click();
  await page.waitForTimeout(1500);
  await shot(page, 'now-playing-brutalist');
});

test('narrow phone (360px): tabs, search modes, artist page', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openHome(page);
  await catalogReady(page);
  await page.getByTestId('track-play').nth(0).click();
  await page.getByTestId('search-fab').click();
  await page.getByTestId('search-input').fill('qzxv nebulon');
  await expect(page.getByTestId('search-bridge')).toBeVisible();
  await page.getByTestId('search-bridge').click();
  await expect(page.getByTestId('global-results')).toBeVisible();
  await page.getByTestId('search-input').blur();
  await settle(page);
  await shot(page, 'narrow-search-global');
  await page.getByTestId('search-close').click();
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  await expect(page.getByTestId('album-card').first()).toBeVisible();
  await settle(page);
  await shot(page, 'narrow-artist');
  await page.getByTestId('mini-open').click();
  await page.waitForTimeout(1000);
  await shot(page, 'narrow-now-playing');
});
