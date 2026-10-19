import { expect, test } from '../fixtures';
import { failImagesOnce, setImagesOffline } from '../fixtures/youtube';
import type { Locator, Page } from '@playwright/test';
import { bufferedAhead, expectStable, isFeedQuery, opened, openNowPlaying, openSearch, playerCalls, recordOpens, scrollTo, seedStorage, setOffline, setVisibility, start, waitForTracks } from '../helpers';

/**
 * When things go wrong: YouTube limiting the network or changing something (Y1),
 * going offline and back, a failed start, links that aren't Cyberspace's, and the
 * CSP check itself.
 */

type Block = { blocked(e: { until: number; reason: string }): void; unblocked(): void; extractorBroken(e: { message: string }): void };
const blockHook = (page: Page, fn: (b: Block) => void) => page.evaluate(`(${fn.toString()})(window.__cyberjukeBlock)`);


test('a block shows the banner with a countdown above the mini player; dismiss, unblock, Open in YouTube', async ({ page }) => {
  await recordOpens(page);
  await start(page);
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await expect(page.getByTestId('block-banner')).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { __cyberjukeBlock: Block }).__cyberjukeBlock.blocked({ until: Date.now() + 14 * 60_000 + 30_000, reason: 'BOT_CHECK' }));
  const banner = page.getByTestId('block-banner');
  await expect(page.getByTestId('block-text')).toHaveText('YouTube is limiting requests from your network. Trying again in 15 min.');
  await expect(page.getByTestId('block-retry')).toHaveText('[Try now]');
  // Above the mini player, and the app stays usable.
  expect((await banner.boundingBox())!.y + (await banner.boundingBox())!.height).toBeLessThanOrEqual((await page.getByTestId('mini-player').boundingBox())!.y + 1);
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('screen-genres')).toBeVisible();
  await page.getByTestId('tab-home').click();

  // The countdown follows a shorter block.
  await page.evaluate(() => (window as unknown as { __cyberjukeBlock: Block }).__cyberjukeBlock.blocked({ until: Date.now() + 90_000, reason: 'RATE_LIMIT' }));
  await expect(page.getByTestId('block-text')).toContainText('Trying again in 2 min');

  // The ⋯ menu offers the track on YouTube while blocked.
  const ytId = /\/vi\/([^/]+)\//.exec((await page.locator('.mini .art img').getAttribute('src'))!)![1];
  await page.getByTestId('track-more').first().click();
  await page.getByTestId('menu-open-youtube').click();
  expect(await opened(page)).toEqual([`https://music.youtube.com/watch?v=${ytId}`]);

  // Dismissed: gone until a new block.
  await page.getByTestId('block-dismiss').click();
  await expect(banner).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __cyberjukeBlock: Block }).__cyberjukeBlock.blocked({ until: Date.now() + 5 * 60_000, reason: 'BOT_CHECK' }));
  await expect(banner).toBeVisible();
  await page.evaluate(() => (window as unknown as { __cyberjukeBlock: Block }).__cyberjukeBlock.unblocked());
  await expect(banner).toHaveCount(0);
  await page.getByTestId('track-more').first().click();
  await expect(page.getByTestId('menu-open-youtube')).toHaveCount(0);
});

test('a block clears by itself when its time is up', async ({ page }) => {
  await start(page);
  await page.evaluate(() => (window as unknown as { __cyberjukeBlock: Block }).__cyberjukeBlock.blocked({ until: Date.now() + 1500, reason: 'BOT_CHECK' }));
  await expect(page.getByTestId('block-banner')).toContainText('Trying again in 1 min');
  await expect(page.getByTestId('block-banner')).toHaveCount(0, { timeout: 5000 });
});

test('"Try now" asks the player to try again at once and hides the banner; a new block brings it back', async ({ page }) => {
  await start(page);
  await blockHook(page, (b) => b.blocked({ until: Date.now() + 10 * 60_000, reason: 'BOT_CHECK' }));
  const banner = page.getByTestId('block-banner');
  await expect(banner).toBeVisible();
  await page.getByTestId('block-retry').click();
  await expect(banner).toHaveCount(0);
  const calls = await playerCalls(page);
  expect(calls.filter((c) => c[0] === 'retryNow')).toHaveLength(1);
  // YouTube still refuses: native sends the next, longer block.
  await blockHook(page, (b) => b.blocked({ until: Date.now() + 30 * 60_000, reason: 'BOT_CHECK' }));
  await expect(page.getByTestId('block-text')).toContainText('Trying again in 30 min');
});

