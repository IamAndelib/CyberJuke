import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { expectStable, musicCalls, openNowPlaying, openSearch, start } from '../helpers';
import { genreFamilies } from '../../src/data/similar';
import { artistKey, splitArtists } from '../../src/data/artists';
import { words } from '../../src/data/search';

/** Autoplay (Wave 1d): radios from feeds, lists that continue, Global radios, and the queue rules. */

interface QTrack {
  id: string;
  title: string;
  artist: string;
  genre: string;
  by: string;
  source: string;
}
interface QState {
  context: { label: string; mode: 'radio' | 'list' } | null;
  current: QTrack | null;
  seed: QTrack | null;
  queued: QTrack[];
  list: QTrack[];
  autoplay: QTrack[];
}

const queueState = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => QState }).__cyberjukeQueue());

/** Wait until autoplay has added tracks, and return the queue. */
async function withAutoplay(page: Page, min = 20): Promise<QState> {
  await expect.poll(async () => (await queueState(page)).autoplay.length, { message: 'autoplay tracks ahead' }).toBeGreaterThanOrEqual(min);
  return queueState(page);
}

const visible = (page: Page, testid: string) => page.locator(`[data-testid="${testid}"]:visible`);

/** Like the engine: an artist in common, or a genre word or family in common. */
function alike(a: QTrack, b: QTrack): boolean {
  const ka = splitArtists(a.artist).map(artistKey);
  if (splitArtists(b.artist).some((x) => ka.includes(artistKey(x)))) return true;
  const wa = new Set(words(a.genre));
  if (words(b.genre).some((w) => w.length > 1 && wa.has(w))) return true;
  const fa = genreFamilies(a.genre);
  return [...genreFamilies(b.genre)].some((f) => fa.has(f));
}

/** ⋯ → Add to queue on visible row i. */
async function queueRow(page: Page, i: number) {
  await visible(page, 'track-more').nth(i).click();
  await expect(page.getByTestId('track-menu')).toBeVisible();
  await page.getByTestId('menu-add-queue').click();
  await expect(page.getByTestId('track-menu')).toBeHidden();
  await expect(page.locator('.sheet-wrap.open')).toHaveCount(0);
}

