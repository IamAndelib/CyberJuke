import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { expectStable, fakeYt, musicCalls, openNowPlaying, openSearch, openSettings, setOffline, setVisibility, start, toListEnd } from '../helpers';
import { genreFamilies } from '../../src/data/similar';
import { artistKey, splitArtists } from '../../src/data/artists';
import { words } from '../../src/data/text';

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
  /** Where the list on the way starts in the queue (-1: none), and the queue's length. */
  nextStart: number;
  length: number;
}

const queueState = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => QState }).__cyberjukeQueue());

/** Wait until autoplay has added tracks, and return the queue. */
async function withAutoplay(page: Page, min = 20): Promise<QState> {
  await expect.poll(async () => (await queueState(page)).autoplay.length, { message: 'autoplay tracks ahead' }).toBeGreaterThanOrEqual(min);
  return queueState(page);
}

/** Wait until the next list is on the way (rule 2: a batch of 25), and return the queue. */
async function withOnTheWay(page: Page): Promise<QState> {
  await expect.poll(async () => (await queueState(page)).nextStart, { message: 'a list on the way' }).toBeGreaterThanOrEqual(0);
  const q = await queueState(page);
  expect(q.length - q.nextStart, 'the batch on the way').toBe(25);
  return q;
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

/** Plays the Global album "Night Owl" (8 songs) and opens Now Playing; returns its titles. */
async function playAlbum(page: Page): Promise<string[]> {
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
  await openNowPlaying(page);
  return titles;
}

test('a Home row starts a Vibe: the tapped song and 24 similar Jukebox tracks, the next 25 on the way', async ({ page }) => {
  await start(page);
  // The most used genre, so the catalog has plenty alike (a rare genre widens sooner).
  const chip = page.getByTestId('genre-chip').first();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(visible(page, 'track-row').first()).toBeVisible();
  const title = (await visible(page, 'track-title').nth(2).textContent())!.trim();
  await visible(page, 'track-play').nth(2).click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);

  const q = await withOnTheWay(page);
  expect(q.context?.mode).toBe('radio');
  expect(q.list).toEqual([]);
  expect(q.seed?.title).toBe(title);
  const seed = q.seed!;
  // The tapped song and 24 joined to it are the list; the next 25 are on the way. Nothing more.
  expect(q.nextStart).toBe(25);
  expect(q.autoplay).toHaveLength(49);
  expect((await expectStable(() => queueState(page), 1000)).length).toBe(50);
  expect(q.autoplay.every((t) => t.source === 'jukebox' && t.id !== seed.id)).toBe(true);
  expect(new Set(q.autoplay.map((t) => t.id)).size).toBe(q.autoplay.length);
  // Mostly the same genre (family) or artist; the variety rules hold.
  const first = q.autoplay.slice(0, 24);
  const close = first.filter((t) => alike(seed, t)).length;
  expect(close, `${close} of ${first.length} alike`).toBeGreaterThanOrEqual(Math.ceil(first.length * 0.6));
  const artists = [seed, ...first].map((t) => artistKey(t.artist));
  for (let i = 1; i < artists.length; i++) expect(artists[i], `pick ${i}`).not.toBe(artists[i - 1]);

  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveText(`Vibe · like ${title}`);
  await expect(page.getByTestId('upnext-list-label')).toHaveCount(0);
  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  await expect(rows.first().locator('.row-title')).toHaveText(q.autoplay[0].title);
  // Its 24, then the batch on the way under its own heading, as much of it as fills Up next to 25 rows (D1):
  // to look at and tap, with no ↑ ↓ ✕.
  await expect(rows).toHaveCount(24);
  await expect(page.getByTestId('upnext-way-label')).toHaveText('On the way');
  const way = page.locator('[data-testid="upnext-row"][data-section="way"]');
  await expect(way).toHaveCount(1);
  await expect(way.first()).toHaveAttribute('data-track-id', q.autoplay[24].id);
  await expect(way.locator('button:not(.row-main)')).toHaveCount(0);
  await expect(page.getByTestId('up-next').locator('.section-head')).toContainText('25 up next');
  // The artwork slightly dimmed; the text keeps its theme's contrast.
  const opacity = (sel: string) => rows.first().locator(sel).evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await opacity('.row-art')).toBeLessThan(1);
  expect(await opacity('.row-main')).toBe(1);
});

test('On the way fills Up next to 25 rows, one more as each song ends; Repeat all and Vibe off show none', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await withOnTheWay(page);
  await openNowPlaying(page);
  const way = page.locator('[data-testid="upnext-row"][data-section="way"]');
  const count = page.getByTestId('up-next').locator('.section-head');
  await expect(way).toHaveCount(1);
  await page.getByTestId('np-next').click();
  await expect(way).toHaveCount(2);
  await expect(count).toContainText('25 up next');
  // Repeat all loops the list you're in: nothing is on the way. Off again, a batch comes (D18).
  const repeat = page.getByTestId('np-repeat');
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'all');
  await expect(page.getByTestId('upnext-way-label')).toHaveCount(0);
  await repeat.click();
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'off');
  await expect(way).toHaveCount(2);
  // Vibe off: what's on the way goes; the list you're in stays.
  await page.getByTestId('np-close').click();
  await openSettings(page);
  await page.getByTestId('autoplay-toggle').click();
  await expect(page.getByTestId('autoplay-toggle')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('tab-home').click();
  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-way-label')).toHaveCount(0);
  await expect(page.locator('[data-testid="upnext-row"][data-section="autoplay"]')).toHaveCount(23);
});

test("from the keyboard, removing the list's last row moves focus on to the first song on the way", async ({ page }) => {
  const titles = await playAlbum(page);
  for (let k = 1; k <= 6; k++) {
    await page.getByTestId('np-next').click();
    await expect(page.getByTestId('np-title')).toHaveText(titles[k]);
  }
  const way = page.locator('[data-testid="upnext-row"][data-section="way"]');
  await expect(way.first()).toBeVisible();
  const first = (await way.first().getAttribute('data-track-id'))!;
  await page.locator('[data-testid="upnext-row"][data-section="list"]').getByTestId('upnext-remove').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"]')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return `${a?.className}:${a?.closest('li')?.getAttribute('data-track-id')}`;
    }))
    .toBe(`row-main:${first}`);
});

