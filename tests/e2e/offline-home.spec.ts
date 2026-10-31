import { expect, test } from '../fixtures';
import type { Page } from '@playwright/test';
import { openSearch, playerCalls, seedStorage, start } from '../helpers';

/**
 * Opened offline, Home and Search still lead to music: Home's hero shuffles the liked songs
 * saved on the phone and its list is the Jukebox saved from before (unsaved rows dimmed);
 * Search finds the saved Jukebox. Nothing points to a connection it can't use.
 */

/** What native reports as saved whole (by ytId). */
const saved = (page: Page, ytIds: string[]) => page.evaluate((ids) => (window as unknown as { __cyberjukeCache: { saved(ids: string[]): void } }).__cyberjukeCache.saved(ids), ytIds);

/** Reopens the app with the device offline from the start (navigator.onLine, as the Network plugin reads it on the web). */
async function relaunchOffline(page: Page, backend: { offline: boolean }) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });
  });
  backend.offline = true;
  await page.reload();
  await expect(page.getByTestId('offline-banner')).toBeVisible();
}

/** Likes Home's rows [i] and returns their video ids. */
async function like(page: Page, rows: number[]): Promise<string[]> {
  const ids: string[] = [];
  for (const i of rows) {
    await page.getByTestId('track-more').nth(i).click();
    await page.getByTestId('menu-like').click();
    const src = (await page.getByTestId('track-row').nth(i).locator('img').first().getAttribute('src')) ?? '';
    ids.push(/\/vi\/([^/]+)\//.exec(src)?.[1] ?? '');
  }
  return ids;
}

test('opened offline, Home shuffles the saved liked songs and lists the Jukebox saved from before, unsaved rows dimmed', async ({ page, backend }) => {
  await start(page);
  const ids = await like(page, [0, 2]);
  const titles = await page.getByTestId('track-title').allTextContents();
  await relaunchOffline(page, backend);
  await saved(page, ids);

  const home = page.getByTestId('screen-home');
  await expect(home.getByTestId('offline')).toHaveCount(0);
  await expect(home.getByTestId('track-row').first()).toBeVisible();
  // The saved ones play, the rest are dimmed.
  await expect(home.getByTestId('track-row').filter({ hasText: titles[0] }).first()).not.toHaveClass(/\boff\b/);
  await expect(home.getByTestId('track-row').filter({ hasText: titles[1] }).first()).toHaveClass(/\boff\b/);

  const hero = page.getByTestId('shuffle-all');
  await expect(hero).toContainText('Shuffle liked songs');
  await expect(hero).toContainText('Saved on the phone · plays offline');
  await hero.click();
  const last = async () => (await playerCalls(page)).filter((c) => c[0] === 'setQueue').map((c) => c[1] as { n: number; context: { label: string } }).at(-1);
  await expect.poll(async () => (await last())?.n).toBe(2);
  expect((await last())?.context.label).toBe('Liked');
});

test('opened offline with no Jukebox saved before, Home says no carrier, and with liked songs saved it offers Liked', async ({ page, backend }) => {
  const liked = { id: 'l1', ytId: 'abcdefghij1', title: 'Track l1', artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '2026-01-01T00:00:00Z', nsfw: false, artworkUrl: '' };
  await seedStorage(page, { 'CapacitorStorage.liked': [liked] });
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });
  });
  backend.offline = true;
  await page.goto('/');
  const home = page.getByTestId('screen-home');
  await expect(home.getByTestId('offline')).toBeVisible();
  await expect(home.getByTestId('offline-liked')).toHaveCount(0);
  await expect(page.getByTestId('shuffle-all')).toContainText('Shuffle the Jukebox');
  // A liked song saved on the phone: the state offers Liked, and the hero shuffles them.
  await saved(page, [liked.ytId]);
  await expect(page.getByTestId('shuffle-all')).toContainText('Shuffle liked songs');
  await home.getByTestId('offline-liked').click();
  await expect(page.getByTestId('screen-library')).toBeVisible();
  await expect(page.getByTestId('lib-liked')).toHaveAttribute('aria-selected', 'true');
});

test('offline, Search finds the saved Jukebox, with no way to Global', async ({ page, backend }) => {
  await start(page);
  const title = (await page.getByTestId('track-title').first().textContent())!.trim();
  await relaunchOffline(page, backend);
  await openSearch(page);
  await page.getByTestId('search-input').fill(title.slice(0, 6));
  const search = page.getByTestId('search');
  await expect(search.getByTestId('track-row').first()).toBeVisible();
  await expect(search.getByTestId('offline')).toHaveCount(0);
  await expect(search.getByText('Search globally')).toHaveCount(0);
});
