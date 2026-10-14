import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { playerCalls, seedStorage, setOffline, start } from '../helpers';

/**
 * The listening cache (native): liked songs saved on the phone play offline, from any list,
 * nothing else does, and Settings sets its size. The browser has no cache: the test hook says which liked
 * songs native would report as saved.
 */

const track = (id: string) => ({ id, ytId: 'abcdefghij' + id.slice(-1), title: 'Track ' + id, artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '2026-01-01T00:00:00Z', nsfw: false, artworkUrl: '' });
const LIKED = [track('l1'), track('l2'), track('l3')];

/** What native reports as saved whole (by ytId). */
const saved = (page: Page, ytIds: string[]) => page.evaluate((ids) => (window as unknown as { __cyberjukeCache: { saved(ids: string[]): void } }).__cyberjukeCache.saved(ids), ytIds);

const BANNER = '[ offline ] no carrier · connect to play';
const BANNER_LIKED = '[ offline ] no carrier · your liked songs still play';
const TAP = 'No carrier. Connect to play.';
const TAP_LIKED = 'No carrier. Your liked songs still play.';
const NOT_SAVED = 'Not saved yet. Needs a connection.';

const queues = async (page: Page) => (await playerCalls(page)).filter((c) => c[0] === 'setQueue').map((c) => c[1] as { n: number; context: { label: string } });

test('offline, any list plays its saved songs from the tapped one; unsaved rows are dimmed and say so', async ({ page, backend }) => {
  await seedStorage(page, { 'CapacitorStorage.liked': LIKED });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  const rows = page.getByTestId('liked-list').getByTestId('track-row');
  await expect(rows).toHaveCount(3);
  // Liked is sent to native, newest like first; starting signed out, at once again before
  // signedOut (native drops any members-only audio).
  const cacheCalls = async () => (await playerCalls(page)).filter((c) => c[0] === 'setLikedIds' || c[0] === 'signedOut');
  const likedIds = ['abcdefghij1', 'abcdefghij2', 'abcdefghij3'];
  await expect.poll(cacheCalls).toEqual([['setLikedIds', likedIds], ['setLikedIds', likedIds], ['signedOut']]);
  await saved(page, ['abcdefghij1', 'abcdefghij3']);

  await setOffline(page, backend, true);
  await expect(page.getByTestId('offline-banner')).toHaveText(BANNER_LIKED);
  await expect(rows.nth(0).getByTestId('track-play')).not.toHaveAttribute('aria-disabled');
  await expect(rows.nth(2).getByTestId('track-play')).not.toHaveAttribute('aria-disabled');
  await expect(rows.nth(1).getByTestId('track-play')).toHaveAttribute('aria-disabled', 'true');
  await expect(rows.nth(1)).toHaveClass(/\boff\b/);

  // Not saved: says so, nothing starts.
  await rows.nth(1).getByTestId('track-play').click({ force: true });
  await expect(page.getByTestId('toast')).toHaveText(NOT_SAVED);
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
  expect(await queues(page)).toHaveLength(0);

  // Saved: the saved ones play, from the tapped one.
  await rows.nth(2).getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText('Track l3');
  await expect.poll(() => queues(page)).toEqual([{ n: 2, context: { label: 'Liked', mode: 'list' } }]);

  // Play: the saved ones, in order.
  await page.getByTestId('lib-play-all').click();
  await expect(page.getByTestId('mini-title')).toHaveText('Track l1');
  await expect.poll(async () => (await queues(page)).at(-1)).toEqual({ n: 2, context: { label: 'Liked', mode: 'list' } });

  // Recently played follows the same rule: a saved liked song is bright there and plays, and
  // Play plays the saved ones.
  await page.getByTestId('lib-recent').click();
  const recent = page.getByTestId('recent-list').getByTestId('track-row');
  await expect(recent).toHaveCount(2);
  for (const play of await recent.getByTestId('track-play').all()) await expect(play).not.toHaveAttribute('aria-disabled');
  const l3 = recent.filter({ hasText: 'Track l3' });
  await expect(l3).not.toHaveClass(/\boff\b/);
  // Past the double-tap window since Track l3 was tapped in Liked (it would be ignored).
  await page.waitForTimeout(500);
  await l3.getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText('Track l3');
  await expect.poll(async () => (await queues(page)).at(-1)).toEqual({ n: 2, context: { label: 'Recently played', mode: 'list' } });
  await page.getByTestId('lib-play-all').click();
  await expect(page.getByTestId('mini-title')).toHaveText('Track l3');
  await expect.poll(async () => (await queues(page)).length).toBe(4);

  // Back online: every row plays again.
  await setOffline(page, backend, false);
  await page.getByTestId('lib-liked').click();
  for (const play of await rows.getByTestId('track-play').all()) await expect(play).not.toHaveAttribute('aria-disabled');
});