test('Up next: autoplay rows reorder like the others (not with shuffle), and Remove offers Undo', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  const q = await withAutoplay(page);
  await openNowPlaying(page);
  const row = page.locator('[data-testid="upnext-row"][data-section="autoplay"]').nth(1);
  const autoRows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  // ▲/▼ within the section: the first can't go up, the last can't go down.
  await expect(autoRows.first().getByTestId('upnext-up')).toBeDisabled();
  await expect(autoRows.last().getByTestId('upnext-down')).toBeDisabled();
  const first = (await autoRows.nth(0).getAttribute('data-track-id'))!;
  const second = (await autoRows.nth(1).getAttribute('data-track-id'))!;
  await autoRows.first().getByTestId('upnext-down').click();
  await expect(autoRows.nth(0)).toHaveAttribute('data-track-id', second);
  await expect(autoRows.nth(1)).toHaveAttribute('data-track-id', first);
  // Still autoplay picks after the move.
  expect((await queueState(page)).autoplay.slice(0, 2).map((t) => t.id)).toEqual([second, first]);
  await page.waitForTimeout(350); // past the double-tap guard
  const rb = await row.getByTestId('upnext-remove').boundingBox();
  expect(rb!.width).toBeCloseTo(44, 1);
  expect(rb!.height).toBeCloseTo(48, 1);

  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const before = await rows.count();
  // By id: two picks can share a title (read off the row: the move above reordered them).
  const gone = (await row.getAttribute('data-track-id'))!;
  void q;
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

test('Album Play plays the album, with the next list on the way from its start, and continues into it at the end', async ({ page }) => {
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

  // The album first, and its next list on the way at once (rule 2): one page of the first track's radio.
  const start = await withOnTheWay(page);
  expect(start.context?.mode).toBe('list');
  expect(start.list.map((t) => t.title)).toEqual(titles.slice(1));
  expect(start.nextStart).toBe(8);
  expect(await expectStable(() => queueState(page), 1000)).toEqual(start);
  const radios = async () => (await musicCalls(page)).filter((c) => c[0] === 'radio');
  expect(await radios()).toHaveLength(1);

  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-list-label')).toContainText('Next from:');
  // List rows can be reordered: Up, Down and Remove, 44x48 and side by side, so the title gets the room.
  const listRow = page.locator('[data-testid="upnext-row"][data-section="list"]').nth(1);
  const [up, down, remove] = await Promise.all(['upnext-up', 'upnext-down', 'upnext-remove'].map((id) => listRow.getByTestId(id).boundingBox()));
  for (const b of [up, down, remove]) {
    expect(b!.width).toBeCloseTo(44, 1);
    expect(b!.height).toBeCloseTo(48, 1);
  }
  expect(Math.round(down!.x - (up!.x + up!.width))).toBe(0);
  expect(Math.round(remove!.x - (down!.x + down!.width))).toBe(0);
  // Jump to the album's last track; Next then plays the first autoplay track.
  const lastRow = page.locator('[data-testid="upnext-row"][data-section="list"]').last();
  await expect(lastRow.locator('.row-title')).toHaveText(titles[7]);
  await toListEnd(page);
  await expect(page.getByTestId('np-title')).toHaveText(titles[7]);
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"]')).toHaveCount(0);
  // At its end: Global leads to Global, the first track's radio, already there; nothing new is asked for.
  const q = await queueState(page);
  expect(q.autoplay.map((t) => t.id)).toEqual(start.autoplay.map((t) => t.id));
  expect(q.autoplay.every((t) => t.source === 'ytmusic' && /^Radio \d+$/.test(t.title))).toBe(true);
  expect(await radios()).toHaveLength(1);
  // Next plays the first of it: it starts, so its next page comes on the way.
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(q.autoplay[0].title);
  await expect.poll(async () => (await radios()).length).toBe(2);
  await withOnTheWay(page);
});

test("↑ ↓ never cross the line between two lists: a radio's own suggestions and the batch on the way, an earlier list and the one you're in (S7)", async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  // The radio's own suggestions, then the next batch on the way.
  await withOnTheWay(page);
  await openNowPlaying(page);
  const line = page.getByTestId('upnext-way-label');
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveCount(1);
  await expect(line.locator('xpath=preceding-sibling::li[1]').getByTestId('upnext-down')).toBeDisabled();
  await expect(line.locator('xpath=preceding-sibling::li[1]').getByTestId('upnext-up')).toBeEnabled();
  // The rows on the way have no ↑ ↓ ✕ at all.
  await expect(line.locator('xpath=following-sibling::li[1]').locator('.upnext-actions')).toHaveCount(0);
  // A tap on the first one on the way moves on: the radio's songs are an earlier list now, and Played's last can't go past the playing one into this one.
  await line.locator('xpath=following-sibling::li[1]').locator('.row-main').click();
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveCount(1);
  await page.getByTestId('upnext-played-fold').click();
  const played = page.getByTestId('upnext-played');
  await expect(played.last().getByTestId('upnext-down')).toBeDisabled();
  await expect(played.last().getByTestId('upnext-remove')).toBeEnabled();
});

test('"N of M" counts the album, not a song you queued, which shows where it plays from alone (A3)', async ({ page }) => {
  const titles = await playAlbum(page);
  const from = page.getByTestId('np-from');
  await expect(from).toContainText('1 of 8 · ');
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-home').click();
  await queueRow(page, 0);
  await openNowPlaying(page);
  await expect(from).toContainText('1 of 8 · ');
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).not.toHaveText(titles[0]);
  await expect(from).toContainText('Playing from');
  await expect(from).not.toContainText(' of ');
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(titles[1]);
  await expect(from).toContainText('2 of 8 · ');
});

