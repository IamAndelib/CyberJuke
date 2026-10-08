import { expect, test, type Locator, type Page } from '@playwright/test';
import { AUTH_USER, BANNED_POST, MEMBERS_POSTS, stubAuth, stubMusic, stubYouTube } from './stubs';

/**
 * Round 4: optional "Sign in with Cyberspace" (members-only Jukebox posts) against a
 * fake login server and a fake signed-in Firestore (stubAuth), and the artist page's
 * own discography (stubMusic's artistPage / artistReleases).
 */

async function waitForTracks(page: Page) {
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
}

async function signIn(page: Page, email = AUTH_USER.email, password = AUTH_USER.password) {
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('signin-email').fill(email);
  await page.getByTestId('signin-password').fill(password);
  await page.getByTestId('signin-submit').click();
}

const homeRow = (page: Page, title: string) =>
  page.getByTestId('screen-home').getByTestId('track-row').filter({ has: page.getByTestId('track-title').getByText(title, { exact: true }) });

test('signed out: the Account card offers sign-in; nothing is members-only', async ({ page }) => {
  const stub = await stubAuth(page);
  await page.goto('/');
  await waitForTracks(page);
  await expect(page.getByTestId('members-tag')).toHaveCount(0);
  await page.getByTestId('tab-settings').click();
  const card = page.getByTestId('account');
  await expect(card).toContainText('Sign in with Cyberspace');
  await expect(page.getByTestId('signin-note')).toHaveText(
    "Your password goes only to Cyberspace's login. CyberJuke keeps only a login token, encrypted on this phone.",
  );
  await expect(card.getByRole('link', { name: 'Create one on cyberspace.online' })).toBeVisible();
  // 44px targets, labelled fields.
  for (const id of ['signin-email', 'signin-password', 'signin-submit', 'signin-reveal']) {
    expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByTestId('signin-reveal').click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  // Signed out, no request ever carries a token.
  expect(stub.calls.members).toBe(0);
  expect(stub.calls.public).toBeGreaterThan(0);
});

test('signing in shows [members] posts in Latest, search and Now Playing; signing out removes them', async ({ page }) => {
  await stubYouTube(page);
  const stub = await stubAuth(page);
  await page.goto('/');
  await waitForTracks(page);
  await expect(homeRow(page, MEMBERS_POSTS[0].title)).toHaveCount(0);

  await signIn(page);
  await expect(page.getByTestId('signed-in')).toBeVisible();
  await expect(page.getByTestId('account-name')).toHaveText('@' + AUTH_USER.username);
  await expect(page.getByTestId('signin-form')).toHaveCount(0);
  expect(stub.calls.signIn).toBe(1);

  // Home: members-only posts on top, tagged; the banned post is hidden.
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  const row = homeRow(page, MEMBERS_POSTS[0].title);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('members-tag')).toHaveText('[members]');
  await expect(page.getByTestId('screen-home').getByTestId('track-title').first()).toHaveText(MEMBERS_POSTS[0].title);
  await expect(page.getByTestId('screen-home').getByTestId('members-tag')).toHaveCount(MEMBERS_POSTS.length);
  await expect(homeRow(page, BANNED_POST.title)).toHaveCount(0);
  // Public rows have no tag.
  const firstPublic = page.getByTestId('screen-home').getByTestId('track-row').nth(MEMBERS_POSTS.length);
  await expect(firstPublic.getByTestId('members-tag')).toHaveCount(0);

  // The requests: the members query, with the token, no isPublic / ban filters.
  expect(stub.tokens.every((t) => t === 'Bearer fake-id-1')).toBe(true);
  const q = stub.memberBodies[0];
  expect(JSON.stringify(q.where)).not.toMatch(/isPublic|isBanned|isShadowBanned/);
  expect(q.orderBy.map((o: any) => o.field.fieldPath)).toEqual(['createdAt', '__name__']);

  // Now Playing shows the tag.
  await row.getByTestId('track-play').click();
  await page.getByTestId('mini-open').click();
  await expect(page.getByTestId('now-playing')).toHaveClass(/open/);
  await expect(page.getByTestId('now-playing').getByTestId('members-tag')).toBeVisible();
  await page.getByTestId('np-close').click();

  // Search (the catalog, fully refreshed after sign-in) finds them, tagged.
  await page.getByTestId('search-fab').click();
  await page.getByTestId('search-input').fill(MEMBERS_POSTS[1].title);
  const results = page.getByTestId('search-results');
  await expect(results.getByTestId('track-title').first()).toHaveText(MEMBERS_POSTS[1].title);
  await expect(results.getByTestId('members-tag').first()).toBeVisible();
  await page.getByTestId('search-input').fill(BANNED_POST.title);
  await expect(results.getByTestId('track-title').getByText(BANNED_POST.title)).toHaveCount(0);
  await page.getByTestId('search-close').click();

  // A genre page, signed in, filters the catalog for an exact match (no genre query).
  await page.getByTestId('tab-genres').click();
  const tile = page.getByTestId('genre-grid').getByTestId('genre-tile').first();
  const genre = (await tile.getAttribute('data-genre'))!;
  await tile.click();
  const genrePage = page.getByTestId('screen-genre');
  await expect(genrePage.getByTestId('track-row').first()).toBeVisible();
  await page.getByTestId('genre-back').click();
  expect(genre).toBeTruthy();
  expect(stub.memberBodies.some((b) => JSON.stringify(b.where).includes('audioAttachmentGenre'))).toBe(false);
  await page.getByTestId('tab-home').click();

  // The password is nowhere in storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(AUTH_USER.password);
  expect(stored).not.toContain('fake-refresh');

  // Sign out: the form is back, members posts are gone from Home and search.
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('signout').click();
  await expect(page.getByTestId('signin-form')).toBeVisible();
  const before = stub.calls.members;
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  await expect(page.getByTestId('screen-home').getByTestId('track-row').first()).toBeVisible();
  await expect(homeRow(page, MEMBERS_POSTS[0].title)).toHaveCount(0);
  await expect(page.getByTestId('screen-home').getByTestId('members-tag')).toHaveCount(0);
  await page.getByTestId('search-fab').click();
  await page.getByTestId('search-input').fill(MEMBERS_POSTS[1].title);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('search-results').getByTestId('track-title').getByText(MEMBERS_POSTS[1].title)).toHaveCount(0);
  expect(stub.calls.members).toBe(before);
});

