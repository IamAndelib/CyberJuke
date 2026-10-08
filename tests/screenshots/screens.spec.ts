import { AUTH_USER, expect, MEMBERS_POSTS, test } from '../fixtures';
import type { Page } from '@playwright/test';
import { nextFrame, openNowPlaying, seedStorage, setLyricsMode, SETTINGS_KEY, shot, toastsGone } from '../helpers';

/**
 * Phone-size screenshots of every screen, written to test-results/screenshots/ (a CI
 * artifact, never committed). Run with: npm run screenshots. The data is the fixture's
 * synthetic Jukebox; YouTube thumbnails and the player are synthetic stand-ins.
 */

const THEMES = ['dark', 'light', 'c64', 'vt320', 'matrix', 'crypt', 'bubblegum', 'brutalist'] as const;

/** Nothing loading, fonts in, every visible image decoded, a frame painted. */
async function settle(page: Page) {
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.images].every((img) => {
          const r = img.getBoundingClientRect();
          const onScreen = r.bottom > 0 && r.top < innerHeight && r.width > 0;
          return !onScreen || img.complete;
        }),
      ),
    )
    .toBe(true);
  await nextFrame(page);
}

async function open(page: Page, theme = 'dark', width = 412) {
  await page.setViewportSize({ width, height: 915 });
  await seedStorage(page, { [SETTINGS_KEY]: { theme, showNsfw: false, quality: 'high' } });
  await page.goto('/');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await settle(page);
}

async function scrollToTestId(page: Page, screen: string, id: string) {
  await page.getByTestId(screen).evaluate((el, target) => {
    const sec = el.querySelector(`[data-testid="${target}"]`) as HTMLElement;
    el.scrollTo(0, sec.offsetTop - (el.querySelector('.topbar') as HTMLElement).offsetHeight);
  }, id);
  await settle(page);
}

/** Hold the fast-scroll thumb part-way down so the A–Z letter popup shows. */
async function holdThumb(page: Page, screen: string) {
  const s = page.getByTestId(screen);
  await s.evaluate((el) => el.scrollTo(0, el.scrollHeight * 0.45));
  const thumb = s.getByTestId('scroll-thumb');
  await expect(thumb).toBeVisible();
  const b = (await thumb.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 40, { steps: 4 });
  await expect(s.getByTestId('az-popup')).toHaveClass(/\bon\b/);
  await settle(page);
}