test('after Previous, a tapped suggestion leaves the songs you went back over in Played; the unheard ones come after it (A2)', async ({ page }) => {
  const titles = await playAlbum(page);
  for (let k = 1; k <= 3; k++) {
    await page.getByTestId('np-next').click();
    await expect(page.getByTestId('np-title')).toHaveText(titles[k]);
  }
  const q = await withAutoplay(page, 5);
  // Previous until song 2 (each first restarts the song).
  await expect(async () => {
    await page.getByTestId('np-prev').click();
    await expect(page.getByTestId('np-title')).toHaveText(titles[1], { timeout: 1500 });
  }).toPass();
  await page.locator('[data-testid="upnext-row"][data-section="way"] .row-main').first().click();
  await expect(page.getByTestId('np-title')).toHaveText(q.autoplay[0].title);
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"] .row-title')).toHaveText(titles.slice(4));
  await page.getByTestId('upnext-played-fold').click();
  await expect(page.getByTestId('upnext-played').locator('.row-title')).toHaveText(titles.slice(0, 4));
});

test('a tapped suggestion, then Previous: the album songs stay under the album, "3 of 8" stays right, and Undo puts each song back', async ({ page }) => {
  const titles = await playAlbum(page);
  // Suggestions are on the way from the album's start.
  await page.getByTestId('np-next').click();
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(titles[2]);
  const q = await withAutoplay(page, 5);
  await expect(page.getByTestId('np-from')).toContainText('3 of 8');
  // A tap on the first suggestion (on the way) plays it; Previous (twice: the first restarts it) goes back.
  await page.locator('[data-testid="upnext-row"][data-section="way"] .row-main').first().click();
  await expect(page.getByTestId('np-title')).toHaveText(q.autoplay[0].title);
  await page.getByTestId('np-prev').click();
  await page.getByTestId('np-prev').click();
  await expect(page.getByTestId('np-title')).toHaveText(titles[2]);
  // The suggestion is next, under its own heading; the album's songs after it stay the album's. Its
  // batch is the current list, the rest of it after the album's songs; the next batch is on the way.
  const rows = page.getByTestId('upnext-row');
  await expect(rows.first()).toHaveAttribute('data-track-id', q.autoplay[0].id);
  await expect(rows.first()).toHaveAttribute('data-section', 'autoplay');
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"] .row-title')).toHaveText(titles.slice(3));
  await expect(page.getByTestId('upnext-list-label')).toHaveCount(1);
  await withOnTheWay(page);
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveCount(2);
  // With 30 ahead in the list you're in, none of the next one shows yet (D1).
  await expect(page.getByTestId('upnext-way-label')).toHaveCount(0);
  await expect(page.getByTestId('np-from')).toContainText('3 of 8');
  // ✕ then Undo, on the suggestion and on the album's last song: each comes back as it was, where it was.
  const order = await rows.evaluateAll((els) => els.map((el) => `${el.getAttribute('data-track-id')}:${el.getAttribute('data-section')}`));
  for (const row of [rows.first(), page.locator('[data-testid="upnext-row"][data-section="list"]').last()]) {
    await page.waitForTimeout(350); // past the double-tap guard
    const id = (await row.getAttribute('data-track-id'))!;
    await row.getByTestId('upnext-remove').click();
    // (Up next shows 50 rows at most: the next one moves up into view.)
    await expect(page.locator(`[data-testid="upnext-row"][data-track-id="${id}"]`)).toHaveCount(0);
    await page.getByTestId('toast').filter({ hasText: 'Removed from queue' }).getByTestId('toast-action').click();
    await expect.poll(() => rows.evaluateAll((els) => els.map((el) => `${el.getAttribute('data-track-id')}:${el.getAttribute('data-section')}`))).toEqual(order);
  }
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

  // Its radio's first page joins it (a page is a batch, whatever its size); the next page is on the way.
  const q = await withOnTheWay(page);
  expect(q.context?.mode).toBe('radio');
  expect(q.list).toEqual([]);
  expect(q.seed?.source).toBe('ytmusic');
  expect(q.autoplay.every((t) => t.source === 'ytmusic')).toBe(true);
  const seedYt = q.seed!.id.replace(/^ytm:/, '');
  expect((await musicCalls(page)).filter((c) => c[0] === 'radio')).toEqual([
    ['radio', seedYt, null],
    ['radio', seedYt, `radio|${seedYt}|1`],
  ]);

  // A tapped autoplay track plays; the ones it jumped over and the ones after it stay, and the
  // radio goes on from it.
  await openNowPlaying(page);
  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const pick = q.autoplay[3];
  await rows.nth(3).locator('.row-main').click();
  await expect(page.getByTestId('np-title')).toHaveText(pick.title);
  await expect(page.getByTestId('upnext-autoplay-label').first()).toHaveText(`Vibe · like ${pick.title}`);
  const after = await queueState(page);
  expect(after.seed?.id).toBe(pick.id);
  expect(after.autoplay.map((t) => t.id)).toEqual([...q.autoplay.slice(0, 3), ...q.autoplay.slice(4)].map((t) => t.id));
  // Once the page on the way starts, the next one follows from it.
  const radios = async () => (await musicCalls(page)).filter((c) => c[0] === 'radio').map((c) => c[1]);
  while ((await radios()).length < 3) {
    const t = (await page.getByTestId('np-title').textContent())!;
    await page.getByTestId('np-next').click();
    await expect(page.getByTestId('np-title')).not.toHaveText(t);
  }
  expect(await radios()).toEqual([seedYt, seedYt, pick.id.replace(/^ytm:/, '')]);
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

test('repeat keeps the songs lined up: Repeat all and one move on with Next, and Undo works', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  const q = await withOnTheWay(page);
  // The radio's own suggestions, joined to the tapped song: the list Repeat all loops.
  const autoplay = q.autoplay.slice(0, q.nextStart - 1);
  await openNowPlaying(page);
  const repeat = page.getByTestId('np-repeat');
  const autoRows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'all');
  // The batch on the way goes, the list stays, and no more come while repeat is on.
  await expectStable(async () => (await queueState(page)).autoplay.length, 400);
  expect((await queueState(page)).autoplay.map((t) => t.id)).toEqual(autoplay.map((t) => t.id));
  expect((await queueState(page)).nextStart).toBe(-1);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(autoplay[0].title);

  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'one');
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(autoplay[1].title);

  // Undo of a removed autoplay song puts it back, repeat or not.
  const gone = (await autoRows.first().getAttribute('data-track-id'))!;
  await autoRows.first().getByTestId('upnext-remove').click();
  await expect(page.locator(`[data-testid="upnext-row"][data-track-id="${gone}"]`)).toHaveCount(0);
  await page.getByTestId('toast').filter({ hasText: 'Removed from queue' }).getByTestId('toast-action').click();
  await expect(autoRows.first()).toHaveAttribute('data-track-id', gone);

  // Back to off: everything still lined up, and a new batch on the way (D18).
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'off');
  const off = await withOnTheWay(page);
  expect(off.autoplay.slice(0, autoplay.length - 2).map((t) => t.id)).toEqual(autoplay.slice(2).map((t) => t.id));
});

