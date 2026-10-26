import type { Page } from '@playwright/test';
import { expect, test, FAKE_MP3_SECONDS, MP3_POSTS, coverUrl } from '../fixtures';
import { expectStable, musicCalls, openNowPlaying, openSearch, playerCalls, setOffline, start } from '../helpers';

/** Jukebox MP3s (Cyberspace 4.0): posts whose audio is a latex.gg MP3 with a cover. */

test.use({ backendOptions: { mp3: true } });

const [first, second] = MP3_POSTS;
const postUrl = (p: (typeof MP3_POSTS)[number]) => `https://beta.cyberspace.online/${p.by}/${p.id.toLowerCase()}`;

async function findInSearch(page: Page, title: string) {
  await openSearch(page);
  await page.getByTestId('search-input').fill(title);
  const row = page.getByTestId('search-results').getByTestId('track-row').filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  return row;
}

async function menu(page: Page, row: ReturnType<Page['getByTestId']>, item: string) {
  await row.getByTestId('track-more').click();
  await page.getByTestId(item).click();
}

test('an MP3 post shows its cover, plays to its end, and the next MP3 follows', async ({ page }) => {
  await start(page);
  const row = await findInSearch(page, first.title);
  await expect(row.locator('img')).toHaveAttribute('src', coverUrl(first.file));
  // The cover is shown whole (square), not cropped like a video frame.
  await expect(row.locator('.art')).toHaveClass(/art-cover/);
  await row.getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(first.title);
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  // Paused while the second MP3 is queued next (the first is only seconds long).
  await page.getByTestId('mini-toggle').click();
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Play');
  await page.getByTestId('search-input').fill(second.title);
  await menu(page, page.getByTestId('search-results').getByTestId('track-row').filter({ hasText: second.title }).first(), 'menu-add-queue');
  // Played on: when the first ends by itself (the audio really played), the second starts.
  await page.getByTestId('mini-toggle').click();
  await expect(page.getByTestId('mini-title')).toHaveText(second.title, { timeout: (FAKE_MP3_SECONDS + 8) * 1000 });
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
});

test('an MP3 can be liked and shared, and stays in Liked and Recently played after a reload', async ({ page }) => {
  await start(page);
  const row = await findInSearch(page, first.title);
  await row.getByTestId('track-play').click();
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  await menu(page, row, 'menu-like');
  await expect(page.getByTestId('toast').last()).toHaveText('Added to Liked songs');
  // Shared as its post: an MP3 isn't on YouTube.
  await menu(page, row, 'menu-share');
  await expect.poll(async () => (await musicCalls(page)).filter((c) => c[0] === 'share').map((c) => (c[1] as { url: string }).url)).toEqual([postUrl(first)]);

  await page.reload();
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-liked').click();
  const liked = page.getByTestId('liked-list').getByTestId('track-row');
  await expect(liked.getByTestId('track-title')).toHaveText([first.title]);
  await expect(liked.locator('img')).toHaveAttribute('src', coverUrl(first.file));
  await liked.first().getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(first.title);
  await page.reload();
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('history-day').first().getByTestId('track-title').filter({ hasText: first.title })).not.toHaveCount(0);
});

test('skipping between MP3s that are still loading keeps showing Pause', async ({ page }) => {
  // latex.gg slow to answer: a skip lands while the first MP3 is still loading.
  await page.route(/^https:\/\/latex\.gg\/share\//, async (route) => {
    await new Promise((r) => setTimeout(r, 5000));
    await route.fallback();
  });
  await start(page);
  const row = await findInSearch(page, first.title);
  await row.getByTestId('track-play').click();
  await page.getByTestId('search-input').fill(second.title);
  await menu(page, page.getByTestId('search-results').getByTestId('track-row').filter({ hasText: second.title }).first(), 'menu-add-queue');
  await page.keyboard.press('Escape');
  await openNowPlaying(page);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(second.title);
  // The first one's cancelled play() must not make the second look paused while it loads
  // (latex.gg still hasn't answered): Pause the whole time, not Play until it starts.
  expect(await expectStable(() => page.getByTestId('np-toggle').getAttribute('aria-label'), 1500)).toBe('Pause');
});

test('an MP3 that is gone from latex.gg is skipped with a note', async ({ page }) => {
  await page.route(/^https:\/\/latex\.gg\/share\//, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
  await start(page);
  const row = await findInSearch(page, first.title);
  await row.getByTestId('track-play').click();
  await expect(page.getByTestId('toast').last()).toHaveText(`Skipped "${first.title}": unavailable`);
});

test('a liked MP3 is saved for offline by its file name: offline it stays bright and plays, an unsaved one is dimmed', async ({ page, backend }) => {
  await start(page);
  for (const p of [first, second]) {
    await page.getByTestId('tab-home').click();
    const row = await findInSearch(page, p.title);
    await menu(page, row, 'menu-like');
    await expect(page.getByTestId('toast').last()).toHaveText('Added to Liked songs');
    await page.keyboard.press('Escape');
  }
  // Native hears of both by their audio ids (the file names), newest like first.
  const audioIds = [second, first].map((p) => `mp3:${p.file}.mp3`);
  await expect.poll(async () => (await playerCalls(page)).filter((c) => c[0] === 'setLikedIds').at(-1)).toEqual(['setLikedIds', audioIds]);
  // Native reports the first one saved whole (as the listening-cache tests do).
  await page.evaluate((ids) => (window as unknown as { __cyberjukeCache: { saved(ids: string[]): void } }).__cyberjukeCache.saved(ids), [`mp3:${first.file}.mp3`]);

  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-liked').click();
  const rows = page.getByTestId('liked-list').getByTestId('track-row');
  await expect(rows.getByTestId('track-title')).toHaveText([second.title, first.title]);
  await setOffline(page, backend, true);
  await expect(page.getByTestId('offline-banner')).toHaveText('[ offline ] no carrier · your liked songs still play');
  const saved = rows.filter({ hasText: first.title });
  const unsaved = rows.filter({ hasText: second.title });
  await expect(saved).not.toHaveClass(/\boff\b/);
  await expect(saved.getByTestId('track-play')).not.toHaveAttribute('aria-disabled');
  await expect(unsaved).toHaveClass(/\boff\b/);
  await expect(unsaved.getByTestId('track-play')).toHaveAttribute('aria-disabled', 'true');
  // The unsaved one says so and nothing starts; the saved one plays.
  await unsaved.getByTestId('track-play').click({ force: true });
  await expect(page.getByTestId('toast').last()).toHaveText('Not saved yet. Needs a connection.');
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
  await saved.getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(first.title);
});
