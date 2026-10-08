import { expect, test, type Page } from '@playwright/test';
import { stubMusic, stubYouTube } from './stubs';

/**
 * Screenshots of the lean search header (Jukebox, Global, Here), Home's rail and the
 * A–Z grids with the letter popup, in dark, matrix and light at 412px and 360px.
 * Saved to media/web-screenshots/rail-*.png. Run with: npm run screenshots
 */

const OUT = 'media/web-screenshots';
const THEMES = ['dark', 'matrix', 'light'] as const;
const WIDTHS = [412, 360] as const;

async function settle(page: Page) {
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function open(page: Page, theme: string, width: number) {
  await page.setViewportSize({ width, height: 915 });
  await page.addInitScript((t) => {
    localStorage.setItem('CapacitorStorage.settings', JSON.stringify({ theme: t, showNsfw: false, quality: 'high' }));
  }, theme);
  await stubYouTube(page);
  await stubMusic(page);
  await page.goto('/');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await settle(page);
}

/** Hold the fast-scroll thumb halfway down so the letter popup and label show. */
async function holdThumb(page: Page, screen: string) {
  await page.getByTestId(screen).evaluate((el) => el.scrollTo(0, el.scrollHeight * 0.45));
  const thumb = page.getByTestId(screen).getByTestId('scroll-thumb');
  await expect(thumb).toBeVisible();
  const b = (await thumb.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 40, { steps: 4 });
  await expect(page.getByTestId(screen).getByTestId('az-popup')).toHaveClass(/on/);
  await page.waitForTimeout(150);
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`rail and search header (${theme}, ${width}px)`, async ({ page }) => {
      const name = (s: string) => `${OUT}/rail-${s}-${theme}-${width}.png`;
      await open(page, theme, width);
      await page.screenshot({ path: name('home') });
      await page.getByTestId('sort-saved').click();
      await page.getByTestId('range-all').click();
      await expect(page.getByTestId('track-saves').first()).toBeVisible();
      await settle(page);
      await page.screenshot({ path: name('home-saved') });
      await page.getByTestId('sort-latest').click();

      await page.getByTestId('search-fab').click();
      await expect(page.getByTestId('search-latest')).toBeVisible();
      await settle(page);
      await page.screenshot({ path: name('search-jukebox') });
      await page.getByTestId('mode-global').click();
      await page.getByTestId('search-input').fill('Night Owls');
      await expect(page.getByTestId('global-results')).toBeVisible();
      await settle(page);
      await page.screenshot({ path: name('search-global') });
      await page.getByTestId('search-input').fill('');
      await page.getByTestId('search-close').click();

      await page.getByTestId('tab-genres').click();
      await page.getByTestId('genre-grid').getByTestId('genre-tile').first().click();
      await expect(page.getByTestId('screen-genre').getByTestId('track-row').first()).toBeVisible();
      await page.getByTestId('search-fab').click();
      await expect(page.getByTestId('here-list')).toBeVisible();
      await settle(page);
      await page.screenshot({ path: name('search-here') });
      await page.getByTestId('search-close').click();
      await page.getByTestId('genre-back').click();

      await page.getByTestId('grid-sort-az').click();
      await settle(page);
      await page.screenshot({ path: name('genres-az-top') });
      await holdThumb(page, 'screen-genres');
      await page.screenshot({ path: name('genres-az') });
      await page.mouse.up();

      await page.getByTestId('tab-artists').click();
      await page.getByTestId('grid-sort-az').click();
      await settle(page);
      await holdThumb(page, 'screen-artists');
      await page.screenshot({ path: name('artists-az') });
      await page.mouse.up();
    });
  }
}
