import { expect, musicFolder, test, type FakeLocalFolder } from '../fixtures';
import { openLibrary, openNowPlaying, openSearch, openSettings, saved, seedStorage, setOffline } from '../helpers';

/**
 * Local music (Settings → Local music, Library → Local) on the fake JukeLocal: the folder
 * picker is a list of picks, a look through a folder takes `scanMs`, and the songs play as
 * silent MP3s from the page's own origin.
 */

const MUSIC = musicFolder();
const ALBUMS: FakeLocalFolder = { id: 'tree:albums', name: 'SD card › Albums', songs: [{ hex: '00000000000000a1', title: 'Card one', artist: 'Ana Tape', album: 'Cellar' }, { hex: '00000000000000a2', title: 'Card two', artist: 'Ana Tape', album: 'Cellar' }] };
/** Local's titles in the default order: by title, the untagged song last. */
const BY_TITLE = ['Music song A', 'Music song D', 'Music song G', 'Music song J', 'Music song M', 'voice memo 6'];

const localOn = (page: Parameters<typeof seedStorage>[0], more: Record<string, unknown> = {}) =>
  seedStorage(page, { 'CapacitorStorage.settings': { localMusic: true, version: 3 }, ...more });
const titles = (page: Parameters<typeof seedStorage>[0]) => page.getByTestId('local-list').getByTestId('track-title');
const fake = (page: Parameters<typeof seedStorage>[0]) =>
  page.evaluate(() => (window as unknown as { __localFake: { added: string[]; removed: string[]; disabled: number } }).__localFake);

test.describe('turning it on', () => {
  test.use({ localOptions: { picks: [MUSIC], scanMs: 400 } });

  test('opens the picker; the folder is looked through, its songs show under Library → Local, and the sort is remembered', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    const card = page.getByTestId('local-card');
    await expect(card.getByTestId('local-folder')).toHaveCount(0);
    await card.getByTestId('local-toggle').click();
    await expect(card.getByTestId('local-toggle')).toHaveAttribute('aria-checked', 'true');
    const state = card.getByTestId('local-folder').getByTestId('local-folder-state');
    await expect(state).toHaveText(/^Looking… \d+ songs? so far$/);
    await expect(state).toHaveText('6 songs');
    await expect(card.getByTestId('local-folder')).toContainText('Music');

    await page.getByTestId('tab-library').click();
    await expect(page.getByTestId('lib-local')).toContainText('6 songs · on this phone');
    await openLibrary(page, 'local');
    await expect(titles(page)).toHaveText(BY_TITLE);
    // In Local itself no "On phone" tag; the album is on the meta line.
    await expect(page.getByTestId('local-list').getByTestId('local-tag')).toHaveCount(0);
    await expect(page.getByTestId('local-list').getByTestId('track-row').first()).toContainText('Attic');
    // Albums: a grid of covers, A–Z; an album plays in track order; its artist opens the artist.
    await page.getByTestId('local-view-albums').click();
    await expect(page.getByTestId('local-albums').getByTestId('local-album')).toHaveText(['AtticAna Tape · 2001', 'BasementZed Loop · 2009', 'Unknown album1 song']);
    await page.getByTestId('local-album').first().click();
    await expect(page.getByTestId('screen-local-album')).toBeVisible();
    // A tap right where the card was, this soon, is a double tap's second half (nav.ts OPEN_GUARD_MS).
    await page.waitForTimeout(350);
    const albumTitles = page.getByTestId('local-album-list').getByTestId('track-title');
    await expect(albumTitles).toHaveText(['Music song M', 'Music song G', 'Music song A']);
    await page.getByTestId('album-play').click();
    await expect(page.getByTestId('mini-title')).toHaveText('Music song M');
    await page.getByTestId('album-artist').click();
    await expect(page.getByTestId('screen-local-artist')).toContainText('Ana Tape');
    await expect(page.getByTestId('local-artist-albums').getByTestId('local-album-title')).toHaveText(['Attic']);
    await expect(page.getByTestId('local-artist-songs').getByTestId('track-title')).toHaveText(['Music song A', 'Music song G', 'Music song M']);
    await page.getByTestId('local-artist-back').click();
    await page.getByTestId('local-album-back').click();
    // Artists: A–Z with what they have, Unknown artist last; the choice is remembered.
    await page.getByTestId('local-view-artists').click();
    await expect(page.getByTestId('local-artist')).toHaveText([/^Ana Tape1 album · 3 songs$/, /^Zed Loop1 album · 2 songs$/, /^Unknown artist1 song$/]);
    await page.reload();
    await openLibrary(page, 'local');
    await expect(page.getByTestId('local-view-artists')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('local-artist').nth(1).click();
    await expect(page.getByTestId('screen-local-artist')).toContainText('Zed Loop');
    await expect(page.getByTestId('local-artist-songs').getByTestId('track-title')).toHaveText(['Music song D', 'Music song J']);
  });
});

