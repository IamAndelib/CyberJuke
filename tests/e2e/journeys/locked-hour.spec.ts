import { expect, test } from '../../fixtures';
import { clockStart, isFeedQuery, playOn, recordToasts, runFor, setVisibility, start, toastsSeen, waitForTracks } from '../../helpers';

/**
 * An hour with the phone in the pocket, screen locked, music on. In the background the app
 * asks Cyberspace for nothing; back in the foreground it catches up once: the new-tracks
 * check, the catalog's hourly refresh, and the one list that had failed before the screen
 * went dark. The hour passes on the faked clock, a track at a time (playOn).
 */

test('an hour locked: nothing is asked in the background; on return one check, one catalog refresh, the failed list once', async ({ page, backend }) => {
  await clockStart(page);
  await start(page);
  await recordToasts(page);
  const title = (await page.getByTestId('track-title').first().textContent())!.trim();
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);
  // A genre page that failed just before (both tries lost in a handover): it shows no carrier.
  const home = page.getByTestId('screen-home');
  backend.failNext = 2;
  await page.getByTestId('genre-chip').nth(1).click();
  await expect(home.getByTestId('offline')).toBeVisible();
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  const asked = backend.queries.length;

  // Screen locked, an hour passes.
  await setVisibility(page, 'hidden');
  await playOn(page, 61 * 60_000);
  expect(backend.queries.length, 'requests while in the background').toBe(asked);
  // The music played on, through about twenty tracks.
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  await expect(page.getByTestId('mini-title')).not.toHaveText(title);

  // Unlocked: the app catches up, once each.
  await setVisibility(page, 'visible');
  await waitForTracks(page);
  await expect(home.getByTestId('offline')).toHaveCount(0);
  const limits = () => backend.queries.slice(asked).map((q) => q.limit ?? 0).sort((a, b) => a - b);
  await expect.poll(limits).toEqual([24, 25, 300]);
  const since = backend.queries.slice(asked);
  expect(since.filter(isFeedQuery)).toHaveLength(1);
  // The catalog's refresh asks only for posts newer than the newest it has.
  expect(JSON.stringify(since.find((q) => q.limit === 300)!.where)).toContain('GREATER_THAN');
  // And then nothing more for a while.
  await runFor(page, 10_000);
  expect(limits()).toEqual([24, 25, 300]);
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  const count = Number(/(\d+)/.exec((await page.getByTestId('lib-recent').textContent())!)![1]);
  expect(count).toBeGreaterThanOrEqual(20);
  expect(await toastsSeen(page)).toEqual([]);
});