test('"YouTube changed something" links to the releases and can be dismissed', async ({ page }) => {
  await recordOpens(page);
  await start(page);
  await blockHook(page, (b) => b.extractorBroken({ message: 'ParsingException: could not find player' }));
  const banner = page.getByTestId('broken-banner');
  await expect(banner).toContainText('YouTube changed something. Update CyberJuke when a new version is out.');
  await page.getByTestId('broken-releases').click();
  expect(await opened(page)).toEqual(['https://github.com/IamAndelib/CyberJuke/releases']);
  await page.getByTestId('broken-dismiss').click();
  await expect(banner).toHaveCount(0);
});

const BANNER = '[ offline ] no carrier · connect to play';
const NO_CARRIER = /^\[ NO CARRIER \]Line's deadConnect to the internet to load the Jukebox\.\s*Redial$/;
const NO_CARRIER_GLOBAL = /^\[ NO CARRIER \]Line's deadConnect to the internet to search Global\.\s*Redial$/;
const TAP_TOAST = 'No carrier. Connect to play.';

test('a handover blip shorter than the grace changes nothing; a loss that lasts goes offline', async ({ page, backend }) => {
  await start(page);
  await page.evaluate(() => (window.__cyberjukeOfflineGraceMs = 1500));
  const home = page.getByTestId('screen-home');
  const onScreen = async () => ({
    banner: await page.getByTestId('offline-banner').count(),
    dimmed: await home.locator('.row.off').count(),
    noCarrier: await page.getByTestId('offline').count(),
    rows: await home.getByTestId('track-row').count(),
  });
  const before = await onScreen();
  expect(before).toMatchObject({ banner: 0, dimmed: 0, noCarrier: 0 });

  // Wi-Fi to data: "not connected" for under a second, then back.
  await setOffline(page, backend, true);
  expect(await expectStable(onScreen, 700)).toEqual(before);
  await setOffline(page, backend, false);
  // Past the grace too: nothing happened, nothing reloaded.
  expect(await expectStable(onScreen, 1500)).toEqual(before);

  // Gone for longer than the grace: offline.
  await setOffline(page, backend, true);
  await expect(page.getByTestId('offline-banner')).toHaveText(BANNER);
  // And back: online at once.
  await setOffline(page, backend, false);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0, { timeout: 1000 });
});

/** The `[ NO CARRIER ]` state sits in the middle of its screen's content box. */
async function expectCentred(page: Page, screen: string): Promise<void> {
  const gaps = await page.getByTestId(screen).evaluate((el) => {
    const body = el.querySelector('.screen-body') as HTMLElement;
    const b = body.getBoundingClientRect();
    const cs = getComputedStyle(body);
    const s = el.querySelector('[data-testid="offline"]')!.getBoundingClientRect();
    return { above: s.top - (b.top + parseFloat(cs.paddingTop)), below: b.bottom - parseFloat(cs.paddingBottom) - s.bottom };
  });
  expect(gaps.above).toBeGreaterThan(100);
  expect(Math.abs(gaps.above - gaps.below)).toBeLessThanOrEqual(2);
}