test.describe('with no folder yet', () => {
  test.use({ localOptions: { picks: ['cancel', MUSIC] } });

  test('backing out of the picker leaves it on with no folder; Local says so, and its [Add folder] opens the picker again', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await page.getByTestId('local-toggle').click();
    await expect(page.getByTestId('local-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('local-folder')).toHaveCount(0);
    await openLibrary(page, 'local');
    await expect(page.getByTestId('local-empty')).toContainText('No folders yet');
    await page.getByTestId('local-add').click();
    await expect(titles(page)).toHaveText(BY_TITLE);
  });
});

test.describe('folders', () => {
  test.use({ localOptions: { folders: [MUSIC], picks: [{ inside: 'Music' }] } });

  test('Local’s + opens the picker too', async ({ page }) => {
    await localOn(page);
    await page.goto('/');
    await openLibrary(page, 'local');
    await page.getByTestId('local-add-top').click();
    await expect(page.getByTestId('toast').last()).toHaveText('Already in Music');
  });

  test('a folder inside a chosen one isn’t added; ✕ hides one at once with Undo, and its access goes only once the toast does', async ({ page }) => {
    await localOn(page);
    await page.goto('/');
    await openSettings(page);
    const card = page.getByTestId('local-card');
    await expect(card.getByTestId('local-folder-state')).toHaveText('6 songs');
    await card.getByTestId('local-add-folder').click();
    await expect(page.getByTestId('toast').last()).toHaveText('Already in Music');
    await expect(card.getByTestId('local-folder')).toHaveCount(1);

    await card.getByTestId('local-remove').click();
    await expect(card.getByTestId('local-folder')).toHaveCount(0);
    await expect(page.getByTestId('toast').last()).toContainText('Removed Music');
    await page.getByTestId('toast').last().getByRole('button', { name: 'Undo' }).click();
    await expect(card.getByTestId('local-folder')).toHaveCount(1);
    expect((await fake(page)).removed).toEqual([]);

    await card.getByTestId('local-remove').click();
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 8000 });
    expect((await fake(page)).removed).toEqual([MUSIC.id]);
    await page.getByTestId('tab-library').click();
    await expect(page.getByTestId('lib-local')).toContainText('0 songs');
  });
});

test.describe('a folder out of reach', () => {
  test.use({ localOptions: { folders: [MUSIC, { ...ALBUMS, gone: true }], picks: [ALBUMS] } });

  test('its songs are hidden and both screens say so; choosing it again brings them back', async ({ page }) => {
    await localOn(page);
    await page.goto('/');
    await openLibrary(page, 'local');
    await expect(page.getByTestId('local-gone')).toContainText('Can’t reach “SD card › Albums”. Its 2 songs are hidden.');
    await expect(titles(page)).toHaveText(BY_TITLE);
    await openSettings(page);
    await expect(page.getByTestId('local-folder').nth(1)).toContainText('Can’t reach this folder');
    await page.getByTestId('tab-library').click();
    await page.getByTestId('local-gone-again').click();
    await expect(page.getByTestId('local-gone')).toHaveCount(0);
    await expect(titles(page)).toHaveText(['Card one', 'Card two', ...BY_TITLE]);
  });
});

