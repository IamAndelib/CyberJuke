import { expect, test } from '../../fixtures';
import { clockStart, fakeYt, openNowPlaying, openSearch, playerCalls, recordToasts, runFor, toastsSeen } from '../../helpers';

/**
 * An evening with an album from Global: found, played from the top, and left alone. Each track
 * ends by itself (the fake player's clock, run forward), the next one follows; one of them has
 * gone from YouTube and is skipped with a word. The evening's listening lands in Recently
 * played. The list is sent to the player once, and so are the player settings.
 */

/** One track of the fake player, from its start (71 s in) to its end (247 s), plus its start-up. */
const TRACK_MS = 177_000;

test('an album plays through by itself, one track skipped: Up next shrinks, Recently played fills, the list and the settings are sent once', async ({ page }) => {
  await clockStart(page);
  await page.goto('/');
  await recordToasts(page);
  await openSearch(page);
  await page.getByTestId('search-input').fill('Night Owl');
  await page.getByTestId('mode-global').click();
  await page.getByTestId('filter-albums').click();
  await page.getByTestId('music-open').first().click();
  const album = page.getByTestId('screen-album');
  await expect(album.getByTestId('track-row')).toHaveCount(8);
  const titles = (await album.getByTestId('track-title').allTextContents()).map((s) => s.trim());
  await album.getByTestId('album-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(titles[0]);

  await openNowPlaying(page);
  const listRows = page.locator('[data-testid="upnext-row"][data-section="list"]');
  await expect(listRows).toHaveCount(7);
  await expect(page.getByTestId('upnext-list-label')).toContainText('Next from:');
  await page.getByTestId('np-close').click();
  // Left alone (the screen off), each track ends by itself; a look at Now Playing between two.
  // The second track is gone from YouTube: the player says so once and moves on.
  for (let i = 1; i <= 3; i++) {
    if (i === 2) await fakeYt(page, 'error', 150);
    else await runFor(page, TRACK_MS);
    await expect(page.getByTestId('mini-title')).toHaveText(titles[i]);
    await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
    await openNowPlaying(page);
    await expect(page.getByTestId('np-title')).toHaveText(titles[i]);
    await expect(listRows).toHaveCount(7 - i);
    await page.getByTestId('np-close').click();
  }
  expect(await toastsSeen(page)).toEqual([`Skipped "${titles[1]}": unavailable`]);

  // Recently played: the four tracks heard, newest first.
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('recent-list').getByTestId('track-title')).toHaveText([titles[3], titles[2], titles[1], titles[0]]);

  const calls = await playerCalls(page);
  expect(calls.filter((c) => c[0] === 'setQueue')).toEqual([['setQueue', { n: 8, context: { label: expect.any(String), mode: 'list' } }]]);
  expect(calls.filter((c) => c[0] === 'setGapless')).toEqual([['setGapless', { enabled: true }]]);
  expect(calls.filter((c) => c[0] === 'setCrossfade')).toEqual([['setCrossfade', { ms: 0 }]]);
});