test('offline, lists already shown stay with their rows dimmed; lists opened offline ask to connect; all come back by themselves', async ({ page, backend }) => {
  await start(page);
  await setOffline(page, backend, true);
  await expect(page.getByTestId('offline-banner')).toHaveText(BANNER);

  // Home was showing Latest: its rows stay, dimmed (with a short fade), and a tap says to connect.
  const home = page.getByTestId('screen-home');
  const rows = home.getByTestId('track-row');
  await expect(rows.first()).toHaveClass(/\boff\b/);
  await expect(rows.first().getByTestId('track-play')).toHaveAttribute('aria-disabled', 'true');
  await expect(home.locator('.row:not(.off)')).toHaveCount(0);
  await expect(home.getByTestId('offline')).toHaveCount(0);
  expect(await rows.first().locator('.row-main').evaluate((e) => getComputedStyle(e).transitionDuration)).toBe('0.25s');
  await rows.first().getByTestId('track-play').click({ force: true });
  await expect(page.getByTestId('toast')).toHaveText(TAP_TOAST);
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
  await expect(home.getByTestId('shuffle-all')).toBeVisible();
  await expect(home.getByTestId('genre-chips')).toBeVisible();

  // The Genres and Artists grids, opened offline: no carrier, alone and in the middle.
  await page.getByTestId('tab-genres').click();
  const genres = page.getByTestId('screen-genres');
  await expect(genres.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(genres.getByTestId('offline')).toHaveClass(/\bappear\b/);
  await expect(genres.getByTestId('genre-tile')).toHaveCount(0);
  await expect(genres.locator('.fineprint')).toHaveCount(0);
  await expectCentred(page, 'screen-genres');
  // Redial while still offline: still no carrier.
  await genres.getByTestId('retry').click();
  await expect(genres.getByTestId('retry')).toHaveAttribute('aria-busy', 'false');
  await expect(genres.getByTestId('offline')).toBeVisible();
  await page.getByTestId('tab-artists').click();
  const artists = page.getByTestId('screen-artists');
  await expect(artists.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(artists.getByTestId('artist-tile')).toHaveCount(0);
  await expect(artists.locator('.fineprint')).toHaveCount(0);
  await expectCentred(page, 'screen-artists');

  // Search: the Jukebox and Global.
  await openSearch(page);
  const search = page.getByTestId('search');
  await page.getByTestId('mode-jukebox').click();
  await expect(search.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(search.getByTestId('track-row')).toHaveCount(0);
  await page.getByTestId('mode-global').click();
  await page.getByTestId('search-input').fill('Lumen');
  await expect(search.getByTestId('offline')).toHaveText(NO_CARRIER_GLOBAL);
  await expect(search.getByTestId('global-results')).toHaveCount(0);

  // Back online: each comes back without a tap, the banner goes.
  await setOffline(page, backend, false);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await expect(search.getByTestId('global-results')).toBeVisible();
  await expect(search.getByTestId('offline')).toHaveCount(0);
  await page.getByTestId('search-close').click();
  await expect(artists.getByTestId('artist-tile').first()).toBeVisible();
  await expect(artists.locator('.fineprint')).toBeVisible();
  await page.getByTestId('tab-genres').click();
  await expect(genres.getByTestId('genre-tile').first()).toBeVisible();
  await expect(genres.locator('.fineprint')).toBeVisible();
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  await expect(home.locator('.row.off')).toHaveCount(0);
  await expect(rows.first().getByTestId('track-play')).not.toHaveAttribute('aria-disabled');
});

test('offline, an open genre page and artist page keep their rows, dimmed; a tap says to connect', async ({ page, backend }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').first().click();
  const genre = page.getByTestId('screen-genre');
  const rows = genre.getByTestId('track-row');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  await setOffline(page, backend, true);
  await expect(rows.first()).toHaveClass(/\boff\b/);
  await expect(rows).toHaveCount(count);
  await expect(genre.getByTestId('offline')).toHaveCount(0);
  // Play sits where the tile was: a tap this soon would be the tile's double tap (M9).
  await page.waitForTimeout(350); // past the double-tap guard
  await genre.getByTestId('genre-play-all').click();
  await expect(page.getByTestId('toast')).toHaveText(TAP_TOAST);
  await rows.nth(1).getByTestId('track-play').click({ force: true });
  await expect(page.getByTestId('toast')).toHaveText(TAP_TOAST);
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
  await setOffline(page, backend, false);
  await expect(genre.locator('.row.off')).toHaveCount(0);

  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  const artist = page.getByTestId('screen-artist');
  await expect(artist.getByTestId('artist-jukebox')).toBeVisible();
  await setOffline(page, backend, true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(artist.getByTestId('artist-jukebox')).toBeVisible();
  await expect(artist.getByTestId('offline')).toHaveCount(0);
  await expect(artist.locator('.row.off').first()).toBeVisible();
  await setOffline(page, backend, false);
  await expect(artist.locator('.row.off')).toHaveCount(0);
});

test('launched offline: no carrier on Home, Genres and Artists (no intro, in the middle), then the lists once back', async ({ page, backend }) => {
  // The device is offline from the start (navigator.onLine, which the Network plugin reads on the web).
  await page.addInitScript(() => {
    const w = window as unknown as { __netUp: boolean };
    w.__netUp = false;
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => w.__netUp });
  });
  backend.offline = true;
  await page.goto('/');
  await expect(page.getByTestId('offline-banner')).toHaveText(BANNER);
  const home = page.getByTestId('screen-home');
  await expect(home.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(home.getByTestId('track-row')).toHaveCount(0);
  for (const tab of ['genres', 'artists'] as const) {
    await page.getByTestId(`tab-${tab}`).click();
    const screen = page.getByTestId(`screen-${tab}`);
    await expect(screen.getByTestId('offline')).toHaveText(NO_CARRIER);
    await expect(screen.locator('.fineprint')).toHaveCount(0);
    await expectCentred(page, `screen-${tab}`);
  }

  backend.offline = false;
  await page.evaluate(() => {
    (window as unknown as { __netUp: boolean }).__netUp = true;
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await expect(page.getByTestId('screen-artists').getByTestId('artist-tile').first()).toBeVisible();
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  await expect(home.getByTestId('offline')).toHaveCount(0);
});

test('launched offline with the Jukebox saved from before: Genres and Artists show no count over "Connect to load"', async ({ page, backend }) => {
  await start(page);
  for (const tab of ['genres', 'artists'] as const) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page.getByTestId(`screen-${tab}`).locator('.topbar-sub')).toContainText(`${tab} on the Jukebox`);
  }
  await page.addInitScript(() => {
    const w = window as unknown as { __netUp: boolean };
    w.__netUp = false;
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => w.__netUp });
  });
  backend.offline = true;
  await page.reload();
  await expect(page.getByTestId('offline-banner')).toHaveText(BANNER);
  const sub = { genres: 'Browse by genre', artists: 'Browse by artist' };
  for (const tab of ['genres', 'artists'] as const) {
    await page.getByTestId(`tab-${tab}`).click();
    const screen = page.getByTestId(`screen-${tab}`);
    await expect(screen.getByTestId('offline')).toHaveText(NO_CARRIER);
    await expect(screen.locator('.topbar-sub')).toHaveText(sub[tab]);
  }
  backend.offline = false;
  await page.evaluate(() => {
    (window as unknown as { __netUp: boolean }).__netUp = true;
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByTestId('screen-artists').locator('.topbar-sub')).toContainText('artists on the Jukebox');
});

test('offline, the paused track resumes; Shuffle says to connect and leaves the player as it was', async ({ page, backend }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  const toggle = page.getByTestId('mini-toggle');
  await expect(toggle).toHaveAttribute('aria-label', 'Pause');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
  // Paused mid-song, with audio loaded ahead (the fake player may not have started loading yet).
  await bufferedAhead(page, 30_000);
  const title = await page.getByTestId('mini-title').textContent();
  const queued = (await playerCalls(page)).filter((c) => c[0] === 'setQueue').length;

  await setOffline(page, backend, true);
  // A paused track with audio loaded resumes, saved or not (native plays what it has buffered).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Pause');
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
  await page.getByTestId('shuffle-all').click();
  await expect(page.getByTestId('toast')).toHaveText(TAP_TOAST);
  await expect(page.getByTestId('shuffle-all')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('mini-title')).toHaveText(title!);
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
  expect((await playerCalls(page)).filter((c) => c[0] === 'setQueue')).toHaveLength(queued);

  // Back online, Play plays.
  await setOffline(page, backend, false);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Pause');
});

test('offline, Library stays, its rows dimmed; a tap says to connect', async ({ page, backend }) => {
  const track = (id: string) => ({ id, ytId: 'abcdefghij' + id.slice(-1), title: 'Track ' + id, artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '2026-01-01T00:00:00Z', nsfw: false, artworkUrl: '' });
  await seedStorage(page, { 'CapacitorStorage.liked': [track('l1'), track('l2')] });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  const rows = page.getByTestId('liked-list').getByTestId('track-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByTestId('track-play')).not.toHaveAttribute('aria-disabled');

  await setOffline(page, backend, true);
  await expect(rows).toHaveCount(2);
  for (const play of await rows.getByTestId('track-play').all()) await expect(play).toHaveAttribute('aria-disabled', 'true');
  await expect(rows.first()).toHaveClass(/\boff\b/);
  // Tapped anyway (Playwright clicks what's aria-disabled only with force).
  await rows.first().getByTestId('track-play').click({ force: true });
  await expect(page.getByTestId('toast')).toHaveText(TAP_TOAST);
  await page.getByTestId('lib-play-all').click();
  await expect(page.getByTestId('toast')).toHaveText(TAP_TOAST);
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
  expect((await playerCalls(page)).filter((c) => c[0] === 'setQueue')).toHaveLength(0);

  await setOffline(page, backend, false);
  await expect(rows.first().getByTestId('track-play')).not.toHaveAttribute('aria-disabled');
  // The other row: a second tap on the same one this soon counts as a double tap (M9).
  await rows.nth(1).getByTestId('track-play').click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
});

test('lists that failed while offline load again when the connection comes back', async ({ page, backend }) => {
  await page.goto('/');
  await waitForTracks(page);
  await page.context().setOffline(true);
  backend.offline = true;
  await page.getByTestId('genre-chip').nth(2).click();
  await expect(page.getByTestId('offline')).toBeVisible();
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  backend.offline = false;
  await page.context().setOffline(false);
  // No tap on Retry: back online, the list on screen loads by itself.
  await waitForTracks(page);
  await expect(page.getByTestId('offline')).toHaveCount(0);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
});

test('a list that failed during a handover blip loads again when the OS reports connected', async ({ page, backend }) => {
  await start(page);
  // A grace the blip never outlasts: the app never counts as offline, so it never comes back online either.
  await page.evaluate(() => (window.__cyberjukeOfflineGraceMs = 60_000));
  await setOffline(page, backend, true);
  await page.getByTestId('genre-chip').nth(2).click();
  await expect(page.getByTestId('offline')).toBeVisible();
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await setOffline(page, backend, false);
  // The OS says "connected" again (the Network plugin's report at the end of a handover).
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  // No tap on Redial: the list loads by itself.
  await waitForTracks(page);
  await expect(page.getByTestId('offline')).toHaveCount(0);
});

test('a list that failed behind a Wi-Fi login page loads again when the app comes back to the foreground', async ({ page, backend }) => {
  await start(page);
  // The OS says connected, but nothing gets through.
  backend.offline = true;
  await page.getByTestId('genre-chip').nth(2).click();
  await expect(page.getByTestId('offline')).toBeVisible();
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  backend.offline = false;
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await waitForTracks(page);
  await expect(page.getByTestId('offline')).toHaveCount(0);
});

test('a page that fails to load more waits for Retry instead of asking again and again', async ({ page, backend }) => {
  await start(page);
  const home = page.getByTestId('screen-home');
  const rows = home.getByTestId('track-row');
  const retry = home.getByRole('button', { name: 'Retry loading more' });
  const laterPages = () => backend.queries.filter((q) => isFeedQuery(q) && q.startAt).length;
  backend.failPages = true;
  await expect
    .poll(async () => {
      await scrollTo(page, 'screen-home', 1e6);
      return laterPages();
    })
    .toBeGreaterThan(0);
  await expect(retry).toBeVisible();
  // The end of the list stays in view, and the failed page isn't asked for again by itself.
  const asked = laterPages();
  await page.waitForTimeout(3000);
  expect(laterPages()).toBe(asked);
  await expect(retry).toBeVisible();
  backend.failPages = false;
  const shown = await rows.count();
  await retry.click();
  await expect.poll(() => rows.count()).toBeGreaterThan(shown);
});

test('art that failed to load offline loads once the connection is back, and on coming back to the app', async ({ page, backend }) => {
  // 130 liked songs with art: Liked shows 60 rows, and 60 more each time you scroll near its end.
  const track = (n: number) => {
    const ytId = 'art' + String(n).padStart(8, '0');
    return { id: `a${n}`, ytId, title: `Art ${n}`, artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '2026-01-01T00:00:00Z', nsfw: false, artworkUrl: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` };
  };
  await seedStorage(page, { 'CapacitorStorage.liked': Array.from({ length: 130 }, (_, i) => track(i)) });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  const rows = page.getByTestId('liked-list').getByTestId('track-row');
  await expect(rows).toHaveCount(60);
  await expect(rows.first().locator('img')).toBeVisible();
  const loaded = (row: Locator) => row.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  const toEnd = () => page.getByTestId('screen-library').evaluate((el) => el.scrollTo(0, el.scrollHeight));

  // Offline, rows scrolled into view get the placeholder.
  await setOffline(page, backend, true);
  await toEnd();
  await expect(rows).toHaveCount(120);
  const offlineRow = rows.nth(60);
  await offlineRow.scrollIntoViewIfNeeded();
  await expect(offlineRow.locator('.art-ph')).toBeVisible();
  await expect(offlineRow.locator('img')).toHaveCount(0);

  // Back online: they load, with no scrolling or tapping.
  await setOffline(page, backend, false);
  await expect(offlineRow.locator('img')).toBeVisible();
  await expect.poll(() => loaded(offlineRow)).toBe(true);
  await expect(rows.first().locator('img')).toBeVisible();

  // Online but nothing gets through (a Wi-Fi login page): back in the app, they load.
  setImagesOffline(page, true);
  await toEnd();
  await expect(rows).toHaveCount(130);
  const cutOffRow = rows.last();
  await cutOffRow.scrollIntoViewIfNeeded();
  await expect(cutOffRow.locator('.art-ph')).toBeVisible();
  setImagesOffline(page, false);
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await expect(cutOffRow.locator('img')).toBeVisible();
  await expect.poll(() => loaded(cutOffRow)).toBe(true);
});

test('art caught in the network switch as the connection comes back still loads', async ({ page, backend }) => {
  const track = (n: number) => {
    const ytId = 'sw' + String(n).padStart(9, '0');
    return { id: `s${n}`, ytId, title: `Switch ${n}`, artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '2026-01-01T00:00:00Z', nsfw: false, artworkUrl: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` };
  };
  await seedStorage(page, { 'CapacitorStorage.liked': Array.from({ length: 8 }, (_, i) => track(i)) });
  // The images' host already gone as the app opens, then the connection with it.
  setImagesOffline(page, true);
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  const row = page.getByTestId('liked-list').getByTestId('track-row').first();
  await expect(row.locator('.art-ph')).toBeVisible();
  await setOffline(page, backend, true);
  // The phone reports the connection, but the request each image sends right then is caught in
  // the switch and fails; the next one would load.
  failImagesOnce(page);
  await setOffline(page, backend, false);
  await expect(row.locator('img')).toBeVisible();
  await expect.poll(() => row.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
});

test.describe('a start that fails', () => {
  test.use({ allowPageErrors: [/Simulated boot failure/] });
  test('shows an error screen with Retry instead of a blank page', async ({ page }) => {
    await seedStorage(page, { __cyberjukeFailBoot: '1' });
    await page.goto('/');
    await expect(page.getByTestId('boot-error')).toContainText("CyberJuke couldn't start");
    await expect(page.getByTestId('boot-error-detail')).toContainText('Simulated boot failure');
    await page.evaluate(() => localStorage.removeItem('__cyberjukeFailBoot'));
    await page.getByTestId('boot-retry').click();
    await waitForTracks(page);
  });
});

test('a post link only opens on beta.cyberspace.online', async ({ page }) => {
  await recordOpens(page);
  const track = (id: string, postUrl: string) => ({ id, ytId: 'abcdefghij' + id.slice(-1), title: 'Track ' + id, artist: 'A', genre: '', by: 'someone', postTitle: '', postUrl, createdAt: '2026-01-01T00:00:00Z', nsfw: false, artworkUrl: '' });
  await seedStorage(page, {
    'CapacitorStorage.liked': [track('l1', 'https://beta.cyberspace.online/someone/a-post'), track('l2', 'https://beta.cyberspace.online.evil.example/x'), track('l3', 'javascript:alert(1)')],
  });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  const rows = page.getByTestId('liked-list').getByTestId('track-row');
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await rows.nth(i).getByTestId('track-play').click();
    await openNowPlaying(page);
    await page.getByTestId('np-post').click();
    await page.getByTestId('np-close').click();
  }
  expect(await opened(page)).toEqual(['https://beta.cyberspace.online/someone/a-post']);
});

test('the CSP check catches a violation (self-test)', async ({ page, csp }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const img = document.createElement('img');
    img.src = 'https://not-allowed.example/x.png';
    document.body.appendChild(img);
  });
  await expect.poll(() => csp.length).toBeGreaterThan(0);
  expect(csp.join('\n')).toMatch(/img-src/);
  csp.length = 0; // expected here; the fixture fails a test that leaves any
});

test('Here on the Genres tab says the Jukebox could not load (with Retry), not "searching" forever', async ({ page, backend }) => {
  backend.offline = true;
  await page.goto('/');
  await page.context().setOffline(true);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('search-fab').click();
  await expect(page.getByTestId('here-loading')).toHaveCount(0);
  await expect(page.getByTestId('search').getByTestId('offline')).toBeVisible();
  await expect(page.getByTestId('search').getByTestId('retry')).toBeVisible();
  backend.offline = false;
  await page.context().setOffline(false);
  // Back online, Home's list (kept on screen while offline) loads again and may bring the
  // genres with it before Retry is needed; otherwise Retry loads them.
  const places = page.getByTestId('here-places').getByTestId('here-place').first();
  const retry = page.getByTestId('search').getByTestId('retry');
  // Retry may go (the genres came) between seeing it and tapping it: try again until they show.
  await expect(async () => {
    if (await retry.isVisible()) await retry.click({ timeout: 1000 });
    await expect(places).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(page.getByTestId('search').getByTestId('offline')).toHaveCount(0);
});