test('with repeat on, a song you tap still gets its suggestions; a list you start loops by itself', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await openNowPlaying(page);
  const repeat = page.getByTestId('np-repeat');
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'all');
  await page.getByTestId('np-close').click();
  // A Home song with Repeat all: its suggestions, the loop.
  const title = (await visible(page, 'track-title').nth(2).textContent())!.trim();
  await visible(page, 'track-play').nth(2).click();
  const q = await withAutoplay(page);
  expect(q.seed?.title).toBe(title);
  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-title')).toHaveText('Queue · Repeat queue');
  // Repeat one goes on as repeat off does.
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'one');
  await expect(page.getByTestId('upnext-title')).toHaveText('Queue · Repeat song');
  await page.getByTestId('np-close').click();
  await visible(page, 'track-play').nth(3).click();
  await expect.poll(async () => (await queueState(page)).seed?.id).not.toBe(q.seed?.id);
  await withAutoplay(page);

  // A genre's Play with Repeat all: the genre loops, no suggestions after it.
  await openNowPlaying(page);
  await repeat.click();
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'all');
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(5).click();
  await visible(page, 'genre-play-all').click();
  await openNowPlaying(page);
  const first = (await page.getByTestId('np-title').textContent())!.trim();
  await toListEnd(page);
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"]')).toHaveCount(0);
  expect((await expectStable(() => queueState(page), 1500)).autoplay).toEqual([]);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(first);
});

test("Repeat one at a list's end: Next is off, as on the notification; Repeat all goes round", async ({ page }) => {
  await start(page);
  await openSettings(page);
  await page.getByTestId('autoplay-toggle').click();
  await expect(page.getByTestId('autoplay-toggle')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(5).click();
  await visible(page, 'genre-play-all').click();
  await openNowPlaying(page);
  const first = (await page.getByTestId('np-title').textContent())!.trim();
  await toListEnd(page);
  await expect(page.locator('[data-testid="upnext-row"]')).toHaveCount(0);
  const repeat = page.getByTestId('np-repeat');
  const next = page.getByTestId('np-next');
  await expect(next).toBeDisabled();
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'all');
  await expect(next).toBeEnabled();
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'one');
  await expect(next).toBeDisabled();
  await repeat.click();
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'all');
  await next.click();
  await expect(page.getByTestId('np-title')).toHaveText(first);
});

test('the next batch is on the way from the list\'s start, so going to the background adds nothing: playback goes on if Android closes the screen', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(5).click();
  await expect(visible(page, 'track-row').nth(3)).toBeVisible();
  await visible(page, 'genre-play-all').click();
  await expect.poll(async () => (await queueState(page)).list.length).toBeGreaterThan(6);
  // Far from its end, the next batch is there already.
  const q = await withOnTheWay(page);
  expect(q.nextStart).toBe(q.list.length + 1);
  // In the background: nothing more.
  await setVisibility(page, 'hidden');
  expect(await expectStable(() => queueState(page), 1500)).toEqual(q);
  await setVisibility(page, 'visible');
  // Up next shows the list, then as much on the way as fills it to 25 rows (D1); 50+ when there may be more.
  const shown = Math.min(q.list.length + q.autoplay.length, Math.max(25, q.list.length));
  await openNowPlaying(page);
  await expect(page.getByTestId('up-next').locator('.section-head')).toContainText(`${shown >= 50 ? '50+' : shown} up next`);
});

test("songs removed from Up next don't come back in later suggestions", async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await withAutoplay(page);
  await openNowPlaying(page);
  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const gone: string[] = [];
  // Remove all of the batch you're in (the one on the way can't be removed from)...
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    gone.push((await rows.first().getAttribute('data-track-id'))!);
    // A click on the button itself: the "Removed" toast's Undo may lie over the row by now.
    await rows.first().getByTestId('upnext-remove').dispatchEvent('click');
    await expect(page.locator(`[data-testid="upnext-row"][data-track-id="${gone[i]}"]`)).toHaveCount(0);
    // Past Up next's guard against a double tap removing two rows (REMOVE_GUARD_MS).
    await page.waitForTimeout(320);
  }
  // ...then the one on the way starts, and the batch after it brings none of them back.
  const before = (await queueState(page)).length;
  await page.getByTestId('np-next').click();
  await expect.poll(async () => (await queueState(page)).length).toBeGreaterThan(before);
  const after = await queueState(page);
  expect(after.autoplay.filter((t) => gone.includes(t.id))).toEqual([]);
});

