import type { Page } from '@playwright/test';
import { expect, test, FAKE_MP3_SECONDS, MP3_POSTS, coverUrl } from '../fixtures';
import { musicCalls, openSearch, start } from '../helpers';

/** Jukebox MP3s (Cyberspace 4.0): posts whose audio is a latex.gg MP3 with a cover. */

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
  // The second MP3 next: when the first ends by itself (the audio really played), it starts.
  await page.getByTestId('search-input').fill(second.title);
  await menu(page, page.getByTestId('search-results').getByTestId('track-row').filter({ hasText: second.title }).first(), 'menu-add-queue');
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
  await expect(page.getByTestId('history-day').first().getByTestId('track-title').first()).toHaveText(first.title);
});

test('an MP3 that is gone from latex.gg is skipped with a note', async ({ page }) => {
  await page.route(/^https:\/\/latex\.gg\/share\//, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
  await start(page);
  const row = await findInSearch(page, first.title);
  await row.getByTestId('track-play').click();
  await expect(page.getByTestId('toast').last()).toHaveText(`Skipped "${first.title}": unavailable`);
});
