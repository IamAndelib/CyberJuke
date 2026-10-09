import { expect, test } from '../fixtures';
import { openSearch, seedStorage, start, waitForTracks } from '../helpers';

/** Library: Liked, Recently played by day, and the one-time move of history into a file. */

const HISTORY_FILE = 'cyberjuke.file:data/cyberjuke/history.json';

test('like from the track menu adds it to Library, and it survives a reload', async ({ page }) => {
  await start(page);
  const title = (await page.getByTestId('track-title').first().textContent())!.trim();
  await page.getByTestId('track-more').first().click();
  await expect(page.getByTestId('track-menu')).toBeVisible();
  await page.getByTestId('menu-like').click();
  await expect(page.getByTestId('toast').last()).toHaveText('Added to Liked songs');
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-liked').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-title')).toHaveText([title]);
  await page.reload();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-title')).toHaveText([title]);

  // Its ⋯ menu knows it is liked: Unlike (not Like), and that unlikes it.
  await page.getByTestId('liked-list').getByTestId('track-more').first().click();
  const like = page.getByTestId('menu-like');
  await expect(like).toHaveText('Unlike');
  // Another track's menu right after: Like.
  await page.getByTestId('track-menu').getByRole('button', { name: /cancel/i }).click();
  await page.getByTestId('tab-home').click();
  await page.getByTestId('track-more').nth(1).click();
  await expect(like).toHaveText('Like');
  await page.getByTestId('track-menu').getByRole('button', { name: /cancel/i }).click();
  await page.getByTestId('tab-library').click();
  await page.getByTestId('liked-list').getByTestId('track-more').first().click();
  await expect(like).toHaveText('Unlike');
  await like.click();
  await expect(page.getByTestId('liked-list').getByTestId('track-title')).toHaveCount(0);
});

const tr = (id: string, title: string) => ({
  id,
  ytId: 'abcdefghij' + id.slice(-1),
  title,
  artist: 'Seeded Artist',
  genre: 'test',
  by: 'someone',
  postTitle: '',
  postUrl: '',
  createdAt: '2026-01-01T00:00:00Z',
  nsfw: false,
  artworkUrl: '',
});

test('history saved by older versions moves into a file once, grouped by day; new plays land in Today', async ({ page }) => {
  const D = 86_400_000;
  const at = (daysAgo: number) => {
    const d = new Date(Date.now() - daysAgo * D);
    d.setHours(12, 0, 0, 0);
    return Math.min(Date.now(), d.getTime());
  };
  await seedStorage(page, {
    'CapacitorStorage.history': [
      { track: tr('s1', 'Seed Today'), playedAt: at(0) },
      { track: tr('s2', 'Seed Yesterday'), playedAt: at(1) },
      { track: tr('s1', 'Seed Today'), playedAt: at(1) - 1000 },
      { track: tr('s3', 'Seed Three Days'), playedAt: at(3) },
    ],
  });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  const labels = page.getByTestId('history-day-label');
  await expect(labels).toHaveCount(3);
  const texts = (await labels.allTextContents()).map((t) => t.replace(/\d+$/, '').trim());
  expect(texts[0]).toMatch(/^today$/i);
  expect(texts[1]).toMatch(/^yesterday$/i);
  expect(texts[2]).toMatch(/^(mon|tue|wed|thu|fri|sat|sun) \d{1,2} [a-z]{3}/i);
  await expect(page.getByTestId('history-day').nth(1).getByTestId('track-row')).toHaveCount(2);
  await expect(page.getByTestId('lib-recent').locator('.count')).toHaveText('3');

  // Migrated: the old key is gone; the file holds each track once.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('CapacitorStorage.history'))).toBeNull();
  const saved = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), HISTORY_FILE))!);
  expect(saved.v).toBe(2);
  expect(saved.plays).toHaveLength(4);
  expect(Object.keys(saved.tracks).sort()).toEqual(['s1', 's2', 's3']);

  // A new play lands at the top of Today, and is still there after a reload.
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  const title = (await page.getByTestId('track-title').first().textContent())!.trim();
  await page.getByTestId('track-play').first().click();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('history-day').first().getByTestId('track-title').first()).toHaveText(title);
  await page.reload();
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('history-day').first().getByTestId('track-title').first()).toHaveText(title);
});

test('old untimed history is kept on upgrade', async ({ page }) => {
  await seedStorage(page, { 'CapacitorStorage.recent': [tr('o1', 'Old o1'), tr('o2', 'Old o2'), tr('o3', 'Old o3')] });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('recent-list').getByTestId('track-title')).toHaveText(['Old o1', 'Old o2', 'Old o3']);
  await expect(page.getByTestId('history-day-label')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('CapacitorStorage.recent'))).toBeNull();
});

test('Here: search from Library is scoped to Liked', async ({ page }) => {
  await start(page);
  const title = (await page.getByTestId('track-title').nth(2).textContent())!.trim();
  await page.getByTestId('track-more').nth(2).click();
  await page.getByTestId('menu-like').click();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-row')).toHaveCount(1);
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'Search in Liked');
  await expect(page.getByTestId('here-list').getByTestId('track-title')).toHaveText([title]);
  await page.getByTestId('search-input').fill('qzxv nebulon');
  await expect(page.getByTestId('here-empty')).toBeVisible();
  await page.getByTestId('here-bridge').click();
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
});

test('a Recently played row plays the history with each track once', async ({ page }) => {
  const D = 24 * 60 * 60 * 1000;
  const noon = (daysAgo: number) => {
    const d = new Date(Date.now() - daysAgo * D);
    d.setHours(12, 0, 0, 0);
    return Math.min(Date.now() - 1000, d.getTime());
  };
  await seedStorage(page, {
    'CapacitorStorage.history': [
      { track: tr('s1', 'Seed One'), playedAt: noon(0) },
      { track: tr('s2', 'Seed Two'), playedAt: noon(1) },
      { track: tr('s1', 'Seed One'), playedAt: noon(1) - 1000 },
      { track: tr('s3', 'Seed Three'), playedAt: noon(1) - 2000 },
    ],
  });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  await page.getByTestId('recent-list').getByTestId('track-play').first().click();
  const q = await page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => { current: { title: string }; list: { title: string }[] } }).__cyberjukeQueue());
  expect([q.current.title, ...q.list.map((t) => t.title)]).toEqual(['Seed One', 'Seed Two', 'Seed Three']);
});
