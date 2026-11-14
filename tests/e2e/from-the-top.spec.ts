import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { openNowPlaying, openSearch } from '../helpers';

/** "From the top" (queue rule 5): with Repeat all, Up next goes on with the next lap. */

const queueState = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => { top: string[]; mine: string[] } }).__cyberjukeQueue());

const top = (page: Page) => page.locator('[data-testid="upnext-row"][data-section="top"]');
const topTitles = (page: Page) => top(page).locator('.row-title');
const title = (page: Page) => page.getByTestId('np-title');
const removedToast = (page: Page) => page.getByTestId('toast').filter({ hasText: 'Removed from queue' });

/** The Global album "Night Owl" (8 songs): plays it from song `from` (1-based; 0: its Play), opens Now Playing, returns its titles. */
async function playAlbum(page: Page, from = 0): Promise<string[]> {
  await page.goto('/');
  await openSearch(page);
  await page.getByTestId('search-input').fill('Night Owl');
  await page.getByTestId('mode-global').click();
  await page.getByTestId('filter-albums').click();
  await page.getByTestId('music-open').first().click();
  const album = page.getByTestId('screen-album');
  await expect(album.getByTestId('track-row')).toHaveCount(8);
  const titles = (await album.getByTestId('track-title').allTextContents()).map((s) => s.trim());
  await (from ? album.getByTestId('track-play').nth(from - 1) : album.getByTestId('album-play')).click();
  await openNowPlaying(page);
  await expect(title(page)).toHaveText(titles[Math.max(from, 1) - 1]);
  return titles;
}

async function repeatAll(page: Page): Promise<void> {
  const repeat = page.getByTestId('np-repeat');
  while ((await repeat.getAttribute('data-mode')) !== 'all') await repeat.click();
}

/** Previous until the track `id` plays. */
async function prevTo(page: Page, id: string): Promise<void> {
  await expect(async () => {
    await page.getByTestId('np-prev').click();
    await expect(page.getByTestId('upnext-current')).toHaveAttribute('data-track-id', id, { timeout: 1500 });
  }).toPass();
}

/** Next until song `k` (1-based) of `titles` plays. */
async function nextTo(page: Page, titles: string[], k: number): Promise<void> {
  while ((await title(page).textContent())?.trim() !== titles[k - 1]) {
    const now = (await title(page).textContent())!;
    await page.getByTestId('np-next').click();
    await expect(title(page)).not.toHaveText(now);
  }
}

test('Repeat all at song 5 of 8: after the album, "From the top" shows songs 1–4, and ↑ ↓ reorder them', async ({ page }) => {
  const titles = await playAlbum(page);
  await repeatAll(page);
  await nextTo(page, titles, 5);
  // After the list's rows: the label, then the next lap.
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"] .row-title')).toHaveText(titles.slice(5));
  await expect(page.getByTestId('upnext-top-label')).toHaveText('From the top');
  await expect(topTitles(page)).toHaveText(titles.slice(0, 4));
  const label = await page.getByTestId('upnext-top-label').evaluate((el) => [el.previousElementSibling?.getAttribute('data-section'), el.nextElementSibling?.getAttribute('data-section')]);
  expect(label).toEqual(['list', 'top']);
  await expect(top(page).first().getByTestId('upnext-up')).toBeDisabled();
  await expect(top(page).last().getByTestId('upnext-down')).toBeDisabled();
  // A screen reader hears where a row is.
  await expect(top(page).first().locator('.row-main')).toHaveAccessibleName(`Play ${titles[0]}, from the top`);
  // "N up next" counts to the end of the list.
  await expect(page.getByTestId('up-next').locator('.upnext-left')).toHaveText('3 up next');
  // ↓ on the first: the next lap starts with song 2.
  await top(page).first().getByTestId('upnext-down').click();
  await expect(topTitles(page)).toHaveText([titles[1], titles[0], titles[2], titles[3]]);
  await expect(page.getByTestId('upnext-moved')).toHaveText('Moved to 2 of 4');
  await top(page).nth(1).getByTestId('upnext-up').click();
  await expect(topTitles(page)).toHaveText(titles.slice(0, 4));
});

test('Repeat all at the last song: "From the top" shows songs 1–7', async ({ page }) => {
  const titles = await playAlbum(page);
  await repeatAll(page);
  await nextTo(page, titles, 8);
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"]')).toHaveCount(0);
  await expect(topTitles(page)).toHaveText(titles.slice(0, 7));
});