test('with Autoplay off, a Home tap plays the feed on from that song instead of stopping after it', async ({ page }) => {
  await start(page);
  await openSettings(page);
  await page.getByTestId('autoplay-toggle').click();
  await expect(page.getByTestId('autoplay-toggle')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('tab-home').click();
  const titles = (await visible(page, 'track-title').allTextContents()).map((t) => t.trim());
  await visible(page, 'track-play').nth(2).click();
  await expect(page.getByTestId('mini-title')).toHaveText(titles[2]);
  const q = await queueState(page);
  expect(q.context?.mode).toBe('list');
  expect(q.list.slice(0, 3).map((t) => t.title)).toEqual(titles.slice(3, 6));
  expect(q.autoplay).toEqual([]);
  // A single song with nothing after it says why.
  await page.getByTestId('tab-genres').click();
  // The last tile of the Popular grid is a one-song genre once the grid is whole (it fills in
  // idle time): every genre the header counts.
  const genres = page.getByTestId('genre-grid');
  await expect(page.getByTestId('screen-genres').locator('.topbar-sub')).toHaveText(/^\d+ genres on the Jukebox$/);
  const n = Number((await page.getByTestId('screen-genres').locator('.topbar-sub').textContent())!.split(' ')[0]);
  await expect(genres.getByTestId('genre-tile')).toHaveCount(n);
  await genres.getByTestId('genre-tile').last().click();
  await expect(visible(page, 'track-row')).toHaveCount(1);
  await visible(page, 'track-play').first().click();
  await openNowPlaying(page);
  await expect(page.getByTestId('up-next')).toContainText('Vibe is off.');
});

test("offline, Up next's rows that can't play are dimmed, as in every list", async ({ page, backend }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await withAutoplay(page);
  await openNowPlaying(page);
  const rows = page.locator('[data-testid="upnext-row"]');
  await expect(rows.first()).not.toHaveClass(/\boff\b/);
  await setOffline(page, backend, true);
  await expect(rows.first()).toHaveClass(/\boff\b/);
  await setOffline(page, backend, false);
  await expect(rows.first()).not.toHaveClass(/\boff\b/);
});

test('a song from Home: shuffle mixes its suggestions, and off puts them back in order', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await withAutoplay(page);
  await openNowPlaying(page);
  const titles = page.locator('[data-testid="upnext-row"][data-section="autoplay"] .row-title');
  const before = (await titles.allTextContents()).map((t) => t.trim());
  expect(before.length).toBeGreaterThan(5);
  await page.getByTestId('np-shuffle').click();
  await expect.poll(async () => (await titles.allTextContents()).map((t) => t.trim())).not.toEqual(before);
  expect((await titles.allTextContents()).map((t) => t.trim()).sort()).toEqual(before.slice().sort());
  await page.getByTestId('np-shuffle').click();
  await expect.poll(async () => (await titles.allTextContents()).map((t) => t.trim())).toEqual(before);
});

test('with shuffle on, the queue reads "Queue · Shuffled" and still says how many are next', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await withAutoplay(page);
  await openNowPlaying(page);
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'true');
  const head = page.getByTestId('up-next').locator('.section-head');
  await expect(head).toContainText(/\d+ up next/);
  await expect(page.getByTestId('upnext-title')).toHaveText('Queue · Shuffled');
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('upnext-title')).toHaveText('Queue');
});

test('Shuffle and Repeat both show beside "Queue", whole, and never run into the count, on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await start(page);
  await visible(page, 'track-play').first().click();
  await withAutoplay(page);
  await openNowPlaying(page);
  await page.getByTestId('np-shuffle').click();
  await page.getByTestId('np-repeat').click();
  const title = page.getByTestId('upnext-title');
  await expect(title).toHaveText('Queue · Shuffled · Repeat queue');
  const count = page.getByTestId('up-next').locator('.section-head > .small');
  await expect(count).toHaveText(/up next/);
  const t = (await title.boundingBox())!;
  const c = (await count.boundingBox())!;
  expect(c.x - (t.x + t.width)).toBeGreaterThanOrEqual(12);
  // Nothing is cut off: the modes wrap under "Queue" instead.
  expect(await title.evaluate((el) => [...el.querySelectorAll('*')].every((e) => e.scrollWidth <= e.clientWidth + 1))).toBe(true);
  await expect(page.getByTestId('upnext-repeat')).toHaveCount(0);
});

test('"Added to queue · plays next" only when it does', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  const added = () => page.getByTestId('toast').last();
  await queueRow(page, 2);
  await expect(added()).toHaveText('Added to queue · plays next');
  // A second one plays after the first.
  await queueRow(page, 3);
  await expect(added()).toHaveText('Added to queue');
});

test('a track started before the Jukebox catalog has loaded still gets its autoplay once it does', async ({ page }) => {
  // The catalog (300-row pages) waits until let through; the Home feed loads as usual.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    const q = route.request().method() === 'POST' ? JSON.parse(route.request().postData() ?? '{}').structuredQuery : null;
    if (q?.limit === 300) await held;
    return route.fallback();
  });
  await page.goto('/');
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await page.waitForTimeout(500);
  expect((await queueState(page)).autoplay).toHaveLength(0);
  release();
  const q = await withAutoplay(page);
  expect(q.autoplay.length).toBeGreaterThanOrEqual(20);
});

test('the queue shows the whole list: what played folds under [+] Played, the playing track is marked in place, a tap on a played one plays it', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(5).click();
  await visible(page, 'genre-play-all').click();
  await openNowPlaying(page);
  const titles = [(await page.getByTestId('np-title').textContent())!.trim()];
  const next = page.getByTestId('np-next');
  for (let k = 0; k < 2; k++) {
    await next.click();
    await expect(page.getByTestId('np-title')).not.toHaveText(titles[k]);
    titles.push((await page.getByTestId('np-title').textContent())!.trim());
  }
  // Folded: the playing track comes right after it, with nothing played on show.
  const fold = page.getByRole('button', { name: 'Played, 2 tracks' });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(fold).toHaveText('Played · 2');
  await expect(page.getByTestId('upnext-played')).toHaveCount(0);
  await expect(page.locator('[data-testid="up-next"] ol > li').nth(1)).toHaveAttribute('data-testid', 'upnext-current-label');
  await expect(page.getByTestId('up-next').locator('.section-head')).toContainText(/^Queue\d+ up next$/);
  // Only the words are the button: a tap on the row's empty side does nothing.
  const b = (await fold.boundingBox())!;
  const row = (await page.locator('.upnext-fold').boundingBox())!;
  expect(b.width).toBeLessThan(row.width / 2);
  await page.mouse.click(row.x + row.width - 20, row.y + row.height / 2);
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  // Open: the two played, in the order they played, at full contrast, then the playing one.
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  const played = page.getByTestId('upnext-played');
  await expect(played.locator('.row-title')).toHaveText(titles.slice(0, 2));
  await expect(played.first().locator('.row-main')).toHaveCSS('opacity', '1');
  const cur = page.getByTestId('upnext-current');
  await expect(cur.locator('.row-title')).toHaveText(titles[2]);
  await expect(cur.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(cur.locator('.row-art-badge')).toBeVisible();
  expect(await page.locator('[data-testid="upnext-row"][data-section="list"]').count()).toBeGreaterThan(0);
  // It stays open for this list, also after closing Now Playing.
  await page.getByTestId('np-close').click();
  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-played')).toHaveCount(2);
  // A played one plays again from there: what was after it is ahead again.
  await page.getByTestId('upnext-played').first().locator('.row-main').click();
  await expect(page.getByTestId('np-title')).toHaveText(titles[0]);
  await expect(page.getByTestId('upnext-played')).toHaveCount(0);
  await expect(page.getByTestId('upnext-played-fold')).toHaveCount(0);
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"] .row-title').first()).toHaveText(titles[1]);
  // At the last song with Repeat all, the top it repeats from is there: the list's first song.
  await toListEnd(page);
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"]')).toHaveCount(0);
  const repeat = page.getByTestId('np-repeat');
  while ((await repeat.getAttribute('data-mode')) !== 'all') await repeat.click();
  await expect(page.getByTestId('upnext-played').first().locator('.row-title')).toHaveText(titles[0]);
  await expect(page.getByTestId('upnext-title')).toHaveText('Queue · Repeat queue');
  // A new list starts folded.
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(6).click();
  await visible(page, 'genre-play-all').click();
  await openNowPlaying(page);
  await next.click();
  await expect(page.getByTestId('upnext-played-fold')).toHaveAttribute('aria-expanded', 'false');
});