test('sign-in errors: wrong password, too many attempts, no network', async ({ page }) => {
  await stubAuth(page);
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const err = page.getByTestId('signin-error');

  await page.getByTestId('signin-submit').click();
  await expect(err).toHaveText('! Enter your email and password.');

  await signIn(page, AUTH_USER.email, 'wrong');
  await expect(err).toHaveText('! Wrong email or password.');
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('signin-form')).toBeVisible();

  await signIn(page, 'busy@example.com', 'x');
  await expect(err).toHaveText('! Too many attempts. Wait a few minutes, then try again.');

  await signIn(page, 'offline@example.com', 'x');
  await expect(err).toHaveText("! Couldn't reach Cyberspace. Check your connection and try again.");
  await expect(page.getByTestId('signed-in')).toHaveCount(0);
});

test('a token Firestore rejects (401) is refreshed and the request retried once', async ({ page }) => {
  const stub = await stubAuth(page, { rejectFirstToken: true });
  await page.goto('/');
  await waitForTracks(page);
  await signIn(page);
  await expect(page.getByTestId('signed-in')).toBeVisible();
  await page.getByTestId('tab-home').click();
  await expect(homeRow(page, MEMBERS_POSTS[0].title)).toBeVisible();
  expect(stub.calls.unauthorized).toBe(1);
  expect(stub.calls.refresh).toBe(1);
  expect(stub.tokens[0]).toBe('Bearer fake-id-1');
  expect(stub.tokens).toContain('Bearer fake-id-2');
});

// ---- The artist's own page --------------------------------------------------------------

async function openFirstArtist(page: Page): Promise<string> {
  await page.getByTestId('tab-artists').click();
  const tile = page.getByTestId('artist-grid').getByTestId('artist-tile').first();
  const artist = (await tile.getAttribute('data-artist'))!;
  await tile.click();
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  return artist;
}

const y = async (l: Locator) => (await l.boundingBox())!.y;

