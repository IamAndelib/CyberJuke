import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { homeSettled, openLibrary, openNowPlaying, openSearch, seedStorage, setOffline, SETTINGS_KEY, start, toListEnd } from '../helpers';

/** Your own playlists: Library's Playlists section and a playlist's page (adding comes from the player, the menu and the queue). */

const FILE = 'cyberjuke.file:data/cyberjuke/playlists.json';

const tr = (n: number) => ({
  id: `post${n}`,
  ytId: `abcdefghij${n}`,
  title: `Song ${n}`,
  artist: 'Seeded Artist',
  genre: 'test',
  by: 'someone',
  postTitle: '',
  postUrl: '',
  createdAt: '2026-01-01T00:00:00Z',
  nsfw: false,
  artworkUrl: `https://i.ytimg.com/vi/abcdefghij${n}/hqdefault.jpg`,
});
const seeded = (playlists: unknown[]) => ({ [FILE]: { version: 1, playlists } });
const NIGHT = { id: 'pn', name: 'Night drive', created: 2, updated: 2, tracks: [tr(1), tr(2), tr(3)] };
const EMPTY = { id: 'pe', name: 'Road trip', created: 1, updated: 1, tracks: [] };

type Queue = { current: { id: string }; list: { id: string }[]; autoplay: unknown[]; mine: string[] };
const queueState = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => Queue }).__cyberjukeQueue());
const titles = (page: Page) => page.getByTestId('screen-playlist').getByTestId('track-title');
const saved = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), FILE);

/** The Global album "Night Owl" from its Play, in Now Playing; returns its song ids. */
async function playNightOwl(page: Page): Promise<string[]> {
  await openSearch(page);
  await page.getByTestId('search-input').fill('Night Owl');
  await page.getByTestId('mode-global').click();
  await page.getByTestId('filter-albums').click();
  await page.getByTestId('music-open').first().click();
  await expect(page.getByTestId('screen-album').getByTestId('track-row')).toHaveCount(8);
  await page.getByTestId('album-play').click();
  await openNowPlaying(page);
  const q = await queueState(page);
  return [q.current.id, ...q.list.map((t) => t.id)];
}

/** ⋯ → Add to queue on these Home songs (0-based), back in Now Playing; returns the ids of the songs you queued. */
async function queueFromHome(page: Page, rows: number[]): Promise<string[]> {
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-home').click();
  for (const n of rows) {
    await page.locator('[data-testid="track-more"]:visible').nth(n).click();
    await page.getByTestId('menu-add-queue').click();
    await expect(page.locator('.sheet-wrap.open')).toHaveCount(0);
  }
  await openNowPlaying(page);
  return (await queueState(page)).mine;
}

/** Next, once the next song plays. */
async function next(page: Page): Promise<void> {
  const now = (await page.getByTestId('upnext-current').getAttribute('data-track-id'))!;
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('upnext-current')).not.toHaveAttribute('data-track-id', now);
}

/** Save queue as playlist, as "Saved"; returns the saved ids. */
async function saveIds(page: Page, count: number): Promise<string[]> {
  await page.getByTestId('upnext-save').click();
  await expect(page.getByTestId('name-sheet')).toContainText(`With ${count} songs`);
  await page.getByTestId('name-input').fill('Saved');
  await page.getByTestId('name-ok').click();
  await expect(page.getByTestId('toast').last()).toContainText('Saved as Saved');
  return ((await saved(page)).playlists[0].tracks as { id: string }[]).map((t) => t.id);
}

async function openPlaylist(page: Page, name: string) {
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-playlist').filter({ hasText: name }).click();
  await expect(page.getByTestId('screen-playlist')).toBeVisible();
  // A tap where the row was, this soon, is the opening tap's double (nav.ts OPEN_GUARD_MS).
  await page.waitForTimeout(350);
}

test('with no playlists Library says so; New playlist names one and opens it, empty, and it is there after a restart', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('lib-playlists-empty')).toContainText('No playlists yet');
  await page.getByTestId('lib-make-playlist').click();
  const sheet = page.getByTestId('name-sheet');
  await expect(sheet).toContainText('New playlist');
  // The field has focus, so the keyboard comes up for typing at once.
  await expect(page.getByTestId('name-input')).toBeFocused();
  await expect(page.getByTestId('name-ok')).toBeDisabled();
  await page.getByTestId('name-input').fill('   ');
  await expect(page.getByTestId('name-ok')).toBeDisabled();
  await page.getByTestId('name-input').fill('  Road   trip ');
  await page.getByTestId('name-ok').click();
  await expect(page.getByTestId('screen-playlist')).toBeVisible();
  await expect(page.getByTestId('pl-title')).toHaveText('Road trip');
  await expect(page.getByTestId('pl-empty')).toContainText('No songs yet');
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await page.reload();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('lib-playlist-name')).toHaveText(['Road trip']);
  await expect(page.getByTestId('lib-playlist')).toContainText('0 songs');
});