test('Previous twice, then shuffle on: the album songs after the playing one all stay in Up next, the two you went back over next, none moves into Played', async ({ page }) => {
  const titles = await playAlbum(page);
  const title = page.getByTestId('np-title');
  for (let k = 1; k <= 4; k++) {
    await page.getByTestId('np-next').click();
    await expect(title).toHaveText(titles[k]);
  }
  // Back to the third song (a Previous past a song's first seconds restarts it first).
  for (const k of [3, 2]) {
    await expect(async () => {
      await page.getByTestId('np-prev').click();
      await expect(title).toHaveText(titles[k], { timeout: 1000 });
    }).toPass();
  }
  const list = page.locator('[data-testid="upnext-row"][data-section="list"] .row-title');
  await expect(list).toHaveText(titles.slice(3));
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await expect(title).toHaveText(titles[2]);
  await expect(page.getByTestId('upnext-played-fold')).toHaveText('Played · 2');
  await page.getByTestId('upnext-played-fold').click();
  await expect(page.getByTestId('upnext-played').locator('.row-title')).toHaveText(titles.slice(0, 2));
  const after = (await list.allTextContents()).map((s) => s.trim());
  expect(after.slice(0, 2)).toEqual(titles.slice(3, 5));
  expect(after.sort()).toEqual(titles.slice(3).sort());
});

test("after an album's suggestions start, Repeat all loops them: no album song in Played, and Next past the last goes to the first suggestion", async ({ page }) => {
  const titles = await playAlbum(page);
  await toListEnd(page);
  const q0 = await withAutoplay(page, 5);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(q0.autoplay[0].title);
  await page.getByTestId('np-repeat').click();
  await expect(page.getByTestId('np-repeat')).toHaveAttribute('data-mode', 'all');
  // The album is behind the loop now: nothing of it is under Played (nor anywhere in the queue).
  const q = await withAutoplay(page, 5);
  const loop = [q.current!.title, ...q.autoplay.map((t) => t.title)];
  await expect(page.getByTestId('np-title')).toHaveText(loop[0]);
  const rows = page.locator('[data-testid="upnext-row"]');
  await expect.poll(async () => (await rows.locator('.row-title').allTextContents()).some((t) => titles.includes(t.trim()))).toBe(false);
  const fold = page.getByTestId('upnext-played-fold');
  if ((await fold.count()) > 0) {
    await fold.click();
    const played = (await page.getByTestId('upnext-played').locator('.row-title').allTextContents()).map((t) => t.trim());
    for (const t of titles) expect(played).not.toContain(t);
  }
  // Round the loop: the Next after the last suggestion is the first.
  const ahead = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  for (let n = await ahead.count(); n > 0; n = await ahead.count()) {
    await page.getByTestId('np-next').click();
    await expect(ahead).toHaveCount(n - 1);
  }
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(loop[0]);
});

test('turning shuffle off mid-album keeps every unheard song in Up next, in album order', async ({ page }) => {
  const titles = await playAlbum(page);
  const title = page.getByTestId('np-title');
  for (let k = 1; k <= 2; k++) {
    await page.getByTestId('np-next').click();
    await expect(title).toHaveText(titles[k]);
  }
  const list = page.locator('[data-testid="upnext-row"][data-section="list"] .row-title');
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await expect(title).toHaveText(titles[2]);
  await expect(list).toHaveCount(5);
  await page.getByTestId('np-next').click();
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'false');
  const now = (await title.textContent())!.trim();
  const heard = [titles[0], titles[1], titles[2], now];
  const unheard = titles.filter((t) => !heard.includes(t));
  expect(unheard).toHaveLength(4);
  await expect.poll(async () => (await list.allTextContents()).map((t) => t.trim())).toEqual(unheard);
});

test('Played is only what was heard: not the songs before the one tapped, nor what shuffle off puts behind', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(5).click();
  // The 4th song of the genre: the three before it weren't heard.
  await visible(page, 'track-play').nth(3).click();
  await openNowPlaying(page);
  const heard = [(await page.getByTestId('np-title').textContent())!.trim()];
  await expect(page.getByTestId('upnext-played-fold')).toHaveCount(0);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).not.toHaveText(heard[0]);
  heard.push((await page.getByTestId('np-title').textContent())!.trim());
  await expect(page.getByTestId('upnext-played-fold')).toHaveText('Played · 1');
  // Shuffle on, one more, shuffle off: list order again, and still only what was heard.
  await page.getByTestId('np-shuffle').click();
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).not.toHaveText(heard[1]);
  heard.push((await page.getByTestId('np-title').textContent())!.trim());
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'false');
  const fold = page.getByTestId('upnext-played-fold');
  if ((await fold.count()) > 0) {
    await fold.click();
    const titles = await page.getByTestId('upnext-played').locator('.row-title').allTextContents();
    expect(titles.length).toBeLessThanOrEqual(2);
    for (const t of titles) expect(heard).toContain(t.trim());
  }
});