test('offline with liked songs saved, the banner and the refusal toast open Liked; with none, they ask to connect', async ({ page, backend }) => {
  await seedStorage(page, { 'CapacitorStorage.liked': LIKED });
  await start(page);
  await saved(page, ['abcdefghij2']);
  await setOffline(page, backend, true);

  // The banner opens Liked.
  const banner = page.getByTestId('offline-banner');
  await expect(banner).toHaveText(BANNER_LIKED);
  await page.getByTestId('offline-banner-liked').click();
  await expect(page.getByTestId('screen-library')).toBeVisible();
  await expect(page.getByTestId('lib-liked')).toHaveAttribute('aria-selected', 'true');

  // Elsewhere, playing is refused, pointing to Liked.
  await page.getByTestId('lib-recent').click();
  await page.getByTestId('tab-home').click();
  await page.getByTestId('shuffle-all').click();
  await expect(page.getByTestId('toast')).toContainText(TAP_LIKED);
  await page.getByTestId('toast-action').click();
  await expect(page.getByTestId('screen-library')).toBeVisible();
  await expect(page.getByTestId('lib-liked')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('liked-list').getByTestId('track-row')).toHaveCount(3);

  // Nothing saved (yet): back to asking for a connection.
  await saved(page, []);
  await expect(banner).toHaveText(BANNER);
  await expect(page.getByTestId('offline-banner-liked')).toHaveCount(0);
  await page.getByTestId('tab-home').click();
  await page.getByTestId('shuffle-all').click();
  await expect(page.getByTestId('toast')).toHaveText(TAP);
  await expect(page.getByTestId('toast-action')).toHaveCount(0);
});

test('Settings → Listening cache: 256 MB by default, three sizes sent to the player and kept, and Clear cache', async ({ page }) => {
  await page.goto('/');
  const sent = async () => (await playerCalls(page)).filter((c) => c[0] === 'setCacheLimit').map((c) => c[1]);
  await expect.poll(sent).toEqual([{ mb: 256 }]);
  await page.getByTestId('tab-settings').click();
  const setting = page.getByTestId('listening-cache');
  await expect(setting).toContainText('Listening cache');
  await expect(setting).toContainText('Keeps music playing when the signal drops.');
  // How much is in use is never shown.
  await expect(setting).not.toContainText(/in use/i);
  const group = page.getByRole('radiogroup', { name: 'Listening cache' });
  await expect(group.getByRole('radio')).toHaveText(['128 MB', '256 MB', '512 MB']);
  await expect(page.getByTestId('cache-256')).toHaveAttribute('aria-checked', 'true');
  // One Tab stop; the arrow keys move the choice.
  await page.getByTestId('cache-256').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('cache-512')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('cache-512')).toBeFocused();
  await page.getByTestId('cache-128').click();
  await expect(page.getByTestId('cache-128')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(sent).toEqual([{ mb: 256 }, { mb: 512 }, { mb: 128 }]);

  await page.getByTestId('cache-clear').click();
  await expect(page.getByTestId('toast')).toHaveText('Cache cleared. Liked songs are saved again on Wi-Fi.');
  expect((await playerCalls(page)).filter((c) => c[0] === 'clearCache')).toHaveLength(1);

  await page.reload();
  await expect.poll(sent).toEqual([{ mb: 128 }]);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('cache-128')).toHaveAttribute('aria-checked', 'true');
});
