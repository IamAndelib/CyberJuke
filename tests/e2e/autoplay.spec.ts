import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { expectStable, musicCalls, openNowPlaying, openSearch, openSettings, setOffline, setVisibility, start, toListEnd } from '../helpers';
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
  // The artwork slightly dimmed; the text keeps its theme's contrast.
  const opacity = (sel: string) => rows.first().locator(sel).evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await opacity('.row-art')).toBeLessThan(1);
  expect(await opacity('.row-main')).toBe(1);
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

  // The album first: nothing more is asked for until it nears its end.
  const start = await expectStable(() => queueState(page), 1500);
  expect(start.context?.mode).toBe('list');
  expect(start.list.map((t) => t.title)).toEqual(titles.slice(1));
  expect(start.autoplay).toEqual([]);
  expect((await musicCalls(page)).filter((c) => c[0] === 'radio')).toHaveLength(0);

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
  // At its end: Global leads to Global, the first track's radio.
  const q = await withAutoplay(page, 5);
  expect(q.autoplay.every((t) => t.source === 'ytmusic' && /^Radio \d+$/.test(t.title))).toBe(true);
  expect((await musicCalls(page)).filter((c) => c[0] === 'radio')).toHaveLength(1);
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

  // A tapped autoplay track plays; the ones it jumped over and the ones after it stay, and the
  // radio goes on from it.
  await openNowPlaying(page);
  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const pick = q.autoplay[3];
  await rows.nth(3).locator('.row-main').click();
  await expect(page.getByTestId('np-title')).toHaveText(pick.title);
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveText(`Autoplay · similar to ${pick.title}`);
  const after = await queueState(page);
  expect(after.seed?.id).toBe(pick.id);
  expect(after.autoplay.map((t) => t.id)).toEqual([...q.autoplay.slice(0, 3), ...q.autoplay.slice(4)].map((t) => t.id));
  // Near their end, more follow from it.
  const radios = async () => (await musicCalls(page)).filter((c) => c[0] === 'radio').map((c) => c[1]);
  while ((await radios()).length < 2) {
    const t = (await page.getByTestId('np-title').textContent())!;
    await page.getByTestId('np-next').click();
    await expect(page.getByTestId('np-title')).not.toHaveText(t);
  }
  expect((await radios()).slice(0, 2)).toEqual([seedYt, pick.id.replace(/^ytm:/, '')]);
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
  const { autoplay } = await withAutoplay(page);
  await openNowPlaying(page);
  const repeat = page.getByTestId('np-repeat');
  const autoRows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'all');
  // Nothing goes, and no more come while repeat is on.
  await expectStable(async () => (await queueState(page)).autoplay.length, 400);
  expect((await queueState(page)).autoplay.map((t) => t.id)).toEqual(autoplay.map((t) => t.id));
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

  // Back to off: everything still lined up (autoplay tops up again once it runs low).
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'off');
  expect((await queueState(page)).autoplay.map((t) => t.id)).toEqual(autoplay.slice(2).map((t) => t.id));
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
  await expect(page.getByTestId('upnext-repeat')).toHaveText('Repeating the queue.');
  // Repeat one goes on as repeat off does.
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'one');
  await expect(page.getByTestId('upnext-repeat')).toHaveText('Repeating this song.');
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

test('going to the background, a reserve is lined up: playback goes on if Android closes the screen', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(5).click();
  await expect(visible(page, 'track-row').nth(3)).toBeVisible();
  await visible(page, 'genre-play-all').click();
  await expect.poll(async () => (await queueState(page)).list.length).toBeGreaterThan(6);
  // Far from its end: nothing yet.
  const { list } = await expectStable(() => queueState(page), 1000);
  expect((await queueState(page)).autoplay).toEqual([]);
  // In the background: enough for 50 ahead.
  await setVisibility(page, 'hidden');
  const q = await withAutoplay(page, 50 - list.length);
  expect(list.length + q.autoplay.length).toBe(50);
  // Up next shows 50 at most: it says there may be more.
  await openNowPlaying(page);
  await expect(page.getByTestId('up-next').locator('.section-head')).toContainText('50+ up next');
  await setVisibility(page, 'visible');
});

test("songs removed from Up next don't come back in later suggestions", async ({ page }) => {
  await start(page);
  await visible(page, 'track-play').first().click();
  await withAutoplay(page);
  await openNowPlaying(page);
  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const gone: string[] = [];
  // Remove them as they come: the refills that follow bring none of them back.
  for (let i = 0; i < 30; i++) {
    gone.push((await rows.first().getAttribute('data-track-id'))!);
    // A click on the button itself: the "Removed" toast's Undo may lie over the row by now.
    await rows.first().getByTestId('upnext-remove').dispatchEvent('click');
    await expect(page.locator(`[data-testid="upnext-row"][data-track-id="${gone[i]}"]`)).toHaveCount(0);
    await expect(rows.first()).toBeVisible();
    // Past Up next's guard against a double tap removing two rows (REMOVE_GUARD_MS).
    await page.waitForTimeout(320);
  }
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
  await expect(page.getByTestId('up-next')).toContainText('Autoplay is off.');
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
  await expect(page.getByTestId('upnext-repeat')).toHaveText('Repeating the queue.');
  // A new list starts folded.
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').nth(6).click();
  await visible(page, 'genre-play-all').click();
  await openNowPlaying(page);
  await next.click();
  await expect(page.getByTestId('upnext-played-fold')).toHaveAttribute('aria-expanded', 'false');
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
  await page.evaluate(() => (window as unknown as { __cyberjukeYt: { end(): void } }).__cyberjukeYt.end());
  await expect(page.getByTestId('np-title')).toHaveText(queuedTitle);
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('np-title')).toHaveText(queuedTitle);
  await expect(page.getByTestId('toast').filter({ hasText: 'Removed from queue' })).toHaveCount(0);
});