test('a tap further down the queue plays that song now; the ones it jumped over stay next', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(5).click();
  await visible(page, 'genre-play-all').click();
  await openNowPlaying(page);
  const rows = page.locator('[data-testid="upnext-row"][data-section="list"] .row-title');
  const ahead = (await rows.allTextContents()).map((t) => t.trim());
  await page.locator('[data-testid="upnext-row"][data-section="list"] .row-main').nth(2).click();
  await expect(page.getByTestId('np-title')).toHaveText(ahead[2]);
  await expect(rows.first()).toHaveText(ahead[0]);
  await expect(rows.nth(1)).toHaveText(ahead[1]);
  await expect(rows.nth(2)).toHaveText(ahead[3]);
  // Nothing was heard but the first song and this one.
  await expect(page.getByTestId('upnext-played-fold')).toHaveText('Played · 1');
});

test('a long press on a queue row opens its menu, as in every list, and plays nothing', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(5).click();
  await visible(page, 'genre-play-all').click();
  await openNowPlaying(page);
  const playing = (await page.getByTestId('np-title').textContent())!.trim();
  const row = page.locator('[data-testid="upnext-row"][data-section="list"]').nth(1);
  await row.scrollIntoViewIfNeeded();
  const title = (await row.locator('.row-title').textContent())!.trim();
  const b = (await row.locator('.row-main').boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 40, y: b.y + b.height / 2, id: 1 }] });
  const menu = page.getByTestId('track-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.sheet-head .row-title')).toHaveText(title);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('np-title')).toHaveText(playing);
});

test("played songs get ↑ ↓ ✕: moves stay among them, the last one's ↓ plays it next, ✕ offers Undo", async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(5).click();
  await visible(page, 'genre-play-all').click();
  await openNowPlaying(page);
  const t = [(await page.getByTestId('np-title').textContent())!.trim()];
  for (let k = 0; k < 3; k++) {
    await page.getByTestId('np-next').click();
    await expect(page.getByTestId('np-title')).not.toHaveText(t[k]);
    t.push((await page.getByTestId('np-title').textContent())!.trim());
  }
  await page.getByTestId('upnext-played-fold').click();
  const played = page.getByTestId('upnext-played');
  const titles = played.locator('.row-title');
  await expect(titles).toHaveText(t.slice(0, 3));
  // Moves stay among the played: the first can't go up.
  await expect(played.first().getByTestId('upnext-up')).toBeDisabled();
  await expect(page.getByRole('button', { name: `Play ${t[1]}, played` })).toBeVisible();
  await page.getByRole('button', { name: `Move ${t[0]} down` }).click();
  await expect(titles).toHaveText([t[1], t[0], t[2]]);
  // ✕ offers Undo, which puts it back where it was.
  await page.waitForTimeout(350); // past the double-tap guard
  await page.getByRole('button', { name: `Remove ${t[0]} from queue` }).click();
  await expect(titles).toHaveText([t[1], t[2]]);
  await page.getByTestId('toast').filter({ hasText: 'Removed from queue' }).getByRole('button', { name: 'Undo' }).click();
  await expect(titles).toHaveText([t[1], t[0], t[2]]);
  // The last one's ↓ takes it past the playing song: it plays next.
  await page.waitForTimeout(350); // past the guard the ✕ above started
  await page.getByRole('button', { name: `Move ${t[2]} down` }).click();
  await expect(titles).toHaveText([t[1], t[0]]);
  await expect(page.locator('[data-testid="upnext-row"][data-section="list"] .row-title').first()).toHaveText(t[2]);
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(t[2]);
  // With shuffle on, no arrows here either; ✕ stays.
  await page.getByTestId('np-shuffle').click();
  await expect(played.first().getByTestId('upnext-remove')).toBeVisible();
  await expect(played.getByTestId('upnext-up')).toHaveCount(0);
});

test('held under "Queued by you", a song offers Remove from queue instead; elsewhere Add to queue; Undo puts it back', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await queueRow(page, 2);
  const queuedTitle = (await visible(page, 'track-title').nth(2).textContent())!.trim();
  const menu = page.getByTestId('track-menu');
  // On Home the same song's menu still adds (a row there is no place in the queue).
  await visible(page, 'track-more').nth(2).click();
  await expect(menu.getByTestId('menu-add-queue')).toBeVisible();
  await expect(menu.getByTestId('menu-remove-queue')).toHaveCount(0);
  await page.locator('.sheet-cancel button').click();
  await expect(menu).toBeHidden();
  await openNowPlaying(page);
  const cdp = await page.context().newCDPSession(page);
  const hold = async (row: Locator) => {
    await row.scrollIntoViewIfNeeded();
    const b = (await row.locator('.row-main').boundingBox())!;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 40, y: b.y + b.height / 2, id: 1 }] });
    await expect(menu).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  // A suggestion in the queue: Add to queue.
  await hold(page.locator('[data-testid="upnext-row"][data-section="autoplay"]').first());
  await expect(menu.getByTestId('menu-add-queue')).toBeVisible();
  await expect(menu.getByTestId('menu-remove-queue')).toHaveCount(0);
  await page.locator('.sheet-cancel button').click();
  await expect(menu).toBeHidden();
  // The queued row: Remove from queue, in Add to queue's place.
  const row = page.locator('[data-testid="upnext-row"][data-section="queued"]');
  await expect(row.locator('.row-title')).toHaveText(queuedTitle);
  await hold(row);
  await cdp.detach();
  await expect(menu.getByTestId('menu-add-queue')).toHaveCount(0);
  await menu.getByTestId('menu-remove-queue').click();
  await expect(row).toHaveCount(0);
  // Focus stays in Now Playing (TalkBack keeps its place), not back at the top of the page.
  await expect.poll(() => page.evaluate(() => { const a = document.activeElement; return a != null && a.closest('.np') != null && a.closest('.sheet') == null; })).toBe(true);
  await page.getByTestId('toast').filter({ hasText: 'Removed from queue' }).getByTestId('toast-action').click();
  await expect(row).toHaveCount(1);
  await expect(row.locator('.row-title')).toHaveText(queuedTitle);
});