test('artist page: Jukebox, Top songs, Albums, Live albums, EPs, Singles in order; See all opens the grid', async ({ page }) => {
  await stubYouTube(page);
  await stubMusic(page);
  await page.goto('/');
  const artist = await openFirstArtist(page);

  const sections = ['artist-jukebox', 'artist-top', 'artist-albums', 'artist-live', 'artist-eps', 'artist-singles'].map((id) => page.getByTestId(id));
  for (const s of sections.slice(1)) await expect(s).toBeVisible();
  for (let i = 1; i < sections.length; i++) expect(await y(sections[i - 1])).toBeLessThan(await y(sections[i]));
  await expect(page.locator('#app .section-title')).toHaveText(['Shared on the Jukebox', 'Top songs', 'Albums', 'Live albums', 'EPs', 'Singles']);
  // No fallback sections, and the provider is never named.
  await expect(page.getByTestId('artist-more')).toHaveCount(0);
  await expect(page.getByTestId('screen-artist')).not.toContainText(/youtube/i);

  // Top songs: the artist's own, Play works, Load more reads the songs playlist.
  const top = page.getByTestId('artist-top');
  await expect(top.getByTestId('track-row')).toHaveCount(5);
  for (const a of await top.locator('.row-artist').allInnerTexts()) expect(a).toBe(artist);
  await top.getByTestId('top-load-more').click();
  await expect(top.getByTestId('track-row')).toHaveCount(12);
  await expect(top.getByTestId('top-load-more')).toHaveCount(0);
  await page.getByTestId('artist-top-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText((await top.getByTestId('track-title').first().innerText()).trim());

  // Shelves: square covers with years, classified (Alive is an album, Live at the Roxy live, Live Forever a single).
  const albums = page.getByTestId('artist-albums');
  await expect(albums.getByTestId('release-title')).toHaveText(['A Night in Neon', 'Analog Dreams', 'Alive', 'Blue Room Sessions']);
  await expect(albums.getByTestId('release-year').first()).toHaveText('2023');
  await expect(page.getByTestId('artist-live').getByTestId('release-title')).toHaveText(['Wembley Nights', 'Live at the Roxy']);
  await expect(page.getByTestId('artist-eps').getByTestId('release-title')).toHaveText(['Night Shift EP', 'Paper Moons EP']);
  await expect(page.getByTestId('artist-singles').getByTestId('release-title')).toContainText(['Static Hearts', 'Golden Hour', 'Live Forever']);
  const cover = (await albums.locator('.art').first().boundingBox())!;
  expect(Math.abs(cover.width - cover.height)).toBeLessThanOrEqual(1);
  const card = (await albums.getByTestId('release-card').first().boundingBox())!;
  expect(card.height).toBeGreaterThanOrEqual(44);

  // A live album opens the album page, labelled.
  await page.getByTestId('artist-live').getByTestId('release-card').nth(1).click();
  const album = page.getByTestId('screen-album');
  await expect(album.getByTestId('track-row').first()).toBeVisible();
  await expect(album.locator('.topbar-sub, .album-info .dim.small').first()).toContainText('Live album');
  await page.getByTestId('album-back').click();

  // See all: the full grid of that shelf only.
  await page.getByTestId('artist-albums').getByTestId('see-all').click();
  const grid = page.getByTestId('screen-releases');
  await expect(grid).toBeVisible();
  await expect(grid.locator('.topbar-title')).toHaveText('Albums');
  await expect(grid.getByTestId('release-title')).toHaveText(['A Night in Neon', 'Analog Dreams', 'Alive', 'Blue Room Sessions', 'Early Tapes', 'Glass Garden']);
  const [a, b] = [await grid.getByTestId('release-card').nth(0).boundingBox(), await grid.getByTestId('release-card').nth(1).boundingBox()];
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2); // side by side
  await grid.getByTestId('release-card').first().click();
  await expect(page.getByTestId('screen-album')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-album')).toHaveCount(0);
  await expect(grid).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('screen-artist')).toBeVisible();

  // Singles' See all lists singles only; EPs' lists EPs only (same token, filtered).
  await page.getByTestId('artist-singles').getByTestId('see-all').click();
  await expect(grid.getByTestId('release-card')).toHaveCount(7);
  await expect(grid.locator('[data-testid="release-card"]:not([data-kind="single"])')).toHaveCount(0);
  await page.getByTestId('releases-back').click();
  await page.getByTestId('artist-eps').getByTestId('see-all').click();
  await expect(grid.getByTestId('release-title')).toHaveText(['Night Shift EP', 'Paper Moons EP', 'Satellite EP']);
  // One artistReleases call per token.
  const calls = await page.evaluate(() => (window as any).__cyberjukeMusicCalls.filter((c: any[]) => c[0] === 'artistReleases').map((c: any[]) => c[1]));
  expect(calls).toEqual([expect.stringMatching(/^rel\|albums\|/), expect.stringMatching(/^rel\|singles\|/)]);
});

test('artist page: empty shelves are hidden', async ({ page }) => {
  await stubMusic(page, { shelves: ['single'] });
  await page.goto('/');
  await openFirstArtist(page);
  await expect(page.getByTestId('artist-singles')).toBeVisible();
  await expect(page.getByTestId('artist-top')).toBeVisible();
  for (const id of ['artist-albums', 'artist-live', 'artist-eps']) await expect(page.getByTestId(id)).toHaveCount(0);
});

test('See all with an expired token offers Retry, which reloads the artist page', async ({ page }) => {
  await stubMusic(page, { evictToken: true });
  await page.goto('/');
  await openFirstArtist(page);
  await page.getByTestId('artist-albums').getByTestId('see-all').click();
  const err = page.getByTestId('releases-error');
  await expect(err).toContainText("Couldn't load this list.");
  await expect(err).not.toContainText(/youtube/i);
  await page.getByTestId('releases-retry').click();
  await expect(page.getByTestId('screen-releases').getByTestId('release-card')).toHaveCount(6);
  const calls = await page.evaluate(() => (window as any).__cyberjukeMusicCalls.map((c: any[]) => c[0]));
  expect(calls.filter((c: string) => c === 'artistPage')).toHaveLength(2);
});