test.describe('a playlist', () => {
  test.beforeEach(async ({ page }) => {
    await seedStorage(page, seeded([NIGHT, EMPTY]));
    await page.goto('/');
  });

  test('Library lists them newest first, under its lists; a row opens the page, whose songs play as "Playing from" it', async ({ page }) => {
    await page.getByTestId('tab-library').click();
    await expect(page.getByTestId('lib-playlist-name')).toHaveText(['Night drive', 'Road trip']);
    await expect(page.getByTestId('lib-playlist').first()).toContainText('3 songs');
    await expect(page.getByTestId('lib-new-playlist')).toBeVisible();
    await openPlaylist(page, 'Night drive');
    await expect(page.getByTestId('pl-count')).toHaveText('Playlist · 3 songs');
    await expect(titles(page)).toHaveText(['Song 1', 'Song 2', 'Song 3']);
    await page.getByTestId('pl-list').getByTestId('track-play').nth(1).click();
    await expect(page.getByTestId('mini-title')).toHaveText('Song 2');
    await openNowPlaying(page);
    await expect(page.getByTestId('now-playing')).toContainText('Playing from Night drive');
    const q = await page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => { list: { title: string }[] } }).__cyberjukeQueue());
    expect(q.list.map((t) => t.title)).toEqual(['Song 3']);
  });

  test('a cover is the first four covers, a note in each square without one; an empty playlist is its icon', async ({ page }) => {
    await page.getByTestId('tab-library').click();
    const night = page.getByTestId('lib-playlist').filter({ hasText: 'Night drive' });
    await expect(night.locator('.mosaic .art')).toHaveCount(3);
    await expect(night.getByTestId('mosaic-note')).toHaveCount(1);
    await expect(page.getByTestId('lib-playlist').filter({ hasText: 'Road trip' }).locator('.mosaic-empty')).toHaveCount(1);
    await openPlaylist(page, 'Night drive');
    await expect(page.getByTestId('screen-playlist').locator('.album-cover').getByTestId('mosaic-note')).toHaveCount(1);
  });

  test('the grid button shows Library as tiles, three to a row, and it stays so after a restart; a tile opens its page', async ({ page }) => {
    await page.getByTestId('tab-library').click();
    await expect(page.getByTestId('lib-layout')).toHaveAccessibleName('Show as a grid');
    await page.getByTestId('lib-layout').click();
    await expect(page.getByTestId('lib-layout')).toHaveAccessibleName('Show as a list');
    const tops = async (id: string) => (await page.getByTestId(id).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top))));
    const lists = [...(await tops('lib-liked')), ...(await tops('lib-recent'))];
    expect(new Set(lists).size).toBe(1);
    const covers = await tops('lib-playlist');
    expect(covers).toHaveLength(2);
    expect(covers[0]).toBe(covers[1]);
    await expect(page.getByTestId('lib-playlist-name')).toHaveText(['Night drive', 'Road trip']);
    // Every tile is one framed card with its shadow, as cover cards are elsewhere; a cover's own
    // squares have none (it would draw a line inside the cover).
    const shadow = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(await shadow('.lib-grid .lib-cell > .lib-tile')).not.toBe('none');
    expect(await shadow('.lib-grid .lib-cell > .mosaic')).not.toBe('none');
    expect(await shadow('.lib-grid .mosaic > .art')).toBe('none');
    await page.reload();
    await page.getByTestId('tab-library').click();
    await expect(page.getByTestId('screen-library').locator('.lib-grid')).toHaveCount(2);
    await page.getByTestId('lib-liked').click();
    await expect(page.getByTestId('screen-liked')).toBeVisible();
  });

  test('Edit songs moves them with ↑ ↓ and takes one out with ✕ (Undo puts it back); Done ends it, and it is kept', async ({ page }) => {
    await openPlaylist(page, 'Night drive');
    await page.getByTestId('pl-more').click();
    await page.getByTestId('pl-edit').click();
    const rows = page.getByTestId('pl-edit-row');
    await expect(rows.first().getByTestId('pl-up')).toBeDisabled();
    await expect(rows.last().getByTestId('pl-down')).toBeDisabled();
    await rows.nth(2).getByTestId('pl-up').click();
    await expect(titles(page)).toHaveText(['Song 1', 'Song 3', 'Song 2']);
    await rows.first().getByTestId('pl-down').click();
    await expect(titles(page)).toHaveText(['Song 3', 'Song 1', 'Song 2']);
    await rows.nth(1).getByTestId('pl-remove').click();
    await expect(titles(page)).toHaveText(['Song 3', 'Song 2']);
    await expect(page.getByTestId('toast').last()).toContainText('Removed from Night drive');
    await page.getByTestId('toast').last().getByRole('button', { name: 'Undo' }).click();
    await expect(titles(page)).toHaveText(['Song 3', 'Song 1', 'Song 2']);
    await rows.nth(2).getByTestId('pl-remove').click();
    await page.getByTestId('pl-done').click();
    await expect(page.getByTestId('pl-edit-row')).toHaveCount(0);
    await expect(titles(page)).toHaveText(['Song 3', 'Song 1']);
    await expect.poll(async () => (await saved(page))?.playlists?.find((p: { id: string }) => p.id === 'pn')?.tracks.map((t: { title: string }) => t.title)).toEqual(['Song 3', 'Song 1']);
  });

  test('Rename takes a new name (not an empty one); Delete asks first, then the playlist goes with Undo, which brings it back with its songs', async ({ page }) => {
    await openPlaylist(page, 'Night drive');
    await page.getByTestId('pl-more').click();
    await page.getByTestId('pl-rename').click();
    await expect(page.getByTestId('name-input')).toHaveValue('Night drive');
    await expect(page.getByTestId('name-input')).toBeFocused();
    await page.getByTestId('name-input').fill('');
    await expect(page.getByTestId('name-ok')).toBeDisabled();
    await page.getByTestId('name-input').fill('Late night drive');
    await page.getByTestId('name-input').press('Enter');
    await expect(page.getByTestId('pl-title')).toHaveText('Late night drive');
    await page.getByTestId('pl-more').click();
    await page.getByTestId('pl-delete').click();
    const confirm = page.getByTestId('confirm-sheet');
    await expect(confirm).toContainText('Delete Late night drive?');
    await expect(confirm).toContainText('Its 3 songs stay wherever else they are: Liked, other playlists, the Jukebox.');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('screen-library')).toBeVisible();
    await expect(page.getByTestId('lib-playlist-name')).toHaveText(['Road trip']);
    const toast = page.getByTestId('toast').filter({ hasText: 'Deleted Late night drive' });
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('lib-playlist-name')).toHaveText(['Late night drive', 'Road trip']);
    await page.getByTestId('lib-playlist').filter({ hasText: 'Late night drive' }).click();
    await expect(titles(page)).toHaveCount(3);
  });

  test('Undo after ✕ in Edit songs: the song comes back in its place and glows for a moment', async ({ page }) => {
    await openPlaylist(page, 'Night drive');
    await page.getByTestId('pl-more').click();
    await page.getByTestId('pl-edit').click();
    const rows = page.getByTestId('pl-edit-row');
    await rows.nth(1).getByTestId('pl-remove').click();
    await expect(titles(page)).toHaveText(['Song 1', 'Song 3']);
    await page.getByTestId('toast').last().getByRole('button', { name: 'Undo' }).click();
    await expect(titles(page)).toHaveText(['Song 1', 'Song 2', 'Song 3']);
    await expect(page.locator('[data-testid="pl-edit-row"].moved')).toHaveCount(1);
    await expect(rows.nth(1)).toHaveClass(/\bmoved\b/);
    await expect(page.locator('[data-testid="pl-edit-row"].moved')).toHaveCount(0, { timeout: 3000 });
  });

  test('Here searches the playlist; an empty one says how to add songs', async ({ page }) => {
    await openPlaylist(page, 'Road trip');
    await expect(page.getByTestId('pl-empty')).toContainText('Add songs with');
    await page.getByTestId('playlist-back').click();
    await openLibrary(page, 'liked');
    await page.getByTestId('liked-back').click();
    await openPlaylist(page, 'Night drive');
    await page.getByTestId('search-fab').click();
    await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'Search in Night drive');
  });
});

