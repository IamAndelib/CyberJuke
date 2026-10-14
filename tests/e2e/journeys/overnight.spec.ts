import type { Page } from '@playwright/test';
import { expect, test } from '../../fixtures';
import { clockStart, isFeedQuery, openNowPlaying, playOn, recordToasts, seedStorage, toastsSeen, tracksEndedIn } from '../../helpers';
import { UP_NEXT_MAX } from '../../../src/core/guards';

/**
 * A night of music from Liked: sixty liked songs (about three hours), then autoplay carries
 * on, while the app keeps its hourly habits (the new-tracks check). Four hours pass on the
 * faked clock, a track at a time (playOn). Nothing must pile up: no message, a history pruned
 * by its rules (the plays before the last three days are capped), a Library and an Up next
 * that render a bounded number of rows however long the lists.
 */

const GENRES = ['synthwave', 'ambient', 'lo-fi', 'house', 'shoegaze', 'city pop'];
const ARTISTS = ['Neon Owls', 'Mira Vale', 'The Velvet Tapes', 'Kenji Tanaka', 'Static Rivers'];
/** A seeded track with an 11-character video id of its own. */
const track = (n: number, prefix: string) => ({
  id: `${prefix}${n}`,
  ytId: `${prefix}${String(n).padStart(11 - prefix.length, '0')}`,
  title: `${prefix === 'liked' ? 'Liked' : 'Old play'} ${n}`,
  artist: ARTISTS[n % ARTISTS.length],
  genre: GENRES[n % GENRES.length],
  by: 'nightowl',
  postTitle: '',
  postUrl: '',
  createdAt: '2026-01-01T00:00:00Z',
  nsfw: false,
  artworkUrl: '',
});
const LIKED = Array.from({ length: 60 }, (_, i) => track(i, 'liked'));
const DAY = 86_400_000;
/** 150 plays from four to ten days ago: the rule keeps the latest 100 of those before the last three days. */
const OLD_PLAYS = Array.from({ length: 150 }, (_, i) => ({ track: track(i, 'old'), playedAt: Date.now() - 4 * DAY - i * (6 * DAY) / 150 }));
const OLD_KEPT = 100;

const queueState = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => { current: { title: string } | null; autoplay: unknown[]; list: unknown[] } }).__cyberjukeQueue());

test('four hours of Liked, then autoplay: no message, the history pruned, the lists rendered in chunks', async ({ page, backend }) => {
  await seedStorage(page, { 'CapacitorStorage.liked': LIKED, 'CapacitorStorage.history': OLD_PLAYS });
  await clockStart(page);
  await page.goto('/');
  await recordToasts(page);
  await page.getByTestId('tab-library').click();
  const likedRows = page.getByTestId('liked-list').getByTestId('track-row');
  await expect(likedRows).toHaveCount(60);
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('lib-recent')).toContainText(String(OLD_KEPT));
  await page.getByTestId('lib-liked').click();
  await page.getByTestId('lib-play-all').click();
  await expect(page.getByTestId('mini-title')).toHaveText('Liked 0');
  // Up next shows the first UP_NEXT_MAX of what is to come, however long the queue (59 of the
  // list alone, and the autoplay picks behind them).
  await expect.poll(async () => (await queueState(page)).list.length).toBe(UP_NEXT_MAX);
  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-row')).toHaveCount(UP_NEXT_MAX);
  await page.getByTestId('np-close').click();
  const queriesBefore = backend.queries.length;

  // The night, in four hours.
  const HOURS = 4;
  for (let h = 1; h <= HOURS; h++) {
    await playOn(page, 60 * 60_000);
    await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
    expect(await toastsSeen(page), `messages in hour ${h}`).toEqual([]);
  }
  // The list ran out after about three hours; autoplay took over and refilled itself.
  const q = await queueState(page);
  expect(q.current?.title).not.toMatch(/^Liked /);
  expect(q.list).toEqual([]);
  expect(q.autoplay.length).toBeGreaterThanOrEqual(15);
  // Only the new-tracks check asked Cyberspace for anything overnight (about every 15 minutes;
  // a check still out when the clock jumps on runs into its timeout and waits for the next): no feed, no catalog.
  const overnight = backend.queries.slice(queriesBefore);
  expect(overnight.length).toBeGreaterThanOrEqual(HOURS * 3);
  expect(overnight.length).toBeLessThanOrEqual(HOURS * 4 + 1);
  expect(overnight.every((x) => x.limit === 25)).toBe(true);
  expect(overnight.some((x) => isFeedQuery(x) || x.limit === 300)).toBe(false);

  // Recently played: the night's plays (each track once) on top of the 100 old ones kept, rendered 60 rows at a time.
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  const count = Number(/(\d+)/.exec((await page.getByTestId('lib-recent').textContent())!)![1]);
  const tracksPlayed = HOURS * tracksEndedIn(60 * 60_000) + 1;
  expect(count).toBe(OLD_KEPT + tracksPlayed);
  const recentRows = page.getByTestId('recent-list').getByTestId('track-row');
  await expect(recentRows.first()).toBeVisible();
  expect(await recentRows.count()).toBeLessThanOrEqual(60);
  expect(await toastsSeen(page)).toEqual([]);
});