test('every screen (dark)', async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  await shot(page, '01-home');
  await page.getByTestId('sort-saved').click();
  await page.getByTestId('range-all').click();
  await expect(page.getByTestId('track-saves').first()).toBeVisible();
  await settle(page);
  await shot(page, '01b-home-most-saved');
  await page.getByTestId('sort-latest').click();

  await page.getByTestId('track-play').nth(1).click();
  for (const i of [1, 3, 5]) {
    await page.getByTestId('track-more').nth(i).click();
    await page.getByTestId('menu-like').click();
  }
  await toastsGone(page);
  await settle(page);
  await shot(page, '02-home-playing');
  await page.getByTestId('track-more').nth(2).click();
  await expect(page.getByTestId('track-menu')).toBeVisible();
  await settle(page);
  await shot(page, '03-track-menu');
  await page.getByTestId('menu-add-queue').click();
  await toastsGone(page);

  await openNowPlaying(page);
  await settle(page);
  await shot(page, '04-now-playing');
  await page.getByTestId('np-toggle').click();
  await expect(page.getByTestId('np-toggle')).toHaveAttribute('aria-label', 'Play');
  await shot(page, '04b-now-playing-paused');
  await page.getByTestId('np-toggle').click();
  await page.getByTestId('up-next').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await settle(page);
  await shot(page, '05-now-playing-up-next');
  await setLyricsMode(page, 'greek');
  await page.getByTestId('now-playing').locator('.np-scroll').evaluate((el) => el.scrollTo(0, 0));
  await page.getByTestId('np-lyrics-toggle').click();
  await expect(page.getByTestId('np-lyrics')).not.toHaveAttribute('data-kind', 'loading');
  await settle(page);
  await shot(page, '05b-now-playing-lyrics');
  await page.getByTestId('np-lyrics-toggle').click();
  await page.getByTestId('np-close').click();

  await page.getByTestId('tab-genres').click();
  for (const i of [3, 1]) await page.getByTestId('genre-grid').getByTestId('genre-fav').nth(i).click();
  // Favourites move into their section on the next visit, not under the finger (M8).
  await page.getByTestId('tab-home').click();
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('fav-genres').getByTestId('genre-tile')).toHaveCount(2);
  await settle(page);
  await shot(page, '06-genres');
  await page.getByTestId('genre-tile').first().click();
  await expect(page.getByTestId('screen-genre').getByTestId('track-row').first()).toBeVisible();
  await settle(page);
  await shot(page, '07-genre-list');

  await page.getByTestId('search-fab').click();
  await page.getByTestId('search-input').blur();
  await expect(page.getByTestId('here-list')).toBeVisible();
  await settle(page);
  await shot(page, '07a-search-here');
  await page.getByTestId('mode-jukebox').click();
  await page.getByTestId('search-input').fill('neon');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await page.getByTestId('search-input').blur();
  await settle(page);
  await shot(page, '07b-search');
  await page.getByTestId('search-input').fill('qzxv nebulon');
  await expect(page.getByTestId('search-bridge')).toBeVisible();
  await page.getByTestId('search-input').blur();
  await shot(page, '07c-search-bridge');
  await page.getByTestId('search-bridge').click();
  await expect(page.getByTestId('global-results')).toBeVisible();
  await settle(page);
  await shot(page, '07d-search-global-songs');
  await page.getByTestId('filter-albums').click();
  await expect(page.getByTestId('music-row').first()).toBeVisible();
  await settle(page);
  await shot(page, '07e-search-global-albums');
  await page.getByTestId('search-close').click();

  await page.getByTestId('tab-artists').click();
  for (const i of [4, 0]) await page.getByTestId('artist-grid').getByTestId('artist-fav').nth(i).click();
  await page.getByTestId('tab-home').click();
  await page.getByTestId('tab-artists').click();
  await expect(page.getByTestId('fav-artists').getByTestId('artist-tile')).toHaveCount(2);
  await settle(page);
  await shot(page, '11-artists');
  await page.getByTestId('fav-artists').getByTestId('artist-tile').last().click();
  await expect(page.getByTestId('artist-singles').getByTestId('release-card').first()).toBeVisible();
  await settle(page);
  await shot(page, '12-artist');
  await scrollToTestId(page, 'screen-artist', 'artist-albums');
  await shot(page, '12b-artist-shelves');
  await page.getByTestId('artist-albums').getByTestId('see-all').click();
  await expect(page.getByTestId('screen-releases').getByTestId('release-card').first()).toBeVisible();
  await settle(page);
  await shot(page, '12c-see-all');
  await page.getByTestId('releases-back').click();
  await page.getByTestId('artist-albums').getByTestId('release-card').first().click();
  await expect(page.getByTestId('screen-album').getByTestId('track-row').first()).toBeVisible();
  await settle(page);
  await shot(page, '13-album');
  await page.getByTestId('album-back').click();
  await page.getByTestId('artist-back').click();
  await page.getByTestId('screen-artists').getByTestId('grid-sort-az').click();
  await holdThumb(page, 'screen-artists');
  await shot(page, '11b-artists-az-drag');
  await page.mouse.up();

  await page.getByTestId('tab-home').click();
  await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect(page.getByTestId('screen-home').locator('.totop.on')).toBeVisible();
  await settle(page);
  await shot(page, '14-back-to-top');

  await page.getByTestId('tab-library').click();
  await settle(page);
  await shot(page, '08-library');
  await page.getByTestId('tab-settings').click();
  await settle(page);
  await shot(page, '09-settings');
  await page.getByTestId('about').scrollIntoViewIfNeeded();
  await settle(page);
  await shot(page, '10-settings-about');
});

