import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { bufferedAhead, openNowPlaying, openSettings, playAndOpen, playerCalls, recordToasts, seedStorage, setOffline, start, toastsSeen } from '../helpers';

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
  // A screen reader hears it go offline: the status region is there, empty, before the text comes.
  const region = page.getByTestId('offline-banner-status');
  await expect(region).toHaveAttribute('role', 'status');
  await expect(region).toHaveText('');
  await region.evaluate((el) => ((window as unknown as { __region: Element }).__region = el));
  await setOffline(page, backend, true);
  await expect(region).toHaveText(BANNER_LIKED);
  expect(await region.evaluate((el) => el === (window as unknown as { __region: Element }).__region)).toBe(true);

  // The banner opens Liked, a full-size target.
  const banner = page.getByTestId('offline-banner');
  await expect(banner).toHaveText(BANNER_LIKED);
  expect((await page.getByTestId('offline-banner-liked').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('offline-banner-liked').click();
  await expect(page.getByTestId('screen-library')).toBeVisible();
  await expect(page.getByTestId('lib-liked')).toHaveAttribute('aria-selected', 'true');

  // Elsewhere, playing what isn't saved is refused, pointing to Liked (Home's Shuffle plays them).
  await page.getByTestId('lib-recent').click();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('shuffle-all')).toContainText('Shuffle liked songs');
  await page.getByTestId('screen-home').locator('.row.off').first().getByTestId('track-play').click({ force: true });
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

test('with nothing playing, Add to queue says "Playing" when it starts the song; offline, unsaved, only why it was refused', async ({ page, backend }) => {
  await start(page);
  await setOffline(page, backend, true);
  await recordToasts(page);
  await page.getByTestId('track-more').first().click();
  await page.getByTestId('menu-add-queue').click();
  await expect(page.getByTestId('toast')).toHaveText(TAP);
  expect(await toastsSeen(page)).toEqual([TAP]);
  expect(await queues(page)).toEqual([]);
  // Online, the same tap starts it and says so.
  await setOffline(page, backend, false);
  await page.getByTestId('track-more').first().click();
  await page.getByTestId('menu-add-queue').click();
  await expect(page.getByTestId('toast')).toHaveText('Playing');
  await expect(page.getByTestId('mini-player')).toBeVisible();
});

test('offline, the track the app reopened on is dimmed and asks to connect unless saved; with audio loaded it plays', async ({ page, backend }) => {
  await seedStorage(page, { 'CapacitorStorage.liked': LIKED });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  const rows = page.getByTestId('liked-list').getByTestId('track-row');
  await expect(rows).toHaveCount(3);
  await saved(page, ['abcdefghij1']);
  const toggle = page.getByTestId('mini-toggle');
  const toast = page.getByTestId('toast');

  // Track l2 (liked, not saved) is current and paused with nothing loaded, as after a restart.
  await rows.nth(1).getByTestId('track-play').click();
  await expect(toggle).toHaveAttribute('aria-label', 'Pause');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
  await bufferedAhead(page, 0);
  await setOffline(page, backend, true);

  // Its row is dimmed like any unsaved song, and Play (mini player or its row) says why.
  const current = rows.nth(1);
  await expect(current).toHaveClass(/\bis-current\b/);
  await expect(current).toHaveClass(/\boff\b/);
  await expect(current.getByTestId('track-play')).toHaveAttribute('aria-disabled', 'true');
  await toggle.click();
  await expect(toast).toHaveText(NOT_SAVED);
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
  // Any other tap clears the message first (past the row's double-tap window, too).
  await page.getByTestId('lib-liked').click();
  await expect(toast).toHaveCount(0);
  await page.waitForTimeout(500);
  await current.getByTestId('track-play').click({ force: true });
  await expect(toast).toHaveText(NOT_SAVED);
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
  await expect(page.getByTestId('mini-title')).toHaveText('Track l2');

  // With audio loaded ahead (paused mid-song), it is bright and resumes.
  await bufferedAhead(page, 30_000);
  await expect(current).not.toHaveClass(/\boff\b/);
  await expect(current.getByTestId('track-play')).not.toHaveAttribute('aria-disabled');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Pause');
  await expect(page.getByTestId('mini-title')).toHaveText('Track l2');

  // A saved track the app reopened on plays from the phone, nothing loaded or not.
  await rows.nth(0).getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText('Track l1');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
  await bufferedAhead(page, 0);
  await expect(rows.nth(0)).not.toHaveClass(/\boff\b/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Pause');
});

test('offline, Now Playing says so too: with liked songs saved its line opens Liked; with none it asks to connect', async ({ page, backend }) => {
  await seedStorage(page, { 'CapacitorStorage.liked': LIKED });
  await start(page);
  await playAndOpen(page);
  // Online: no line.
  await expect(page.getByTestId('np-offline')).toHaveCount(0);

  // Offline with nothing saved: it asks to connect (the bar at the top is covered by the sheet).
  await setOffline(page, backend, true);
  const line = page.getByTestId('np-offline');
  await expect(line).toHaveText(BANNER);
  await expect(page.getByTestId('np-offline-status')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('np-offline-status')).toHaveText(BANNER);
  await expect(page.getByTestId('np-offline-liked')).toHaveCount(0);
  // A bar across the top of Now Playing, as the app's own: full width, above the header, clear of its buttons.
  const sheet = (await page.getByTestId('now-playing').boundingBox())!;
  const box = (await line.boundingBox())!;
  const close = (await page.getByTestId('np-close').boundingBox())!;
  const more = (await page.getByTestId('np-more').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(sheet.width - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(Math.min(close.y, more.y));

  // With a liked song saved: they still play, and a tap closes the sheet and opens Liked.
  await saved(page, ['abcdefghij2']);
  await expect(page.getByTestId('np-offline-liked')).toHaveText(BANNER_LIKED);
  // Its whole height is the target.
  expect((await page.getByTestId('np-offline-liked').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('np-offline-liked').click();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  await expect(page.getByTestId('screen-library')).toBeVisible();
  await expect(page.getByTestId('lib-liked')).toHaveAttribute('aria-selected', 'true');

  // Back online: gone.
  await openNowPlaying(page);
  await expect(page.getByTestId('np-offline-liked')).toBeVisible();
  await setOffline(page, backend, false);
  await expect(page.getByTestId('np-offline')).toHaveCount(0);
});

test('Settings → Listening cache: 256 MB by default, three sizes sent to the player and kept, Clear cache, and Download using mobile data', async ({ page }) => {
  await page.goto('/');
  const sent = async () => (await playerCalls(page)).filter((c) => c[0] === 'setCacheLimit').map((c) => c[1]);
  await expect.poll(sent).toEqual([{ mb: 256 }]);
  await openSettings(page);
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

  // Clear cache asks first: it takes the saved liked songs too. Cancel leaves it be.
  const clears = async () => (await playerCalls(page)).filter((c) => c[0] === 'clearCache').length;
  await page.getByTestId('cache-clear').click();
  const sheet = page.getByTestId('confirm-sheet');
  await expect(sheet).toContainText('Clear the listening cache?');
  await expect(page.getByTestId('confirm-ok')).toHaveText('Clear cache');
  await page.getByTestId('confirm-cancel').click();
  await expect(sheet).toBeHidden();
  expect(await clears()).toBe(0);
  await page.getByTestId('cache-clear').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('toast')).toHaveText('Cache cleared. Liked songs are saved again on Wi-Fi.');
  expect(await clears()).toBe(1);

  await page.reload();
  await expect.poll(sent).toEqual([{ mb: 128 }]);
  await openSettings(page);
  await expect(page.getByTestId('cache-128')).toHaveAttribute('aria-checked', 'true');

  // Download using mobile data: off by default (liked songs are saved on Wi-Fi only), sent to
  // the player, and kept. On, Clear cache no longer says "on Wi-Fi".
  const mobileData = async () => (await playerCalls(page)).filter((c) => c[0] === 'setDownloadOnMobileData').map((c) => c[1]);
  const toggle = page.getByTestId('mobile-data-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toHaveAccessibleName('Download using mobile data');
  await expect(toggle).toHaveAccessibleDescription('Saves liked songs on mobile data too.');
  await expect.poll(mobileData).toEqual([{ enabled: false }]);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(mobileData).toEqual([{ enabled: false }, { enabled: true }]);
  await page.getByTestId('cache-clear').click();
  await expect(sheet).toContainText('saved liked songs too. They are saved again.');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('toast')).toHaveText('Cache cleared. Liked songs are saved again.');
  await page.reload();
  await expect.poll(mobileData).toEqual([{ enabled: true }]);
});