test.describe('adding songs', () => {
  test('with no playlists, ≡+ opens New playlist with the song; you stay in Now Playing, and Undo takes the song out but keeps the playlist', async ({ page }) => {
    await start(page);
    const title = (await page.getByTestId('track-title').first().textContent())!.trim();
    await page.getByTestId('track-play').first().click();
    await openNowPlaying(page);
    await page.getByTestId('np-add-playlist').click();
    const sheet = page.getByTestId('name-sheet');
    await expect(sheet).toContainText('New playlist');
    await expect(sheet).toContainText(`With ${title}`);
    await page.getByTestId('name-input').fill('Road trip');
    await page.getByTestId('name-ok').click();
    await expect(page.getByTestId('toast').last()).toContainText('Added to Road trip');
    await expect(page.getByTestId('now-playing')).toHaveClass(/open/);
    await page.getByTestId('toast').last().getByRole('button', { name: 'Undo' }).click();
    await page.getByTestId('np-close').click();
    await page.getByTestId('tab-library').click();
    await expect(page.getByTestId('lib-playlist')).toHaveText([/Road trip0 songs/]);
  });

  test('a song’s ⋯ has Add to playlist: the sheet adds it, and then reads "Already in it" for that playlist', async ({ page }) => {
    await seedStorage(page, seeded([NIGHT, EMPTY]));
    await start(page);
    const title = (await page.getByTestId('track-title').first().textContent())!.trim();
    await page.getByTestId('track-more').first().click();
    await page.getByTestId('menu-add-playlist').click();
    const sheet = page.getByTestId('add-to-playlist');
    await expect(sheet).toContainText(`${title} ·`);
    await expect(sheet.getByTestId('pl-pick-new')).toBeVisible();
    await sheet.getByTestId('pl-pick').filter({ hasText: 'Road trip' }).click();
    await expect(page.getByTestId('toast').last()).toContainText('Added to Road trip');
    await page.getByTestId('track-more').first().click();
    await page.getByTestId('menu-add-playlist').click();
    // The one just added to comes first, and has it.
    const first = sheet.getByTestId('pl-pick').first();
    await expect(first).toContainText('Road trip');
    await expect(first).toContainText('Already in it');
    await expect(first).toBeDisabled();
    await expect(sheet.getByTestId('pl-pick').nth(1)).toBeEnabled();
  });

  test('Save queue as playlist saves the queue as it shows, played, playing and up next, with shuffle and repeat on', async ({ page }) => {
    await seedStorage(page, seeded([]));
    await start(page);
    await page.getByTestId('track-play').nth(2).click();
    await openNowPlaying(page);
    await page.getByTestId('np-shuffle').click();
    await page.getByTestId('np-repeat').click();
    await expect(page.getByTestId('upnext-title')).toHaveText('Queue · Shuffled · Repeat queue');
    const q = await page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => { current: { id: string }; previous: { id: string }[]; upNext: { id: string }[] } }).__cyberjukeQueue());
    expect((await page.getByTestId('upnext-save').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByTestId('upnext-save').click();
    await expect(page.getByTestId('name-sheet')).toContainText(/With \d+ songs/);
    await page.getByTestId('name-input').fill('Saved queue');
    await page.getByTestId('name-ok').click();
    await expect(page.getByTestId('toast').last()).toContainText('Saved as Saved queue');
    const file = await saved(page);
    const ids = (file.playlists[0].tracks as { id: string }[]).map((t) => t.id);
    expect(ids[0]).toBe(q.current.id);
    expect(ids.length).toBeGreaterThan(1);
  });

  test("after an album's suggestions start, Save queue as playlist saves the list you're in", async ({ page }) => {
    await page.goto('/');
    await openSearch(page);
    await page.getByTestId('search-input').fill('Night Owl');
    await page.getByTestId('mode-global').click();
    await page.getByTestId('filter-albums').click();
    await page.getByTestId('music-open').first().click();
    await page.getByTestId('album-play').click();
    await openNowPlaying(page);
    await toListEnd(page);
    const last = (await page.getByTestId('np-title').textContent())!;
    await page.getByTestId('np-next').click();
    await expect(page.getByTestId('np-title')).not.toHaveText(last);
    // Read what the list is once we are in it, not before (a refill in between could change it).
    const n = (await queueState(page)).autoplay.length + 1; // the song playing is the list's first
    expect(n).toBeGreaterThan(1);
    await page.getByTestId('upnext-save').click();
    await expect(page.getByTestId('name-sheet')).toContainText(`With ${n} songs`);
  });

  test('with shuffle on, a tap on the last of the suggestions moves on to all of them: Save queue as playlist saves every one', async ({ page }) => {
    await page.goto('/');
    await openSearch(page);
    await page.getByTestId('search-input').fill('Night Owl');
    await page.getByTestId('mode-global').click();
    await page.getByTestId('filter-albums').click();
    await page.getByTestId('music-open').first().click();
    await page.getByTestId('album-play').click();
    await openNowPlaying(page);
    await toListEnd(page);
    const autos = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
    await expect(autos.first()).toBeVisible();
    const n = await autos.count();
    expect(n).toBeGreaterThan(1);
    await page.getByTestId('np-shuffle').click();
    // The batch's last song in list order (shuffled, it plays anywhere in the batch).
    const last = Math.max(...(await autos.evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-index'))))));
    const row = page.locator(`[data-testid="upnext-row"][data-index="${last}"]`);
    const id = (await row.getAttribute('data-track-id'))!;
    await row.locator('.row-main').click();
    await expect(page.getByTestId('upnext-current')).toHaveAttribute('data-track-id', id);
    await page.getByTestId('upnext-save').click();
    await expect(page.getByTestId('name-sheet')).toContainText(`With ${n} songs`);
  });

  test("with shuffle on, a tap on a suggestion keeps the album's songs it jumped over: shuffle off still has them in Up next", async ({ page }) => {
    await page.goto('/');
    await openSearch(page);
    await page.getByTestId('search-input').fill('Night Owl');
    await page.getByTestId('mode-global').click();
    await page.getByTestId('filter-albums').click();
    await page.getByTestId('music-open').first().click();
    await page.getByTestId('album-play').click();
    await openNowPlaying(page);
    const autos = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
    const list = page.locator('[data-testid="upnext-row"][data-section="list"]');
    // Next until the suggestions come, with some of the album still ahead.
    while (!(await autos.count())) {
      const title = (await page.getByTestId('np-title').textContent())!;
      await page.getByTestId('np-next').click();
      await expect(page.getByTestId('np-title')).not.toHaveText(title);
    }
    const left = await list.count();
    expect(left).toBeGreaterThan(0);
    await page.getByTestId('np-shuffle').click();
    const last = Math.max(...(await autos.evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-index'))))));
    const row = page.locator(`[data-testid="upnext-row"][data-index="${last}"]`);
    const id = (await row.getAttribute('data-track-id'))!;
    await row.locator('.row-main').click();
    await expect(page.getByTestId('upnext-current')).toHaveAttribute('data-track-id', id);
    await page.getByTestId('np-shuffle').click();
    await expect(list).toHaveCount(left);
  });

  /** Night Owl with Repeat all: two Home songs queued after song 1, heard, then the loop back to song 1 takes them out of the queue. */
  async function queuedThroughLoop(page: Page): Promise<{ album: string[]; mine: string[] }> {
    await page.goto('/');
    const album = await playNightOwl(page);
    const repeat = page.getByTestId('np-repeat');
    while ((await repeat.getAttribute('data-mode')) !== 'all') await repeat.click();
    await next(page);
    const mine = await queueFromHome(page, [0, 1]);
    expect(mine).toHaveLength(2);
    expect(album).not.toContain(mine[0]);
    await next(page);
    await next(page);
    await toListEnd(page);
    await next(page);
    await expect(page.getByTestId('upnext-current')).toHaveAttribute('data-track-id', album[0]);
    expect((await queueState(page)).mine).toEqual([]);
    return { album, mine };
  }

  test('a song you removed and then queued again is saved like any song you queued', async ({ page }) => {
    await page.goto('/');
    const album = await playNightOwl(page);
    const repeat = page.getByTestId('np-repeat');
    while ((await repeat.getAttribute('data-mode')) !== 'all') await repeat.click();
    await next(page);
    const [first] = await queueFromHome(page, [0]);
    await page.locator(`[data-testid="upnext-row"][data-section="queued"][data-track-id="${first}"]`).getByTestId('upnext-remove').click();
    await expect(page.locator('[data-section="queued"]')).toHaveCount(0);
    const mine = await queueFromHome(page, [0, 1]);
    expect(mine[0]).toBe(first);
    await next(page);
    await next(page);
    await toListEnd(page);
    await next(page);
    await expect(page.getByTestId('upnext-current')).toHaveAttribute('data-track-id', album[0]);
    expect(await saveIds(page, 10)).toEqual([album[0], album[1], ...mine, ...album.slice(2)]);
  });

  test('Save queue as playlist keeps the songs you queued after the album repeats: played through the loop, it saves all 10', async ({ page }) => {
    const { album, mine } = await queuedThroughLoop(page);
    expect(await saveIds(page, 10)).toEqual([album[0], album[1], ...mine, ...album.slice(2)]);
  });

  test('after a new album is tapped, Save queue as playlist leaves out the songs you queued and heard before it, not the one still to come', async ({ page }) => {
    const { album } = await queuedThroughLoop(page);
    const [later] = await queueFromHome(page, [2]);
    await page.getByTestId('np-close').click();
    await playNightOwl(page);
    expect(await saveIds(page, 9)).toEqual([album[0], later, ...album.slice(1)]);
  });

  test('a tap refused offline starts nothing: Save queue as playlist still keeps the songs you queued that left with the loop', async ({ page, backend }) => {
    const { album, mine } = await queuedThroughLoop(page);
    await page.getByTestId('np-close').click();
    await page.getByTestId('tab-home').click();
    await setOffline(page, backend, true);
    await page.getByTestId('track-play').first().click({ force: true });
    await expect(page.getByTestId('toast').last()).toHaveText('No carrier. Connect to play.');
    await setOffline(page, backend, false);
    await openNowPlaying(page);
    await expect(page.getByTestId('upnext-current')).toHaveAttribute('data-track-id', album[0]);
    expect(await saveIds(page, 10)).toEqual([album[0], album[1], ...mine, ...album.slice(2)]);
  });

  test("once an album's suggestions play, Save queue as playlist keeps the songs you queued during the album, first", async ({ page }) => {
    await page.goto('/');
    await playNightOwl(page);
    await next(page);
    const mine = await queueFromHome(page, [0, 1]);
    await next(page);
    await next(page);
    await toListEnd(page);
    await next(page);
    const q = await queueState(page);
    const n = q.autoplay.length + 1;
    expect(n).toBeGreaterThan(1);
    expect((await saveIds(page, n + 2)).slice(0, 3)).toEqual([...mine, q.current.id]);
  });

  test('Save queue as playlist saves the whole list, not only the 101 songs Up next shows', async ({ page, backend }) => {
    // Autoplay off: a tap on Home plays its whole feed as a list (hundreds of songs).
    await seedStorage(page, { ...seeded([]), [SETTINGS_KEY]: { autoplay: false } });
    await start(page);
    // The whole Jukebox is in (until then a tap plays the page shown, 25 songs).
    await homeSettled(page, backend);
    await page.getByTestId('track-play').nth(2).click();
    await openNowPlaying(page);
    const current = (await page.getByTestId('np-title').textContent())!.trim();
    await page.getByTestId('upnext-save').click();
    await page.getByTestId('name-input').fill('Everything');
    await page.getByTestId('name-ok').click();
    await expect(page.getByTestId('toast').last()).toContainText('Saved as Everything');
    const tracks = (await saved(page)).playlists[0].tracks as { title: string }[];
    expect(tracks.length).toBeGreaterThan(102);
    // In list order: the two songs above the one tapped come first.
    expect(tracks[2].title).toBe(current);
  });

  test('≡+ and ♥ are drawn on the same rows: their tops and bottoms line up', async ({ page }) => {
    await start(page);
    await page.getByTestId('track-play').first().click();
    await openNowPlaying(page);
    const box = (id: string) => page.getByTestId(id).locator('svg path').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
    });
    expect(await box('np-add-playlist')).toEqual(await box('np-like'));
  });

  test('≡+ and ♥ sit on the artist’s line, below the title, so a long title has room', async ({ page }) => {
    await start(page);
    await page.getByTestId('track-play').first().click();
    await openNowPlaying(page);
    const box = (id: string) => page.getByTestId(id).locator('svg').first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    const artist = await page.getByTestId('np-artist').evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    const title = await page.getByTestId('np-title').evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    for (const id of ['np-add-playlist', 'np-like']) {
      // Clear of the title's line (beside it they crowded a long, scrolling title), within the artist's.
      const b = await box(id);
      expect(b.top).toBeGreaterThanOrEqual(title.bottom);
      expect(b.bottom).toBeLessThanOrEqual(artist.bottom);
    }
  });
});