test('an album started at song 3: "From the top" shows songs 1–2; ✕ and Undo put one back in its place', async ({ page }) => {
  const titles = await playAlbum(page, 3);
  await repeatAll(page);
  await expect(topTitles(page)).toHaveText(titles.slice(0, 2));
  await expect(page.getByTestId('upnext-played-fold')).toHaveCount(0);
  await top(page).first().getByTestId('upnext-remove').click();
  await expect(topTitles(page)).toHaveText([titles[1]]);
  await removedToast(page).getByTestId('toast-action').click();
  await expect(topTitles(page)).toHaveText(titles.slice(0, 2));
  // Still unheard.
  await expect(page.getByTestId('upnext-played-fold')).toHaveCount(0);
});

test('✕, then Repeat changed with the Undo still showing: the Undo goes, as "where it was" changed', async ({ page }) => {
  const titles = await playAlbum(page);
  await page.locator('[data-testid="upnext-row"][data-section="list"]').first().getByTestId('upnext-remove').click();
  await expect(removedToast(page).getByTestId('toast-action')).toBeVisible();
  // Not a tap on the page, which dismisses the toast: a key here, the notification's Repeat on a phone.
  await page.getByTestId('np-repeat').press('Enter');
  await expect(page.getByTestId('np-repeat')).toHaveAttribute('data-mode', 'all');
  // At once, while the toast still shows (it stays 4 s).
  await expect(removedToast(page).getByTestId('toast-action')).toHaveCount(0, { timeout: 1000 });
  await expect(removedToast(page)).toBeVisible({ timeout: 100 });
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"] .row-title').first()).toHaveText(titles[2]);
});

test('✕ on a "From the top" song you heard, then Undo: back in its place, and still in Played', async ({ page }) => {
  const titles = await playAlbum(page);
  await repeatAll(page);
  await nextTo(page, titles, 5);
  await top(page).nth(1).getByTestId('upnext-remove').click();
  await expect(topTitles(page)).toHaveText([titles[0], titles[2], titles[3]]);
  await removedToast(page).getByTestId('toast-action').click();
  await expect(topTitles(page)).toHaveText(titles.slice(0, 4));
  await expect(page.getByTestId('upnext-moved')).toHaveText('Back at 2 of 4');
  await page.getByTestId('upnext-played-fold').click();
  await expect(page.getByTestId('upnext-played').locator('.row-title')).toHaveText(titles.slice(0, 4));
});

test('with shuffle on, "From the top" has ✕ only, in the order Played shows', async ({ page }) => {
  await playAlbum(page);
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await repeatAll(page);
  for (let k = 0; k < 3; k++) {
    const now = (await title(page).textContent())!;
    await page.getByTestId('np-next').click();
    await expect(title(page)).not.toHaveText(now);
  }
  await expect(top(page)).toHaveCount(3);
  await expect(top(page).getByTestId('upnext-up')).toHaveCount(0);
  await expect(top(page).getByTestId('upnext-down')).toHaveCount(0);
  await expect(top(page).getByTestId('upnext-remove')).toHaveCount(3);
  await page.getByTestId('upnext-played-fold').click();
  await expect(page.getByTestId('upnext-played')).toHaveCount(3);
  const played = await page.getByTestId('upnext-played').locator('.row-title').allTextContents();
  await expect(topTitles(page)).toHaveText(played);
});

test('with shuffle on, songs you queued keep ↑ ↓ and play in the order you set; the list has ✕ only', async ({ page }) => {
  await playAlbum(page);
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-home').click();
  for (const n of [0, 1, 2]) {
    await page.locator('[data-testid="track-more"]:visible').nth(n).click();
    await page.getByTestId('menu-add-queue').click();
    await expect(page.locator('.sheet-wrap.open')).toHaveCount(0);
  }
  const mine = (await queueState(page)).mine;
  await openNowPlaying(page);
  const queued = page.locator('[data-testid="upnext-row"][data-section="queued"]');
  const order = () => queued.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-track-id')));
  await expect.poll(order).toEqual(mine);
  await expect(queued.getByTestId('upnext-up')).toHaveCount(3);
  await expect(queued.first().getByTestId('upnext-up')).toBeDisabled();
  await expect(queued.last().getByTestId('upnext-down')).toBeDisabled();
  const list = page.locator('[data-testid="upnext-row"][data-section="list"]');
  await expect(list.first().getByTestId('upnext-remove')).toBeVisible();
  await expect(list.getByTestId('upnext-up')).toHaveCount(0);
  await expect(list.getByTestId('upnext-down')).toHaveCount(0);
  // ↓ on the first swaps the first two, and Next plays the new first one.
  await queued.first().getByTestId('upnext-down').click();
  await expect.poll(order).toEqual([mine[1], mine[0], mine[2]]);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('upnext-current')).toHaveAttribute('data-track-id', mine[1]);
  await expect.poll(order).toEqual([mine[0], mine[2]]);
});

