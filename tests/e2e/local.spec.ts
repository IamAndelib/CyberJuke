import { expect, musicFolder, test, type FakeLocalFolder } from '../fixtures';
import { openLibrary, openNowPlaying, openSearch, openSettings, seedStorage, setOffline } from '../helpers';

/**
 * Local music (Settings → Local music, Library → Local) on the fake JukeLocal: the folder
 * picker is a list of picks, a look through a folder takes `scanMs`, and the songs play as
 * silent MP3s from the page's own origin.
 */

const MUSIC = musicFolder();
const ALBUMS: FakeLocalFolder = { id: 'tree:albums', name: 'SD card › Albums', songs: [{ hex: '00000000000000a1', title: 'Card one', artist: 'Ana Tape', album: 'Cellar' }, { hex: '00000000000000a2', title: 'Card two', artist: 'Ana Tape', album: 'Cellar' }] };
/** Local's titles in the default order: by title, the untagged song last. */
const BY_TITLE = ['Music song A', 'Music song D', 'Music song G', 'Music song J', 'Music song M', 'voice memo 6'];

const localOn = (page: Parameters<typeof seedStorage>[0]) => seedStorage(page, { 'CapacitorStorage.settings': { localMusic: true, version: 3 } });
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
    await page.getByTestId('local-sort-artist').click();
    await expect(titles(page)).toHaveText(['Music song A', 'Music song G', 'Music song M', 'Music song J', 'Music song D', 'voice memo 6']);
    await page.getByTestId('local-sort-album').click();
    await expect(titles(page)).toHaveText(['Music song A', 'Music song J', 'Music song D', 'Music song G', 'Music song M', 'voice memo 6']);
    await page.reload();
    await openLibrary(page, 'local');
    await expect(page.getByTestId('local-sort-album')).toHaveAttribute('aria-checked', 'true');
    await expect(titles(page)).toHaveText(['Music song A', 'Music song J', 'Music song D', 'Music song G', 'Music song M', 'voice memo 6']);
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

  test('Local plays its list; Now Playing reads "On this phone · Music", the artist is plain, the menu has only what applies', async ({ page }) => {
    await localOn(page);
    await page.goto('/');
    await openLibrary(page, 'local');
    await page.getByTestId('local-play').click();
    await expect(page.getByTestId('mini-title')).toHaveText('Music song A');
    await openNowPlaying(page);
    await expect(page.getByTestId('np-local')).toHaveText('On this phone · Music');
    await expect(page.getByTestId('now-playing')).toContainText('Playing from Local');
    await expect(page.getByTestId('np-artist')).toHaveCount(0);
    await page.getByTestId('np-more').click();
    const menu = page.getByTestId('track-menu');
    await expect(menu.getByTestId('menu-add-queue')).toBeVisible();
    await expect(menu.getByTestId('menu-like')).toBeVisible();
    for (const id of ['menu-share', 'menu-more-by', 'menu-open-post', 'menu-open-youtube']) await expect(menu.getByTestId(id)).toHaveCount(0);
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
