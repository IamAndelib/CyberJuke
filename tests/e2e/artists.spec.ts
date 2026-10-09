import { expect, test } from '../fixtures';
import type { Locator, Page } from '@playwright/test';
import { musicCalls, openSearch, scrollTo, scrollTopOf, start } from '../helpers';

/** The Artists tab and artist pages: Jukebox tracks, the artist's own page, fallbacks, Here search. */

const BOT_TEXT = "Global search isn't available on this network right now, try again later";
const y = async (l: Locator) => (await l.boundingBox())!.y;

async function openFirstArtist(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  const grid = page.getByTestId('artist-grid');
  const artist = (await grid.getByTestId('artist-tile').first().getAttribute('data-artist'))!;
  // By name: the grid may still be re-ordering as it fills in.
  await grid.locator(`[data-testid="artist-tile"][data-artist="${artist.replace(/"/g, '\\"')}"]`).click();
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  return artist;
}

test('the Artists tab lists artists; a heart adds Favorite artists, which survive a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  await expect(page.getByTestId('screen-artists').locator('.topbar-sub')).toContainText(/\d{3} artists on the Jukebox/);
  const grid = page.getByTestId('artist-grid');
  await expect.poll(() => grid.getByTestId('artist-tile').count()).toBeGreaterThan(300);
  await expect(page.getByTestId('fav-artists')).toHaveCount(0);
  // "and" / "&" never split a name.
  const names = await grid.getByTestId('artist-tile').evaluateAll((els) => els.map((e) => e.getAttribute('data-artist')!));
  expect(names.some((n) => / & /.test(n))).toBe(true);
  expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);

  const second = grid.getByTestId('artist-cell').nth(1);
  const artist = (await second.getAttribute('data-artist'))!;
  await second.getByTestId('artist-fav').click();
  await expect(second.getByTestId('artist-fav')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('toast').last()).toHaveText(`${artist} added to Favourites`);
  // ★ Favourites shows it at once, and after a restart.
  await expect(page.getByTestId('fav-artists').getByTestId('artist-tile')).toHaveText([artist]);
  await page.reload();
  await page.getByTestId('tab-artists').click();
  await expect(page.getByTestId('fav-artists').getByTestId('artist-tile')).toHaveText([artist]);
  await page.getByTestId('fav-artists').getByTestId('artist-fav').click();
  await expect(page.getByTestId('fav-artists')).toHaveCount(0);
  await expect(page.getByTestId('toast').last()).toContainText(`${artist} removed from Favourites`);
});