test('a held queued row that starts playing while its menu is open: the menu closes, nothing is removed', async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await queueRow(page, 2);
  const queuedTitle = (await visible(page, 'track-title').nth(2).textContent())!.trim();
  await openNowPlaying(page);
  const row = page.locator('[data-testid="upnext-row"][data-section="queued"]');
  await row.scrollIntoViewIfNeeded();
  const b = (await row.locator('.row-main').boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + 40, y: b.y + b.height / 2, id: 1 }] });
  const menu = page.getByTestId('track-menu');
  await expect(menu.getByTestId('menu-remove-queue')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  // The playing song ends: the queued one plays now, and the menu for its old row goes.
  await fakeYt(page, 'end');
  await expect(page.getByTestId('np-title')).toHaveText(queuedTitle);
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('toast').filter({ hasText: 'Removed from queue' })).toHaveCount(0);
});

test.describe('the glow on a song just moved', () => {
  // How many rows glow at once, as often as the page can look (a frame), from now on.
  const watchGlow = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __glowMax: number };
      w.__glowMax = 0;
      const look = () => {
        w.__glowMax = Math.max(w.__glowMax, document.querySelectorAll('[data-testid="up-next"] .row.moved').length);
        requestAnimationFrame(look);
      };
      look();
    });
  const glowMax = (page: Page) => page.evaluate(() => (window as unknown as { __glowMax: number }).__glowMax);
  const glowing = (page: Page) => page.locator('[data-testid="up-next"] .row.moved');
  const autoRows = (page: Page) => page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  /** The page's clock now, and when the glow's fade on the moved row started, on the same clock. */
  const now = (page: Page) => page.evaluate(() => document.timeline.currentTime as number);
  const fadeStart = (page: Page) =>
    page.evaluate(() => document.getAnimations().find((a) => (a as CSSAnimation).animationName === 'row-glow')?.startTime ?? null);

  test('only the song just moved glows, at its new place, and a screen reader hears where; then it fades away', async ({ page }) => {
    await start(page);
    await page.getByTestId('track-play').first().click();
    await withAutoplay(page, 10);
    await openNowPlaying(page);
    await expect(autoRows(page).nth(9)).toBeVisible();
    const id = (await autoRows(page).nth(0).getAttribute('data-track-id'))!;
    await autoRows(page).nth(0).getByTestId('upnext-down').click();
    await expect(glowing(page)).toHaveCount(1);
    await expect(glowing(page)).toHaveAttribute('data-track-id', id);
    await expect(autoRows(page).nth(1)).toHaveAttribute('data-track-id', id);
    await expect(page.getByTestId('upnext-moved')).toHaveText(/^Moved to 2 of \d+$/);
    // The glow goes after about 1.5 s.
    await expect(glowing(page)).toHaveCount(0, { timeout: 3000 });
  });

  test('moves in quick succession: only the latest glows, the one before stops at once, and each glow starts from the top', async ({ page }) => {
    await start(page);
    await page.getByTestId('track-play').first().click();
    await withAutoplay(page, 12);
    await openNowPlaying(page);
    await expect(autoRows(page).nth(11)).toBeVisible();
    await watchGlow(page);
    // Twelve quick moves, different rows and the same row twice, up and down, no waiting between.
    const plan: [number, 'upnext-up' | 'upnext-down'][] = [[0, 'upnext-down'], [3, 'upnext-up'], [5, 'upnext-down'], [6, 'upnext-down'], [7, 'upnext-up'], [2, 'upnext-down'], [3, 'upnext-down'], [9, 'upnext-up'], [8, 'upnext-up'], [4, 'upnext-down'], [1, 'upnext-up'], [10, 'upnext-down']];
    let last = '';
    for (const [row, button] of plan) {
      last = (await autoRows(page).nth(row).getAttribute('data-track-id'))!;
      await autoRows(page).nth(row).getByTestId(button).click();
    }
    await expect(glowing(page)).toHaveCount(1);
    await expect(glowing(page)).toHaveAttribute('data-track-id', last);
    // Never two at once, in any frame of the burst.
    expect(await glowMax(page)).toBe(1);
    // A glow taken over mid-fade starts over: move again 0.7 s into a fade.
    await page.waitForTimeout(700);
    const again = (await autoRows(page).nth(4).getAttribute('data-track-id'))!;
    const before = await now(page);
    await autoRows(page).nth(4).getByTestId('upnext-down').click();
    await expect(glowing(page)).toHaveAttribute('data-track-id', again);
    // The fade started after the move, not 0.7 s before it: it started anew, however slow the machine.
    // (Its start time is null until its first frame.)
    await expect.poll(() => fadeStart(page)).toBeGreaterThanOrEqual(before);
    await expect(glowing(page)).toHaveCount(0, { timeout: 3000 });
    expect(await glowMax(page)).toBe(1);
  });
});

test('Undo after ✕ in the queue: the song back in its place glows as a moved one does, and the next move takes the glow over', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await withAutoplay(page, 10);
  await openNowPlaying(page);
  const auto = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const glowing = page.locator('[data-testid="up-next"] .row.moved');
  await expect(auto.nth(9)).toBeVisible();
  const id = (await auto.nth(2).getAttribute('data-track-id'))!;
  await auto.nth(2).getByTestId('upnext-remove').click();
  await page.getByTestId('toast').filter({ hasText: 'Removed from queue' }).getByTestId('toast-action').click();
  await expect(auto.nth(2)).toHaveAttribute('data-track-id', id);
  await expect(glowing).toHaveCount(1);
  await expect(glowing).toHaveAttribute('data-track-id', id);
  await expect(page.getByTestId('upnext-moved')).toHaveText(/^Back at 3 of \d+$/);
  // A move straight after: only the moved song glows now.
  await page.waitForTimeout(350); // past the removal's guard
  const other = (await auto.nth(5).getAttribute('data-track-id'))!;
  await auto.nth(5).getByTestId('upnext-down').click();
  await expect(glowing).toHaveCount(1);
  await expect(glowing).toHaveAttribute('data-track-id', other);
  await expect(glowing).toHaveCount(0, { timeout: 3000 });
});
