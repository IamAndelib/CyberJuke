import { expect, test } from '../fixtures';
import type { Page } from '@playwright/test';
import { expectStable, opened, openNowPlaying, openSearch, playerCalls, recordOpens, seedStorage, start, waitForTracks } from '../helpers';

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

/** The device loses (or gets back) its connection: the browser's and the stub backend's. */
async function setOffline(page: Page, backend: { offline: boolean }, off: boolean): Promise<void> {
  backend.offline = off;
  await page.context().setOffline(off);
}

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

test('offline, lists that only lead to music ask to connect, and come back by themselves', async ({ page, backend }) => {
  await start(page);
  await setOffline(page, backend, true);
  await expect(page.getByTestId('offline-banner')).toHaveText(BANNER);

  // Home: Latest and Most saved; the Shuffle hero and the genre chips stay.
  const home = page.getByTestId('screen-home');
  await expect(home.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(home.getByTestId('track-row')).toHaveCount(0);
  await expect(home.getByTestId('shuffle-all')).toBeVisible();
  await expect(home.getByTestId('genre-chips')).toBeVisible();
  await page.getByTestId('sort-saved').click();
  await expect(home.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(home.getByTestId('track-row')).toHaveCount(0);
  await page.getByTestId('sort-latest').click();
  // Redial while still offline: still no carrier.
  await home.getByTestId('retry').click();
  await expect(home.getByTestId('retry')).toHaveAttribute('aria-busy', 'false');
  await expect(home.getByTestId('offline')).toBeVisible();

  // The Genres and Artists grids.
  await page.getByTestId('tab-genres').click();
  const genres = page.getByTestId('screen-genres');
  await expect(genres.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(genres.getByTestId('genre-tile')).toHaveCount(0);
  await page.getByTestId('tab-artists').click();
  const artists = page.getByTestId('screen-artists');
  await expect(artists.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(artists.getByTestId('artist-tile')).toHaveCount(0);

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
  await page.getByTestId('tab-genres').click();
  await expect(genres.getByTestId('genre-tile').first()).toBeVisible();
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  await expect(home.getByTestId('offline')).toHaveCount(0);
});

test('offline, an open genre page and artist page ask to connect, then show their rows again', async ({ page, backend }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').first().click();
  const genre = page.getByTestId('screen-genre');
  await expect(genre.getByTestId('track-row').first()).toBeVisible();
  await setOffline(page, backend, true);
  await expect(genre.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(genre.getByTestId('track-row')).toHaveCount(0);
  await expect(genre.getByTestId('genre-play-all')).toHaveCount(0);
  await setOffline(page, backend, false);
  await expect(genre.getByTestId('track-row').first()).toBeVisible();

  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  const artist = page.getByTestId('screen-artist');
  await expect(artist.getByTestId('artist-jukebox')).toBeVisible();
  await setOffline(page, backend, true);
  await expect(artist.getByTestId('offline')).toHaveText(NO_CARRIER);
  await expect(artist.getByTestId('artist-jukebox')).toHaveCount(0);
  await setOffline(page, backend, false);
  await expect(artist.getByTestId('artist-jukebox')).toBeVisible();
});

test('offline, Shuffle and Play say to connect and leave the player as it was', async ({ page, backend }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  const toggle = page.getByTestId('mini-toggle');
  await expect(toggle).toHaveAttribute('aria-label', 'Pause');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
  const title = await page.getByTestId('mini-title').textContent();
  const queued = (await playerCalls(page)).filter((c) => c[0] === 'setQueue').length;

  await setOffline(page, backend, true);
  await toggle.click();
  await expect(page.getByTestId('toast')).toHaveText(TAP_TOAST);
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
  backend.offline = false;
  await page.context().setOffline(false);
  await page.getByTestId('search').getByTestId('retry').click();
  await expect(page.getByTestId('here-places').getByTestId('here-place').first()).toBeVisible();
});