test('a Home row starts a radio: Up next is similar Jukebox tracks', async ({ page }) => {
  await start(page);
  // The most used genre, so the catalog has plenty alike (a rare genre widens sooner).
  const chip = page.getByTestId('genre-chip').first();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(visible(page, 'track-row').first()).toBeVisible();
  const title = (await visible(page, 'track-title').nth(2).textContent())!.trim();
  await visible(page, 'track-play').nth(2).click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);

  const q = await withAutoplay(page);
  expect(q.context?.mode).toBe('radio');
  expect(q.list).toEqual([]);
  expect(q.seed?.title).toBe(title);
  const seed = q.seed!;
  expect(q.autoplay.length).toBeLessThanOrEqual(25);
  expect(q.autoplay.every((t) => t.source === 'jukebox' && t.id !== seed.id)).toBe(true);
  expect(new Set(q.autoplay.map((t) => t.id)).size).toBe(q.autoplay.length);
  // Mostly the same genre (family) or artist; the variety rules hold.
  const close = q.autoplay.filter((t) => alike(seed, t)).length;
  expect(close, `${close} of ${q.autoplay.length} alike`).toBeGreaterThanOrEqual(Math.ceil(q.autoplay.length * 0.6));
  const artists = [seed, ...q.autoplay].map((t) => artistKey(t.artist));
  for (let i = 1; i < artists.length; i++) expect(artists[i], `pick ${i}`).not.toBe(artists[i - 1]);

  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveText(`Autoplay · similar to ${title}`);
  await expect(page.getByTestId('upnext-list-label')).toHaveCount(0);
  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  await expect(rows.first().locator('.row-title')).toHaveText(q.autoplay[0].title);
  // Slightly dimmed.
  expect(Number(await rows.first().locator('.row-main').evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
});

test('Up next: autoplay rows have only a 48px Remove, which offers Undo', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  const q = await withAutoplay(page);
  await openNowPlaying(page);
  const row = page.locator('[data-testid="upnext-row"][data-section="autoplay"]').nth(1);
  await expect(page.locator('[data-section="autoplay"] [data-testid="upnext-up"]')).toHaveCount(0);
  await expect(page.locator('[data-section="autoplay"] [data-testid="upnext-down"]')).toHaveCount(0);
  const rb = await row.getByTestId('upnext-remove').boundingBox();
  expect(rb!.width).toBeCloseTo(48, 1);
  expect(rb!.height).toBeCloseTo(48, 1);

  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const before = await rows.count();
  // By id: two picks can share a title.
  const gone = q.autoplay[1].id;
  // Two taps in a row: the second lands on the next row, which moved under the finger,
  // and is ignored (300 ms). It goes in as soon as the list has re-rendered (microtasks,
  // no timer), so a slow runner can't stretch the gap past the guard.
  const gap = await row.getByTestId('upnext-remove').evaluate(async (el) => {
    const removes = () => document.querySelectorAll<HTMLElement>('[data-section="autoplay"] [data-testid="upnext-remove"]');
    const n = removes().length;
    const t0 = performance.now();
    (el as HTMLElement).click();
    for (let i = 0; i < 1000 && removes().length === n; i++) await Promise.resolve();
    removes()[1].click();
    return performance.now() - t0;
  });
  expect(gap).toBeLessThan(300);
  await expect(rows).toHaveCount(before - 1);
  await expectStable(() => rows.count(), 400);
  await expect(page.getByTestId('toast').filter({ hasText: 'Removed from queue' })).toHaveCount(1);
  await expect(page.locator(`[data-testid="upnext-row"][data-track-id="${gone}"]`)).toHaveCount(0);
  const t = page.getByTestId('toast').filter({ hasText: 'Removed from queue' });
  await expect(t).toBeVisible();
  await t.getByTestId('toast-action').click();
  // Back where it was: second in autoplay.
  await expect(rows.nth(1)).toHaveAttribute('data-track-id', gone);
});

test('Album Play plays the album, then continues into autoplay at the end', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  await page.getByTestId('search-input').fill('Night Owl');
  await page.getByTestId('mode-global').click();
  await page.getByTestId('filter-albums').click();
  await page.getByTestId('music-open').first().click();
  const album = page.getByTestId('screen-album');
  await expect(album.getByTestId('track-row')).toHaveCount(8);
  const titles = (await album.getByTestId('track-title').allTextContents()).map((s) => s.trim());
  await album.getByTestId('album-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(titles[0]);

  const q = await withAutoplay(page, 5);
  expect(q.context?.mode).toBe('list');
  expect(q.list.map((t) => t.title)).toEqual(titles.slice(1));
  // Global leads to Global: the first track's radio.
  expect(q.autoplay.every((t) => t.source === 'ytmusic' && /^Radio \d+$/.test(t.title))).toBe(true);
  expect((await musicCalls(page)).filter((c) => c[0] === 'radio')).toHaveLength(1);

  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-list-label')).toContainText('Next from:');
  // List rows can be reordered: 48px Up, Down and Remove, 8px apart.
  const listRow = page.locator('[data-testid="upnext-row"][data-section="list"]').nth(1);
  const [up, down, remove] = await Promise.all(['upnext-up', 'upnext-down', 'upnext-remove'].map((id) => listRow.getByTestId(id).boundingBox()));
  for (const b of [up, down, remove]) {
    expect(b!.width).toBeCloseTo(48, 1);
    expect(b!.height).toBeCloseTo(48, 1);
  }
  expect(Math.round(down!.x - (up!.x + up!.width))).toBe(8);
  expect(Math.round(remove!.x - (down!.x + down!.width))).toBe(8);
  // Jump to the album's last track; Next then plays the first autoplay track.
  const lastRow = page.locator('[data-testid="upnext-row"][data-section="list"]').last();
  await expect(lastRow.locator('.row-title')).toHaveText(titles[7]);
  await lastRow.locator('.row-main').click();
  await expect(page.getByTestId('np-title')).toHaveText(titles[7]);
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"]')).toHaveCount(0);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(q.autoplay[0].title);
});