test.describe('playing', () => {
  test.use({ localOptions: { folders: [MUSIC] } });

  test('Local plays its list; Now Playing reads "On this phone · Music", the menu has only what applies, and the artist opens their artist page', async ({ page }) => {
    await localOn(page);
    await page.goto('/');
    await openLibrary(page, 'local');
    await page.getByTestId('local-play').click();
    await expect(page.getByTestId('mini-title')).toHaveText('Music song A');
    await openNowPlaying(page);
    await expect(page.getByTestId('np-local')).toHaveText('On this phone · Music');
    await expect(page.getByTestId('now-playing')).toContainText('Playing from Local');
    await page.getByTestId('np-more').click();
    const menu = page.getByTestId('track-menu');
    await expect(menu.getByTestId('menu-add-queue')).toBeVisible();
    await expect(menu.getByTestId('menu-like')).toBeVisible();
    for (const id of ['menu-share', 'menu-more-by', 'menu-open-post', 'menu-open-youtube']) await expect(menu.getByTestId(id)).toHaveCount(0);
    await menu.getByRole('button', { name: /cancel/i }).click();
    // The tag's artist, as any other song's: their artist page (the Jukebox's, then Global's).
    await page.getByTestId('np-artist').click();
    await expect(page.getByTestId('screen-artist')).toBeVisible();
    await expect(page.getByTestId('screen-artist')).toContainText('Ana Tape');
  });

  test('songs with no album tag are the Unknown album, last; an Unknown artist isn\u2019t a link', async ({ page }) => {
    await seedStorage(page, { 'CapacitorStorage.settings': { localMusic: true, localView: 'albums', version: 3 } });
    await page.goto('/');
    await openLibrary(page, 'local');
    await page.getByTestId('local-album').last().click();
    await expect(page.getByTestId('screen-local-album')).toContainText('Songs with no album tag');
    await expect(page.getByTestId('album-artist')).toHaveCount(0);
    await page.waitForTimeout(350);
    await page.getByTestId('album-play').click();
    await expect(page.getByTestId('mini-title')).toHaveText('voice memo 6');
    await openNowPlaying(page);
    await expect(page.getByTestId('np-artist')).toHaveCount(0);
  });

  test('a liked local song is tagged "On phone" in Liked and plays offline; Here searches Local', async ({ page, backend }) => {
    await localOn(page);
    await page.goto('/');
    await openLibrary(page, 'local');
    await openSearch(page);
    await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'Search in Local');
    await page.getByTestId('search-input').fill('memo');
    await expect(page.getByTestId('search').getByTestId('track-title')).toHaveText(['voice memo 6']);
    await page.keyboard.press('Escape');
    await page.getByTestId('local-list').getByTestId('track-more').first().click();
    await page.getByTestId('menu-like').click();
    await openLibrary(page, 'liked');
    const row = page.getByTestId('liked-list').getByTestId('track-row');
    await expect(row.getByTestId('track-title')).toHaveText(['Music song A']);
    await expect(row.getByTestId('local-tag')).toHaveText('On phone');
    await setOffline(page, backend, true);
    await expect(row).not.toHaveClass(/\boff\b/);
    await row.getByTestId('track-play').click();
    await expect(page.getByTestId('mini-title')).toHaveText('Music song A');
  });

  test('offline, the line and a refused tap name what still plays, local songs or both, and lead to Library', async ({ page, backend }) => {
    const liked = { id: 'l1', ytId: 'abcdefghij1', title: 'Track l1', artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '2026-01-01T00:00:00Z', nsfw: false, artworkUrl: '' };
    await localOn(page, { 'CapacitorStorage.liked': [liked] });
    await page.goto('/');
    await expect(page.getByTestId('track-row').first()).toBeVisible();
    await setOffline(page, backend, true);
    const line = page.getByTestId('offline-banner-library');
    await expect(line).toHaveText('[ offline ] no carrier · your local songs still play');
    await page.getByTestId('screen-home').locator('.row.off').first().getByTestId('track-play').click({ force: true });
    await expect(page.getByTestId('toast').last()).toContainText('No carrier. Your local songs still play.');
    await page.getByTestId('toast-action').click();
    await expect(page.getByTestId('screen-library')).toBeVisible();
    await expect(page.getByTestId('lib-local')).toBeVisible();
    // A Jukebox liked song saved on the phone too: both.
    await saved(page, [liked.ytId]);
    await expect(line).toHaveText('[ offline ] no carrier · your liked and local songs still play');
    await openLibrary(page, 'local');
    await line.click();
    await expect(page.getByTestId('screen-library')).toBeVisible();
  });

  test('turning it off asks first, then Local and its songs in the queue go', async ({ page }) => {
    await localOn(page);
    await page.goto('/');
    await openLibrary(page, 'local');
    await page.getByTestId('local-play').click();
    await expect(page.getByTestId('mini-title')).toHaveText('Music song A');
    await openSettings(page);
    await page.getByTestId('local-toggle').click();
    await expect(page.getByTestId('confirm-sheet')).toContainText('Turn off local music?');
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('local-toggle')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('mini-player')).toHaveCount(0);
    expect((await fake(page)).disabled).toBe(1);
    await page.getByTestId('tab-library').click();
    await expect(page.getByTestId('lib-local')).toHaveCount(0);
  });
});
