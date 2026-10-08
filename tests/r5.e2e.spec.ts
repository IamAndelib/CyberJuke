import { expect, test, type Page } from '@playwright/test';
import { AUTH_USER, stubAuth, stubMusic, stubYouTube } from './stubs';

/**
 * Round 5: Here search on an artist page covers the whole page (Jukebox tracks, Top
 * songs, the full song list, release titles); Settings has Account first with the
 * "members-only shared tracks" wording; back-to-top starts on pointerdown, even
 * during a fling. Live Firestore (read-only) plus the browser stubs from stubs.ts.
 */

async function waitForTracks(page: Page) {
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
}

async function openSearch(page: Page) {
  await page.getByTestId('search-fab').click();
  await expect(page.getByTestId('search')).toBeVisible();
}

const musicCalls = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeMusicCalls: unknown[][] }).__cyberjukeMusicCalls);

test('Here on an artist page finds a top song, then a song only in the full list once it has loaded', async ({ page }) => {
  await stubYouTube(page);
  await stubMusic(page, { topSongPages: 3, songPageDelay: 1200 });
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  const tile = page.getByTestId('artist-grid').getByTestId('artist-tile').first();
  const artist = (await tile.getAttribute('data-artist'))!;
  await tile.click();
  await expect(page.getByTestId('artist-top').getByTestId('track-row')).toHaveCount(5);
  // The page itself doesn't read the full list.
  expect((await musicCalls(page)).filter((c) => c[0] === 'more')).toEqual([]);

  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', `Search in ${artist}`);

  // A top song (not shared on the Jukebox) is found, once (Top songs and the full list agree).
  await page.getByTestId('search-input').fill('neon rain');
  const results = page.getByTestId('here-results');
  const neon = results.getByTestId('track-row').filter({ has: page.getByTestId('track-title').getByText('Neon Rain', { exact: true }) });
  await expect(neon).toHaveCount(1);
  await expect(neon.locator('.row-artist')).toHaveText(artist);

  // A song only on the last page of the full list: "Searching all songs…" until it arrives.
  await page.getByTestId('search-input').fill('moonlit');
  await expect(page.getByTestId('here-loading')).toHaveText('Searching all songs…');
  await expect(results.getByTestId('track-title')).toHaveText(['Moonlit Rarity'], { timeout: 15_000 });
  await expect(page.getByTestId('here-loading')).toHaveCount(0);
  const more = (await musicCalls(page)).filter((c) => c[0] === 'more').map((c) => c[1]);
  expect(more).toEqual([`tok|top|${artist}|1`, `tok|top|${artist}|2`]);

  // The whole list (Jukebox first, each song once) shows with an empty query.
  await page.getByTestId('search-input').fill('');
  const list = page.getByTestId('here-list');
  await expect(list.getByTestId('track-title').getByText('Moonlit Rarity', { exact: true })).toBeVisible();
  const titles = await list.getByTestId('track-title').allInnerTexts();
  expect(titles.filter((t) => t === 'Neon Rain')).toHaveLength(1);
  expect(titles).toContain('Rarity 1');
  expect(titles).toContain('Midnight Drive');

  // Release titles show as a cover row above the tracks, and open the album page.
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

test('Here on an artist page: the artist Jukebox tracks come first', async ({ page }) => {
  await stubYouTube(page);
  await stubMusic(page);
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  const shared = page.getByTestId('artist-jukebox').getByTestId('track-title');
  await expect(shared.first()).toBeVisible();
  const jukeboxTitles = (await shared.allInnerTexts()).map((t) => t.trim());
  await expect(page.getByTestId('artist-top').getByTestId('track-row').first()).toBeVisible();
  await openSearch(page);
  const list = page.getByTestId('here-list');
  await expect(list.getByTestId('track-title').filter({ hasText: 'Deep Cut' }).first()).toBeVisible();
  const titles = (await list.getByTestId('track-title').allInnerTexts()).map((t) => t.trim());
  expect(titles.slice(0, jukeboxTitles.length)).toEqual(jukeboxTitles);
});

test('Settings: Account is the first card and says "members-only shared tracks"', async ({ page }) => {
  await stubAuth(page);
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const settings = page.getByTestId('screen-settings');
  await expect(settings.locator('.card-title')).toHaveText(['Account', 'Theme', 'Playback & data', 'About', 'Licenses']);
  const account = page.getByTestId('account');
  expect((await account.boundingBox())!.y).toBeLessThan((await page.getByTestId('theme-picker').boundingBox())!.y);
  await expect(account.locator('.signin-lead')).toHaveText('Optional. Signed in, the Jukebox also shows members-only shared tracks, marked [members].');
  await expect(settings).not.toContainText('members-only posts');
  await expect(page.getByTestId('about')).toContainText('adds the members-only shared tracks the site shows its members');

  await page.getByTestId('signin-email').fill(AUTH_USER.email);
  await page.getByTestId('signin-password').fill(AUTH_USER.password);
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signed-in')).toContainText('Members-only shared tracks show on Home, Genres, Artists and Search, marked [members].');
  await expect(settings.locator('.card-title').first()).toHaveText('Account');
});

test('back-to-top: a pointerdown during a fling reaches the top, with no click needed', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  await openSearch(page);
  await expect(page.getByTestId('search-latest').getByTestId('track-row').first()).toBeVisible();
  const screen = page.getByTestId('search');
  const btn = screen.getByTestId('back-to-top');
  await screen.evaluate((el) => el.scrollTo(0, el.clientHeight * 2));
  await expect(btn).toBeVisible();

  // A fling: a long native smooth scroll still under way when the button is pressed.
  const run = await screen.evaluate(async (el) => {
    const btn = el.querySelector('[data-testid="back-to-top"]') as HTMLElement;
    let clicks = 0;
    btn.addEventListener('click', () => clicks++);
    el.scrollBy({ top: 4000, behavior: 'smooth' });
    await new Promise((r) => setTimeout(r, 120));
    const flinging = el.scrollTop;
    const seen: number[] = [];
    const onScroll = () => seen.push(el.scrollTop);
    el.addEventListener('scroll', onScroll);
    const down = new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    await new Promise((r) => setTimeout(r, 900));
    el.removeEventListener('scroll', onScroll);
    return { flinging, start: el.clientHeight * 2, seen, end: el.scrollTop, clicks, prevented: down.defaultPrevented };
  });
  expect(run.flinging).toBeGreaterThan(run.start); // it was moving
  expect(run.prevented).toBe(true);
  expect(run.clicks).toBe(0);
  expect(run.end).toBe(0);
  // Animated (several frames, never back down), not a jump.
  expect(new Set(run.seen).size).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < run.seen.length; i++) expect(run.seen[i]).toBeLessThanOrEqual(run.seen[i - 1]);
  await page.waitForTimeout(300);
  expect(await screen.evaluate((el) => el.scrollTop)).toBe(0); // no momentum came back
  await expect(btn).toBeHidden();

  // A touch on the list during the jump stops it where it is.
  await screen.evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect(btn).toBeVisible();
  const stopped = await screen.evaluate(async (el) => {
    const btn = el.querySelector('[data-testid="back-to-top"]') as HTMLElement;
    const row = el.querySelector('[data-testid="track-row"]') as HTMLElement;
    btn.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    row.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }));
    const at = el.scrollTop;
    await new Promise((r) => setTimeout(r, 500));
    return { at, end: el.scrollTop };
  });
  expect(stopped.at).toBeGreaterThan(0);
  expect(stopped.end).toBe(stopped.at);

  // Keyboard still works (Enter clicks it).
  await expect(btn).toBeVisible();
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => screen.evaluate((el) => el.scrollTop)).toBe(0);

  // Reduced motion: straight to the top.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await screen.evaluate((el) => el.scrollTo(0, el.clientHeight * 3));
  await expect(btn).toBeVisible();
  const instant = await screen.evaluate((el) => {
    const btn = el.querySelector('[data-testid="back-to-top"]') as HTMLElement;
    btn.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }));
    return el.scrollTop;
  });
  expect(instant).toBe(0);
});