test('a Global result starts a Global radio; tapping an autoplay track continues from it', async ({ page }) => {
  await page.goto('/');
  await openSearch(page);
  await page.getByTestId('search-input').fill('Night Owl');
  await page.getByTestId('mode-global').click();
  const results = page.getByTestId('global-results');
  await expect(results.getByTestId('track-row').first()).toBeVisible();
  const title = (await results.getByTestId('track-title').first().textContent())!.trim();
  await results.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);

  const q = await withAutoplay(page);
  expect(q.context?.mode).toBe('radio');
  expect(q.list).toEqual([]);
  expect(q.seed?.source).toBe('ytmusic');
  expect(q.autoplay.every((t) => t.source === 'ytmusic')).toBe(true);
  const seedYt = q.seed!.id.replace(/^ytm:/, '');
  expect((await musicCalls(page)).filter((c) => c[0] === 'radio')).toEqual([['radio', seedYt, null]]);

  // Near the end of the radio, Up next refills from the same radio's next page.
  await openNowPlaying(page);
  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const pick = q.autoplay[3];
  await rows.nth(3).locator('.row-main').click();
  await expect(page.getByTestId('np-title')).toHaveText(pick.title);
  // The old radio after it went; a new one follows the tapped track.
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveText(`Autoplay · similar to ${pick.title}`);
  await expect.poll(async () => (await musicCalls(page)).filter((c) => c[0] === 'radio').map((c) => c[1])).toEqual([seedYt, pick.id.replace(/^ytm:/, '')]);
  const after = await withAutoplay(page);
  expect(after.seed?.id).toBe(pick.id);
  expect(after.autoplay.some((t) => q.autoplay.slice(4).some((o) => o.id === t.id))).toBe(false);
});

test('queued tracks survive a new list, then autoplay follows', async ({ page }) => {
  await start(page);
  const titles = (await visible(page, 'track-title').allTextContents()).map((t) => t.trim());
  await visible(page, 'track-play').first().click();
  await expect(page.getByTestId('mini-title')).toHaveText(titles[0]);
  await queueRow(page, 3);
  await queueRow(page, 4);
  // A new radio from another row.
  await visible(page, 'track-play').nth(6).click();
  await expect(page.getByTestId('mini-title')).toHaveText(titles[6]);

  const q = await withAutoplay(page);
  expect(q.queued.map((t) => t.title)).toEqual([titles[3], titles[4]]);
  expect(q.seed?.title).toBe(titles[6]);

  await openNowPlaying(page);
  const rows = page.getByTestId('upnext-row');
  await expect(rows.nth(0)).toHaveAttribute('data-section', 'queued');
  await expect(rows.nth(0).locator('.row-title')).toHaveText(titles[3]);
  await expect(rows.nth(1).locator('.row-title')).toHaveText(titles[4]);
  await expect(rows.nth(2)).toHaveAttribute('data-section', 'autoplay');
  await expect(page.getByTestId('upnext-queued-label')).toHaveText('Queued by you');
});

test('repeat turns autoplay off; the Autoplay setting off plays only the list', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await withAutoplay(page);
  await openNowPlaying(page);
  await page.getByTestId('np-repeat').click();
  await expect(page.getByTestId('np-repeat')).toHaveAttribute('data-mode', 'all');
  await expect(page.locator('[data-testid="upnext-row"][data-section="autoplay"]')).toHaveCount(0);
  await expect.poll(async () => (await queueState(page)).autoplay.length).toBe(0);
  // Back to off (all -> one -> off): autoplay fills up again.
  await page.getByTestId('np-repeat').click();
  await page.getByTestId('np-repeat').click();
  await expect(page.getByTestId('np-repeat')).toHaveAttribute('data-mode', 'off');
  await withAutoplay(page);
});