test('artist page: Jukebox, Top songs, Albums, Live albums, EPs, Singles in order; See all opens the grid', async ({ page }) => {
  const artist = await openFirstArtist(page);
  const sections = ['artist-jukebox', 'artist-top', 'artist-albums', 'artist-live', 'artist-eps', 'artist-singles'].map((id) => page.getByTestId(id));
  for (const s of sections.slice(1)) await expect(s).toBeVisible();
  for (let i = 1; i < sections.length; i++) expect(await y(sections[i - 1])).toBeLessThan(await y(sections[i]));
  await expect(page.locator('#app .section-title')).toHaveText(['Shared on the Jukebox', 'Top songs', 'Albums', 'Live albums', 'EPs', 'Singles']);
  await expect(page.getByTestId('artist-more')).toHaveCount(0);
  await expect(page.getByTestId('screen-artist')).not.toContainText(/youtube/i);

  const top = page.getByTestId('artist-top');
  await expect(top.getByTestId('track-row')).toHaveCount(5);
  for (const a of await top.locator('.row-artist').allTextContents()) expect(a).toBe(artist);
  await top.getByTestId('top-load-more').click();
  await expect(top.getByTestId('track-row')).toHaveCount(12);
  await expect(top.getByTestId('top-load-more')).toHaveCount(0);
  await page.getByTestId('artist-top-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText((await top.getByTestId('track-title').first().textContent())!.trim());

  const albums = page.getByTestId('artist-albums');
  await expect(albums.getByTestId('release-title')).toHaveText(['A Night in Neon', 'Analog Dreams', 'Alive', 'Blue Room Sessions']);
  await expect(albums.getByTestId('release-year').first()).toHaveText('2023');
  await expect(page.getByTestId('artist-live').getByTestId('release-title')).toHaveText(['Wembley Nights', 'Live at the Roxy']);
  await expect(page.getByTestId('artist-eps').getByTestId('release-title')).toHaveText(['Night Shift EP', 'Paper Moons EP']);
  await expect(page.getByTestId('artist-singles').getByTestId('release-title')).toContainText(['Static Hearts', 'Golden Hour', 'Live Forever']);
  const cover = (await albums.locator('.art').first().boundingBox())!;
  expect(Math.abs(cover.width - cover.height)).toBeLessThanOrEqual(1);
  expect((await albums.getByTestId('release-card').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await page.getByTestId('artist-live').getByTestId('release-card').nth(1).click();
  const album = page.getByTestId('screen-album');
  await expect(album.getByTestId('track-row').first()).toBeVisible();
  await expect(album.locator('.topbar-sub, .album-info .dim.small').first()).toContainText('Live album');
  await page.getByTestId('album-back').click();

  await page.getByTestId('artist-albums').getByTestId('see-all').click();
  const grid = page.getByTestId('screen-releases');
  await expect(grid.locator('.topbar-title')).toHaveText('Albums');
  await expect(grid.getByTestId('release-title')).toHaveText(['A Night in Neon', 'Analog Dreams', 'Alive', 'Blue Room Sessions', 'Early Tapes', 'Glass Garden']);
  const [a, b] = [await grid.getByTestId('release-card').nth(0).boundingBox(), await grid.getByTestId('release-card').nth(1).boundingBox()];
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  await grid.getByTestId('release-card').first().click();
  await expect(page.getByTestId('screen-album')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-album')).toHaveCount(0);
  await expect(grid).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-artist')).toBeVisible();

  await page.getByTestId('artist-singles').getByTestId('see-all').click();
  await expect(grid.getByTestId('release-card')).toHaveCount(7);
  await expect(grid.locator('[data-testid="release-card"]:not([data-kind="single"])')).toHaveCount(0);
  await page.getByTestId('releases-back').click();
  await page.getByTestId('artist-eps').getByTestId('see-all').click();
  await expect(grid.getByTestId('release-title')).toHaveText(['Night Shift EP', 'Paper Moons EP', 'Satellite EP']);
  const calls = (await musicCalls(page)).filter((c) => c[0] === 'artistReleases').map((c) => c[1]);
  expect(calls).toEqual([expect.stringMatching(/^rel\|albums\|/), expect.stringMatching(/^rel\|singles\|/)]);
});

test.describe('empty shelves', () => {
  test.use({ musicOptions: { shelves: ['single'] } });
  test('are hidden', async ({ page }) => {
    await openFirstArtist(page);
    await expect(page.getByTestId('artist-singles')).toBeVisible();
    await expect(page.getByTestId('artist-top')).toBeVisible();
    for (const id of ['artist-albums', 'artist-live', 'artist-eps']) await expect(page.getByTestId(id)).toHaveCount(0);
  });
});

test.describe('an expired See all token', () => {
  test.use({ musicOptions: { evictToken: true } });
  test('offers Retry, which reloads the artist page', async ({ page }) => {
    await openFirstArtist(page);
    await page.getByTestId('artist-albums').getByTestId('see-all').click();
    const err = page.getByTestId('releases-error');
    await expect(err).toContainText("Couldn't load this list.");
    await expect(err).not.toContainText(/youtube/i);
    await page.getByTestId('releases-retry').click();
    await expect(page.getByTestId('screen-releases').getByTestId('release-card')).toHaveCount(6);
    expect((await musicCalls(page)).filter((c) => c[0] === 'artistPage')).toHaveLength(2);
  });
});

test.describe('without the artist page', () => {
  test.use({ musicOptions: { noArtistPage: true } });

  test('the page falls back to the Jukebox, More by and Albums; an album opens and plays; scroll is remembered', async ({ page }) => {
    const artist = await openFirstArtist(page);
    await expect(page.getByTestId('screen-artist').locator('.topbar-title')).toHaveText(artist);
    const jukebox = page.getByTestId('artist-jukebox');
    const more = page.getByTestId('artist-more');
    const albums = page.getByTestId('artist-albums');
    await expect(jukebox.getByTestId('track-row').first()).toBeVisible();
    await expect(jukebox.getByTestId('track-row').first()).toContainText('by @');
    await expect(more).toContainText(`More by ${artist}`);
    await expect(more.getByTestId('track-row').first()).toBeVisible();
    await expect(albums.getByTestId('album-card').first()).toBeVisible();
    expect(await y(jukebox)).toBeLessThan(await y(more));
    expect(await y(more)).toBeLessThan(await y(albums));
    await expect(more.locator('.by')).toHaveCount(0);
    for (const a of await more.locator('.row-artist').allTextContents()) expect(a.toLowerCase()).toContain(artist.toLowerCase());
    const before = await more.getByTestId('track-row').count();
    await more.getByTestId('load-more').click();
    await expect.poll(() => more.getByTestId('track-row').count()).toBeGreaterThan(before);

    const firstMore = (await more.getByTestId('track-title').first().textContent())!.trim();
    await page.getByTestId('artist-more-play').click();
    await expect(page.getByTestId('mini-title')).toHaveText(firstMore);

    await albums.getByTestId('album-card').first().click();
    const album = page.getByTestId('screen-album');
    await expect(album.getByTestId('album-artist')).toHaveText(artist); // empty subtitle falls back to the artist
    await expect(album.getByTestId('track-row')).toHaveCount(8);
    const first = (await album.getByTestId('track-title').first().textContent())!.trim();
    await page.getByTestId('album-play').click();
    await expect(page.getByTestId('mini-title')).toHaveText(first);
    await page.getByTestId('album-back').click();
    await expect(album).toHaveCount(0);

    await scrollTo(page, 'screen-artist', 500);
    const ay = await scrollTopOf(page, 'screen-artist');
    expect(ay).toBeGreaterThan(400);
    await page.getByTestId('artist-back').click();
    await expect(page.getByTestId('artist-grid')).toBeVisible();
    await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
    await expect.poll(() => scrollTopOf(page, 'screen-artist')).toBeGreaterThan(ay - 10);
    expect(Math.abs((await scrollTopOf(page, 'screen-artist')) - ay)).toBeLessThanOrEqual(10);
  });

  test('"More by Queen" lists only Queen-channel items: no Ivy Queen, no Queen Butterfly', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('search-fab').click();
    await page.getByTestId('mode-global').click();
    await page.getByTestId('search-input').fill('Queen');
    await page.getByTestId('filter-artists').click();
    await expect(page.getByTestId('music-row').first()).toBeVisible();
    await page.getByTestId('music-open').first().click();
    await expect(page.getByTestId('screen-artist').locator('.topbar-title')).toHaveText('Queen');
    const more = page.getByTestId('artist-more');
    await expect(more.getByTestId('track-row').first()).toBeVisible();
    const artists = await more.locator('.row-artist').allTextContents();
    expect(artists.length).toBeGreaterThanOrEqual(10);
    for (const a of artists) {
      expect(a.split(', ')[0]).toBe('Queen');
      expect(a).not.toMatch(/Ivy Queen|Queen Butterfly/);
    }
    const titles = await more.getByTestId('track-title').allTextContents();
    expect(titles.some((t) => t.startsWith('Decoy'))).toBe(false);
    expect(titles.some((t) => t.startsWith('Unlinked Decoy'))).toBe(false);
    expect(titles.some((t) => t.startsWith('Unlinked Original'))).toBe(true);
    await expect(page.getByTestId('artist-albums').getByTestId('album-card').first()).toBeVisible();
    await expect(page.getByTestId('artist-albums')).not.toContainText('Decoy Album');
    expect((await musicCalls(page)).filter((c) => c[0] === 'artist')).toHaveLength(0);
  });

  test('an artist from the Artists tab is resolved by exact name', async ({ page }) => {
    const artist = await openFirstArtist(page);
    const more = page.getByTestId('artist-more');
    await expect(more.getByTestId('track-row').first()).toBeVisible();
    expect((await musicCalls(page)).filter((c) => c[0] === 'artist')).toEqual([['artist', artist]]);
    for (const a of await more.locator('.row-artist').allTextContents()) expect(a.split(', ')[0].toLowerCase()).toBe(artist.toLowerCase());
    const titles = await more.getByTestId('track-title').allTextContents();
    expect(titles.filter((t) => /Decoy/.test(t))).toEqual([]);
    await more.getByTestId('load-more').click();
    await expect.poll(() => more.getByTestId('track-row').count()).toBeGreaterThan(titles.length);
  });
});

test.describe('a bot check', () => {
  test.use({ musicOptions: { botCheck: true } });
  test('only affects the Global sections', async ({ page }) => {
    await openFirstArtist(page);
    await expect(page.getByTestId('artist-jukebox').getByTestId('track-row').first()).toBeVisible();
    await expect(page.getByTestId('artist-more').getByTestId('global-error')).toContainText(BOT_TEXT);
    await expect(page.getByTestId('albums-error')).toBeVisible();
  });
});

test.describe('Here on an artist page', () => {
  test.use({ musicOptions: { topSongPages: 3, songPageDelay: 1200 } });
  test('finds a top song, then a song only in the full list once it has loaded', async ({ page }) => {
    const artist = await openFirstArtist(page);
    await expect(page.getByTestId('artist-top').getByTestId('track-row')).toHaveCount(5);
    expect((await musicCalls(page)).filter((c) => c[0] === 'more')).toEqual([]);
    await openSearch(page);
    await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', `Search in ${artist}`);

    await page.getByTestId('search-input').fill('neon rain');
    const results = page.getByTestId('here-results');
    const neon = results.getByTestId('track-row').filter({ has: page.getByTestId('track-title').getByText('Neon Rain', { exact: true }) });
    await expect(neon).toHaveCount(1);
    await expect(neon.locator('.row-artist')).toHaveText(artist);

    await page.getByTestId('search-input').fill('moonlit');
    await expect(page.getByTestId('here-loading')).toHaveText('Searching all songs…');
    await expect(results.getByTestId('track-title')).toHaveText(['Moonlit Rarity'], { timeout: 15_000 });
    await expect(page.getByTestId('here-loading')).toHaveCount(0);
    expect((await musicCalls(page)).filter((c) => c[0] === 'more').map((c) => c[1])).toEqual([`tok|top|${artist}|1`, `tok|top|${artist}|2`]);

    await page.getByTestId('search-input').fill('');
    const list = page.getByTestId('here-list');
    await expect(list.getByTestId('track-title').getByText('Moonlit Rarity', { exact: true })).toHaveCount(1);
    const titles = await list.getByTestId('track-title').allTextContents();
    expect(titles.filter((t) => t === 'Neon Rain')).toHaveLength(1);
    expect(titles).toContain('Rarity 1');
    expect(titles).toContain('Midnight Drive');

    await page.getByTestId('search-input').fill('analog');
    const rels = page.getByTestId('here-releases');
    await expect(rels.getByTestId('release-title')).toHaveText(['Analog Dreams']);
    await rels.getByTestId('here-release').click();
    await expect(page.getByTestId('screen-album')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('here-releases')).toBeVisible();

    // Cached with the page: closing and reopening Search reads nothing again.
    await page.getByTestId('search-close').click();
    const before = (await musicCalls(page)).length;
    await openSearch(page);
    await page.getByTestId('search-input').fill('moonlit');
    await expect(page.getByTestId('here-results').getByTestId('track-title')).toHaveText(['Moonlit Rarity']);
    await expect(page.getByTestId('here-loading')).toHaveCount(0);
    expect((await musicCalls(page)).length).toBe(before);
  });
});

test('Here on an artist page: the artist Jukebox tracks come first', async ({ page }) => {
  await openFirstArtist(page);
  const shared = page.getByTestId('artist-jukebox').getByTestId('track-title');
  await expect(shared.first()).toBeVisible();
  const jukeboxTitles = (await shared.allTextContents()).map((t) => t.trim());
  await expect(page.getByTestId('artist-top').getByTestId('track-row').first()).toBeVisible();
  await openSearch(page);
  const list = page.getByTestId('here-list');
  await expect(list.getByTestId('track-title').filter({ hasText: 'Deep Cut' }).first()).toBeAttached();
  const titles = (await list.getByTestId('track-title').allTextContents()).map((t) => t.trim());
  expect(titles.slice(0, jukeboxTitles.length)).toEqual(jukeboxTitles);
});

test('the Jukebox tracks of an artist play from the artist page', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  const jukebox = page.getByTestId('artist-jukebox');
  const first = (await jukebox.getByTestId('track-title').first().textContent())!.trim();
  await page.getByTestId('artist-jukebox-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(first);
});

test('★ on an artist page: adds the artist to Favourites, and unstarring removes it', async ({ page }) => {
  const artist = await openFirstArtist(page);
  const star = page.getByTestId('artist-page-fav');
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('toast').last()).toContainText(artist);
  await page.getByTestId('artist-back').click();
  await page.getByTestId('tab-home').click();
  await page.getByTestId('tab-artists').click();
  await expect(page.getByTestId('fav-artists').getByTestId('artist-tile')).toHaveText([artist]);
  await page.getByTestId('fav-artists').getByTestId('artist-tile').click();
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('artist-back').click();
  await page.getByTestId('tab-home').click();
  await page.getByTestId('tab-artists').click();
  await expect(page.getByTestId('fav-artists')).toHaveCount(0);
});
