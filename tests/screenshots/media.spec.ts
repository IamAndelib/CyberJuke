import { expect, test } from '../fixtures';
import type { Page } from '@playwright/test';
import { nextFrame, openNowPlaying, openSearch, seedStorage, setLyricsMode, SETTINGS_KEY, shot, toastsGone } from '../helpers';

/**
 * The repository's media (README highlights, theme gallery, social card): one shot per
 * highlighted part of the app, written to test-results/screenshots/media-*.png.
 * scripts/make-media.sh runs this and turns the shots into media/. The data is the
 * fixture's synthetic Jukebox, so no real posts or people appear.
 */

const THEMES = ['dark', 'light', 'c64', 'vt320', 'matrix', 'crypt', 'bubblegum', 'brutalist'] as const;

/** Nothing loading, fonts in, every visible image decoded, toasts gone, a frame painted. */
async function settle(page: Page) {
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
  await toastsGone(page);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.images].every((img) => {
          const r = img.getBoundingClientRect();
          return !(r.bottom > 0 && r.top < innerHeight && r.width > 0) || img.complete;
        }),
      ),
    )
    .toBe(true);
  await nextFrame(page);
}

async function open(page: Page, theme = 'dark') {
  await page.setViewportSize({ width: 412, height: 915 });
  await seedStorage(page, { [SETTINGS_KEY]: { theme, showNsfw: false, quality: 'high' } });
  await page.goto('/');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await settle(page);
}

test('README highlights', async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  await shot(page, 'media-01-home');

  // Something liked and queued, then a radio from Home: Up next shows all three parts.
  for (const i of [2, 4]) {
    await page.getByTestId('track-more').nth(i).click();
    await page.getByTestId('menu-like').click();
  }
  await page.getByTestId('track-play').nth(0).click();
  for (const i of [3, 5]) {
    await page.getByTestId('track-more').nth(i).click();
    await page.getByTestId('menu-add-queue').click();
  }
  await openNowPlaying(page);
  await settle(page);
  await shot(page, 'media-02-now-playing');
  await page.getByTestId('up-next').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(page.getByTestId('upnext-autoplay-label')).toBeVisible();
  await settle(page);
  await shot(page, 'media-03-up-next');

  await setLyricsMode(page, 'english');
  await page.getByTestId('now-playing').locator('.np-scroll').evaluate((el) => el.scrollTo(0, 0));
  await page.getByTestId('np-lyrics-toggle').click();
  await expect(page.getByTestId('np-lyrics')).not.toHaveAttribute('data-kind', 'loading');
  await settle(page);
  await shot(page, 'media-04-lyrics');
  await page.getByTestId('np-lyrics-toggle').click();
  await page.getByTestId('np-close').click();

  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  await expect(page.getByTestId('artist-singles').getByTestId('release-card').first()).toBeVisible();
  await settle(page);
  await shot(page, 'media-05-artist');
  await page.getByTestId('artist-back').click();

  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-grid').locator('[data-testid="genre-tile"][data-genre="synthwave"]').click();
  await expect(page.getByTestId('screen-genre').getByTestId('track-row').first()).toBeVisible();
  await settle(page);
  await shot(page, 'media-06-genre');
  await page.getByTestId('genre-back').click();

  // Here on the Genres tab, typo and all.
  await openSearch(page);
  await page.getByTestId('search-input').fill('synthwav');
  await expect(page.getByTestId('here-places').getByTestId('here-place').first()).toBeVisible();
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-input').blur();
  await settle(page);
  await shot(page, 'media-08-here-genres');
  await page.getByTestId('search-close').click();

  // Search from Home: recent searches, then Jukebox results.
  await page.getByTestId('tab-home').click();
  for (const q of ['daft punk', 'night drive']) {
    await openSearch(page);
    await page.getByTestId('search-input').fill(q);
    await page.getByTestId('search-input').press('Enter');
    await page.getByTestId('search-close').click();
  }
  await openSearch(page);
  await page.getByTestId('search-input').fill('neon');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await page.getByTestId('search-input').blur();
  await settle(page);
  await shot(page, 'media-07-search');
  await page.getByTestId('search-close').click();

  await page.getByTestId('tab-library').click();
  await settle(page);
  await shot(page, 'media-09-library');
});

// One test per theme: each gets a fresh page, so its seeded settings apply.
for (const theme of THEMES) {
  test(`theme gallery: ${theme}`, async ({ page }) => {
    await open(page, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await shot(page, `media-theme-${theme}`);
  });
}
