import { expect, test, type Page } from '@playwright/test';
import { AUTH_USER, MEMBERS_POSTS, stubAuth, stubMusic, stubYouTube } from './stubs';

/**
 * Round 4 screenshots: Settings → Account (signed out, error, signed in), Home with
 * [members] rows, the artist page with every shelf, a "See all" grid and the A–Z
 * letter popup while the thumb is dragged. Dark at 412px and 360px, plus the account
 * form and the artist page in every theme at 412px.
 * Saved to media/web-screenshots/r4-*.png. Run with: npm run screenshots
 */

const OUT = 'media/web-screenshots';
const ALL_THEMES = ['dark', 'light', 'c64', 'vt320', 'matrix', 'crypt', 'bubblegum', 'brutalist'] as const;

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
  await stubAuth(page);
  await page.goto('/');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await settle(page);
}

async function scrollToTestId(page: Page, screen: string, id: string) {
  await page.getByTestId(screen).evaluate((el, target) => {
    const sec = el.querySelector(`[data-testid="${target}"]`) as HTMLElement;
    el.scrollTo(0, sec.offsetTop - (el.querySelector('.topbar') as HTMLElement).offsetHeight);
  }, id);
  await page.waitForTimeout(300);
}

async function showAccount(page: Page) {
  await page.getByTestId('tab-settings').click();
  await scrollToTestId(page, 'screen-settings', 'account');
}

async function openArtist(page: Page) {
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  await expect(page.getByTestId('artist-singles').getByTestId('release-card').first()).toBeVisible();
  await settle(page);
}

for (const width of [412, 360] as const) {
  test(`round 4 (dark, ${width}px)`, async ({ page }) => {
    const name = (s: string) => `${OUT}/r4-${s}-dark-${width}.png`;
    await open(page, 'dark', width);

    // Settings → Account: signed out, an error, signed in.
    await showAccount(page);
    await page.screenshot({ path: name('signin') });
    await page.getByTestId('signin-email').fill(AUTH_USER.email);
    await page.getByTestId('signin-password').fill('wrong');
    await page.getByTestId('signin-submit').click();
    await expect(page.getByTestId('signin-error')).toBeVisible();
    await page.getByTestId('signin-password').blur();
    await page.screenshot({ path: name('signin-error') });
    await page.getByTestId('signin-password').fill(AUTH_USER.password);
    await page.getByTestId('signin-submit').click();
    await expect(page.getByTestId('signed-in')).toBeVisible();
    await page.waitForTimeout(3000); // let the toast go
    await showAccount(page);
    await page.screenshot({ path: name('signed-in') });

    // Home with [members] rows.
    await page.getByTestId('tab-home').click();
    await expect(page.getByTestId('screen-home').getByTestId('track-title').first()).toHaveText(MEMBERS_POSTS[0].title);
    await settle(page);
    await scrollToTestId(page, 'screen-home', 'home-rail');
    await page.screenshot({ path: name('home-members') });
    // Now Playing with the tag.
    await page.getByTestId('screen-home').getByTestId('track-play').first().click();
    await page.getByTestId('mini-open').click();
    await expect(page.getByTestId('now-playing')).toHaveClass(/open/);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: name('now-playing-members') });
    await page.getByTestId('np-close').click();

    // Artist page: every shelf.
    await openArtist(page);
    await page.screenshot({ path: name('artist-top') });
    await scrollToTestId(page, 'screen-artist', 'artist-top');
    await page.screenshot({ path: name('artist-top-songs') });
    await scrollToTestId(page, 'screen-artist', 'artist-albums');
    await page.screenshot({ path: name('artist-shelves') });
    await page.getByTestId('screen-artist').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(300);
    await page.screenshot({ path: name('artist-bottom') });

    // See all grid.
    await page.getByTestId('artist-albums').getByTestId('see-all').click();
    await expect(page.getByTestId('screen-releases').getByTestId('release-card').first()).toBeVisible();
    await settle(page);
    await page.screenshot({ path: name('see-all-albums') });
    await page.getByTestId('releases-back').click();
    await page.getByTestId('artist-singles').getByTestId('see-all').click();
    await expect(page.getByTestId('screen-releases').getByTestId('release-card').first()).toBeVisible();
    await settle(page);
    await page.screenshot({ path: name('see-all-singles') });
    await page.getByTestId('releases-back').click();

    // A–Z letter popup while dragging the thumb.
    await page.getByTestId('artist-back').click();
    await page.getByTestId('grid-sort-az').click();
    await settle(page);
    const screen = page.getByTestId('screen-artists');
    await screen.evaluate((el) => el.scrollTo(0, el.scrollHeight * 0.45));
    const thumb = screen.getByTestId('scroll-thumb');
    await expect(thumb).toBeVisible();
    const b = (await thumb.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 40, { steps: 4 });
    await expect(screen.getByTestId('az-popup')).toHaveClass(/\bon\b/);
    await page.waitForTimeout(150);
    await page.screenshot({ path: name('az-drag') });
    await page.mouse.up();
  });
}

test('round 4 in every theme (412px)', async ({ page }) => {
  test.setTimeout(240_000);
  for (const theme of ALL_THEMES) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await open(page, theme, 412);
    const name = (s: string) => `${OUT}/r4-${s}-${theme}-412.png`;
    await showAccount(page);
    await page.getByTestId('signin-email').fill(AUTH_USER.email);
    await page.getByTestId('signin-password').fill('wrong');
    await page.getByTestId('signin-submit').click();
    await expect(page.getByTestId('signin-error')).toBeVisible();
    await page.getByTestId('signin-password').blur();
    await page.screenshot({ path: name('signin-error') });
    await page.getByTestId('signin-password').fill(AUTH_USER.password);
    await page.getByTestId('signin-submit').click();
    await expect(page.getByTestId('signed-in')).toBeVisible();
    await page.getByTestId('tab-home').click();
    await expect(page.getByTestId('screen-home').getByTestId('track-title').first()).toHaveText(MEMBERS_POSTS[0].title);
    await settle(page);
    await scrollToTestId(page, 'screen-home', 'home-rail');
    await page.screenshot({ path: name('home-members') });
    await openArtist(page);
    await scrollToTestId(page, 'screen-artist', 'artist-albums');
    await page.screenshot({ path: name('artist-shelves') });
  }
});
