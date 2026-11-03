import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { openLibrary, openNowPlaying, seedStorage, start } from '../helpers';

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

const titles = (page: Page) => page.getByTestId('screen-playlist').getByTestId('track-title');
const saved = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), FILE);

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

  test('Rename takes a new name (not an empty one); Delete asks first, then the playlist goes and Back is Library', async ({ page }) => {
    await openPlaylist(page, 'Night drive');
    await page.getByTestId('pl-more').click();
    await page.getByTestId('pl-rename').click();
    await expect(page.getByTestId('name-input')).toHaveValue('Night drive');
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
    await expect(page.getByTestId('upnext-repeat')).toBeVisible();
    const q = await page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => { current: { id: string }; previous: { id: string }[]; upNext: { id: string }[] } }).__cyberjukeQueue());
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
});
