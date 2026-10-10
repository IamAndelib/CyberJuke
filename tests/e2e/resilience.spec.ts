import { expect, test } from '../fixtures';
import type { Page } from '@playwright/test';
import { opened, openNowPlaying, playerCalls, recordOpens, seedStorage, start, waitForTracks } from '../helpers';

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
