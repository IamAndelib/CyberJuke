import { expect, test } from '../fixtures';
import { openSearch, openSettings, seedStorage, start, touchTap, waitForTracks, openLibrary } from '../helpers';

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
  await openLibrary(page, 'liked');
  await expect(page.getByTestId('liked-list').getByTestId('track-title')).toHaveText([title]);
  await page.reload();
  await openLibrary(page, 'liked');
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
  await openLibrary(page, 'liked');
  await page.getByTestId('liked-list').getByTestId('track-more').first().click();
  await expect(like).toHaveText('Unlike');
  await like.click();
  await expect(page.getByTestId('liked-list').getByTestId('track-title')).toHaveCount(0);
  await expect(page.getByTestId('liked-list')).toContainText('No liked songs yet');
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
  await openLibrary(page, 'recent');
  const labels = page.getByTestId('history-day-label');
  await expect(labels).toHaveCount(3);
  const texts = (await labels.allTextContents()).map((t) => t.replace(/\d+$/, '').trim());
  expect(texts[0]).toMatch(/^today$/i);
  expect(texts[1]).toMatch(/^yesterday$/i);
  expect(texts[2]).toMatch(/^(mon|tue|wed|thu|fri|sat|sun) \d{1,2} [a-z]{3}/i);
  await expect(page.getByTestId('history-day').nth(1).getByTestId('track-row')).toHaveCount(2);
  await expect(page.getByTestId('lib-recent').locator('.count')).toHaveText('3');
  // Clear counts what the tab counts (tracks), not the 4 plays behind them.
  await page.getByTestId('lib-clear').click();
  await expect(page.getByTestId('confirm-ok')).toHaveText('Clear 3 tracks');
  await page.getByTestId('confirm-cancel').click();

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
  await openLibrary(page, 'recent');
  await expect(page.getByTestId('history-day').first().getByTestId('track-title').first()).toHaveText(title);
});

test('with NSFW hidden, Liked and Recently played hide NSFW tracks too, and show them again once it is on', async ({ page }) => {
  const nsfw = { ...tr('n1', 'Seed NSFW'), nsfw: true };
  await seedStorage(page, {
    'CapacitorStorage.liked': [tr('s1', 'Seed Liked'), nsfw],
    'CapacitorStorage.history': [{ track: nsfw, playedAt: Date.now() - 1000 }, { track: tr('s2', 'Seed Played'), playedAt: Date.now() - 2000 }],
  });
  await page.goto('/');
  await openLibrary(page, 'liked');
  const titles = (list: string) => page.getByTestId(list).getByTestId('track-title');
  await expect(titles('liked-list')).toHaveText(['Seed Liked']);
  await expect(page.getByTestId('lib-liked').locator('.count')).toHaveText('1');
  await openLibrary(page, 'recent');
  await expect(titles('recent-list')).toHaveText(['Seed Played']);
  await expect(page.getByTestId('lib-recent').locator('.count')).toHaveText('1');
  // Kept, not dropped: on again, they're back.
  await openSettings(page);
  await page.getByTestId('nsfw-toggle').click();
  await page.getByTestId('tab-library').click();
  await expect(titles('recent-list')).toHaveText(['Seed NSFW', 'Seed Played']);
  await openLibrary(page, 'liked');
  await expect(titles('liked-list')).toHaveCount(2);
});

test('old untimed history is kept on upgrade', async ({ page }) => {
  await seedStorage(page, { 'CapacitorStorage.recent': [tr('o1', 'Old o1'), tr('o2', 'Old o2'), tr('o3', 'Old o3')] });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  await openLibrary(page, 'recent');
  await expect(page.getByTestId('recent-list').getByTestId('track-title')).toHaveText(['Old o1', 'Old o2', 'Old o3']);
  await expect(page.getByTestId('history-day-label')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('CapacitorStorage.recent'))).toBeNull();
});

test('Here: search from Library is scoped to Liked', async ({ page }) => {
  await start(page);
  const title = (await page.getByTestId('track-title').nth(2).textContent())!.trim();
  await page.getByTestId('track-more').nth(2).click();
  await page.getByTestId('menu-like').click();
  await openLibrary(page, 'liked');
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
  await openLibrary(page, 'recent');
  await page.getByTestId('recent-list').getByTestId('track-play').first().click();
  const q = await page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => { current: { title: string }; list: { title: string }[] } }).__cyberjukeQueue());
  expect([q.current.title, ...q.list.map((t) => t.title)]).toEqual(['Seed One', 'Seed Two', 'Seed Three']);
});

test('Library is a list of its lists: Liked and Recently played open on their own pages, and Back returns', async ({ page }) => {
  await seedStorage(page, {
    'CapacitorStorage.liked': [tr('s1', 'Seed Liked')],
    'CapacitorStorage.history': [{ track: tr('s2', 'Seed Played'), playedAt: Date.now() - 1000 }],
  });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  // Each row: its icon in an outlined tile, its name and count, a chevron.
  await expect(page.getByTestId('lib-liked')).toContainText('Liked');
  await expect(page.getByTestId('lib-liked')).toContainText('1 song');
  await expect(page.getByTestId('lib-recent')).toContainText('Recently played');
  await expect(page.getByTestId('liked-list')).toHaveCount(0);
  await page.getByTestId('lib-liked').click();
  await expect(page.getByTestId('screen-liked')).toBeVisible();
  await expect(page.getByTestId('liked-list').getByTestId('track-title')).toHaveText(['Seed Liked']);
  await page.getByTestId('liked-back').click();
  await expect(page.getByTestId('screen-library')).toBeVisible();
  await openLibrary(page, 'recent');
  await expect(page.getByTestId('recent-list').getByTestId('track-title')).toHaveText(['Seed Played']);
  await expect(page.getByTestId('lib-clear')).toBeVisible();
  // The Library tab again: back to its list.
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('screen-library')).toBeVisible();
});

// A row that moves as it becomes current (Preact 11 moves keyed rows with moveBefore()) kept its
// title's old colour in Chromium: the bar and badge showed, the accent title didn't.
test('a song played from Recently played moves to the top with its title in the accent colour', async ({ page }) => {
  await start(page);
  for (const i of [2, 1, 0]) {
    await page.getByTestId('track-play').nth(i).click();
    await expect(page.getByTestId('track-row').nth(i)).toHaveClass(/is-current/);
  }
  await openLibrary(page, 'recent');
  const rows = page.getByTestId('recent-list').getByTestId('track-row');
  await expect(rows).toHaveCount(3);
  const accent = await page.evaluate(() => {
    const el = document.body.appendChild(document.createElement('div'));
    el.style.color = 'var(--color-accent)';
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  });
  const title = (await rows.nth(2).getByTestId('track-title').textContent())!;
  await touchTap(page, rows.nth(2).getByTestId('track-play'));
  await expect(rows.first().getByTestId('track-title')).toHaveText(title);
  await expect(rows.first()).toHaveClass(/is-current/);
  await expect(rows.first().getByTestId('track-title')).toHaveCSS('color', accent);
  await expect(rows.nth(1).getByTestId('track-title')).not.toHaveCSS('color', accent);
});