test('Repeat off or Repeat one: no "From the top"', async ({ page }) => {
  const titles = await playAlbum(page);
  await nextTo(page, titles, 5);
  await expect(page.getByTestId('upnext-top-label')).toHaveCount(0);
  await expect(top(page)).toHaveCount(0);
  await repeatAll(page);
  await expect(top(page)).toHaveCount(4);
  await page.getByTestId('np-repeat').click();
  await expect(page.getByTestId('np-repeat')).toHaveAttribute('data-mode', 'one');
  await expect(page.getByTestId('upnext-top-label')).toHaveCount(0);
  await expect(top(page)).toHaveCount(0);
});

test('a song you queued and heard stays in Played, not "From the top"; a tap on a "From the top" row plays it, and the queued song is gone', async ({ page }) => {
  const titles = await playAlbum(page);
  await repeatAll(page);
  await nextTo(page, titles, 2);
  // ⋯ → Add to queue on a Home song: it plays next.
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-home').click();
  await page.locator('[data-testid="track-more"]:visible').first().click();
  await page.getByTestId('menu-add-queue').click();
  await expect(page.locator('.sheet-wrap.open')).toHaveCount(0);
  const [mine] = (await queueState(page)).mine;
  await openNowPlaying(page);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('upnext-current')).toHaveAttribute('data-track-id', mine);
  await page.getByTestId('np-next').click();
  await expect(title(page)).toHaveText(titles[2]);
  // Heard: in Played, after song 2; not in the next lap.
  await page.getByTestId('upnext-played-fold').click();
  await expect(page.getByTestId('upnext-played')).toHaveCount(3);
  await expect(page.getByTestId('upnext-played').nth(2)).toHaveAttribute('data-track-id', mine);
  await expect(topTitles(page)).toHaveText(titles.slice(0, 2));
  await expect(page.locator(`[data-section="top"][data-track-id="${mine}"]`)).toHaveCount(0);
  // ✕ on it in Played, then Undo: back, still yours, so still not in the next lap.
  await page.getByTestId('upnext-played').nth(2).getByTestId('upnext-remove').click();
  await expect(page.getByTestId('upnext-played')).toHaveCount(2);
  await removedToast(page).getByTestId('toast-action').click();
  await expect(page.getByTestId('upnext-played').nth(2)).toHaveAttribute('data-track-id', mine);
  await expect(topTitles(page)).toHaveText(titles.slice(0, 2));
  expect((await queueState(page)).mine).toEqual([mine]);
  // A tap on song 2 there enters the next lap: the queued song leaves.
  await top(page).nth(1).locator('.row-main').click();
  await expect(title(page)).toHaveText(titles[1]);
  await expect(page.getByTestId('up-next').locator(`[data-track-id="${mine}"]`)).toHaveCount(0);
  await expect(page.getByTestId('upnext-played').locator('.row-title')).toHaveText([titles[0]]);
  expect((await queueState(page)).mine).toEqual([]);
});

test('a song you queued and heard, ahead again after Previous: ✕ and Undo keep it yours', async ({ page }) => {
  const titles = await playAlbum(page);
  const first = (await page.getByTestId('upnext-current').getAttribute('data-track-id'))!;
  await repeatAll(page);
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-home').click();
  await page.locator('[data-testid="track-more"]:visible').first().click();
  await page.getByTestId('menu-add-queue').click();
  await expect(page.locator('.sheet-wrap.open')).toHaveCount(0);
  const [mine] = (await queueState(page)).mine;
  await openNowPlaying(page);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('upnext-current')).toHaveAttribute('data-track-id', mine);
  await page.getByTestId('np-next').click();
  await expect(title(page)).toHaveText(titles[1]);
  // Previous back to song 1 (a press past a song's first seconds restarts it): the queued song is ahead again, as a song of the list.
  await prevTo(page, mine);
  await prevTo(page, first);
  await expect(title(page)).toHaveText(titles[0]);
  const row = page.locator(`[data-testid="upnext-row"][data-track-id="${mine}"]`);
  await expect(row).toHaveAttribute('data-section', 'list');
  await row.getByTestId('upnext-remove').click();
  await expect(row).toHaveCount(0);
  await removedToast(page).getByTestId('toast-action').click();
  await expect(row).toHaveCount(1);
  expect((await queueState(page)).mine).toEqual([mine]);
});
