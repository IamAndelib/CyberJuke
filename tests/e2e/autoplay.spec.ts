import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { expectStable, musicCalls, openNowPlaying, openSearch, openSettings, setVisibility, start } from '../helpers';
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
  expect(rb!.width).toBeCloseTo(48, 1);
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

  // A tapped autoplay track plays; the ones after it stay, and the radio goes on from it.
  await openNowPlaying(page);
  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const pick = q.autoplay[3];
  await rows.nth(3).locator('.row-main').click();
  await expect(page.getByTestId('np-title')).toHaveText(pick.title);
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveText(`Autoplay · similar to ${pick.title}`);
  const after = await queueState(page);
  expect(after.seed?.id).toBe(pick.id);
  expect(after.autoplay.map((t) => t.id)).toEqual(q.autoplay.slice(4).map((t) => t.id));
  // Near their end, more follow from it.
  const last = q.autoplay.at(-1)!;
  await rows.last().locator('.row-main').click();
  await expect(page.getByTestId('np-title')).toHaveText(last.title);
  await expect.poll(async () => (await musicCalls(page)).filter((c) => c[0] === 'radio').map((c) => c[1])).toEqual([seedYt, last.id.replace(/^ytm:/, '')]);
  expect((await withAutoplay(page)).seed?.id).toBe(last.id);
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
  await expect(page.getByTestId('upnext-repeat')).toHaveText('Then repeats from the top.');
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
  await page.locator('[data-testid="upnext-row"][data-section="list"] .row-main').last().click();
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
  await page.locator('[data-testid="upnext-row"][data-section="list"] .row-main').last().click();
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