test('history days, the new-tracks pill, the block banner (dark)', async ({ page }) => {
  const now = Date.now();
  const D = 86_400_000;
  const titles = ['Midnight Drive', 'Neon Rain', 'Paper Moons', 'Static Hearts', 'Low Tide', 'Glass Garden', 'Afterglow', 'Echo Park'];
  const at = (d: number, h: number) => {
    const x = new Date(now - d * D);
    x.setHours(h, 0, 0, 0);
    return Math.min(now, x.getTime());
  };
  await seedStorage(page, {
    'CapacitorStorage.history': titles.map((t, i) => ({
      track: { id: 'seed' + i, ytId: ('seedvideo' + i).padEnd(11, 'x'), title: t, artist: ['The Midnight', 'Tycho', 'Khruangbin'][i % 3], genre: ['synthwave', 'ambient', 'funk'][i % 3], by: 'cyberpunk', postTitle: '', postUrl: '', createdAt: '2026-10-01T00:00:00Z', nsfw: false, artworkUrl: `https://i.ytimg.com/vi/${('seedvideo' + i).padEnd(11, 'x')}/hqdefault.jpg` },
      playedAt: at(i < 3 ? 0 : i < 5 ? 1 : 3, 20 - i),
    })),
  });
  const future = Date.now() + 3600_000;
  await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    const q = route.request().method() === 'POST' ? JSON.parse(route.request().postData() ?? '{}').structuredQuery : null;
    if (q?.limit === 25 && q.select?.fields?.[0]?.fieldPath === 'createdAt') {
      const rows = [0, 1, 2].map((i) => ({ document: { name: `p/new${i}`, fields: { createdAt: { timestampValue: new Date(future - i * 1000).toISOString() } } } }));
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(rows) });
    }
    return route.fallback();
  });
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/');
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await page.evaluate(() => (window as unknown as { __cyberjukeFreshness: { check(): Promise<void> } }).__cyberjukeFreshness.check());
  await expect(page.getByTestId('new-tracks-pill')).toBeVisible();
  await settle(page);
  await shot(page, 'pill');
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('history-day-label')).toHaveCount(3);
  await settle(page);
  await shot(page, 'history-days');
  await page.getByTestId('tab-home').click();
  await page.getByTestId('track-play').first().click();
  await page.evaluate(() => (window as unknown as { __cyberjukeBlock: { blocked(e: unknown): void } }).__cyberjukeBlock.blocked({ until: Date.now() + 15 * 60_000, reason: 'BOT_CHECK' }));
  await expect(page.getByTestId('block-banner')).toBeVisible();
  await settle(page);
  await shot(page, 'block-banner');
});

test('account: sign-in, an error, signed in, members-only rows (dark)', async ({ page }) => {
  await open(page);
  await page.getByTestId('tab-settings').click();
  await scrollToTestId(page, 'screen-settings', 'account');
  await shot(page, 'account-signin');
  await page.getByTestId('signin-email').fill(AUTH_USER.email);
  await page.getByTestId('signin-password').fill('wrong');
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signin-error')).toBeVisible();
  await page.getByTestId('signin-password').blur();
  await shot(page, 'account-signin-error');
  await page.getByTestId('signin-password').fill(AUTH_USER.password);
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signed-in')).toBeVisible();
  await toastsGone(page);
  await shot(page, 'account-signed-in');
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('screen-home').getByTestId('track-title').first()).toHaveText(MEMBERS_POSTS[0].title);
  await scrollToTestId(page, 'screen-home', 'home-rail');
  await shot(page, 'home-members');
});

for (const theme of THEMES) {
  test(`home and Now Playing (${theme})`, async ({ page }) => {
    await open(page, theme);
    await page.getByTestId('track-play').first().click();
    await settle(page);
    await shot(page, `home-${theme}`);
    await openNowPlaying(page);
    await settle(page);
    await shot(page, `now-playing-${theme}`);
  });
}

test('narrow phone (360px): search, artist page, Now Playing, settings', async ({ page }) => {
  await open(page, 'dark', 360);
  await page.getByTestId('track-play').first().click();
  await page.getByTestId('search-fab').click();
  await page.getByTestId('search-input').fill('qzxv nebulon');
  await page.getByTestId('search-bridge').click();
  await expect(page.getByTestId('global-results')).toBeVisible();
  await page.getByTestId('search-input').blur();
  await settle(page);
  await shot(page, 'narrow-search-global');
  await page.getByTestId('search-close').click();
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  await expect(page.getByTestId('artist-singles').getByTestId('release-card').first()).toBeVisible();
  await settle(page);
  await shot(page, 'narrow-artist');
  await openNowPlaying(page);
  await settle(page);
  await shot(page, 'narrow-now-playing');
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('check-every').scrollIntoViewIfNeeded();
  await settle(page);
  await shot(page, 'narrow-settings');
});
