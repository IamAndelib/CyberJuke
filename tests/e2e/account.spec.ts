import { AUTH_USER, BANNED_POST, expect, MEMBERS_POSTS, test } from '../fixtures';
import type { Page } from '@playwright/test';
import { playerCalls, seedStorage, start, toastsGone, waitForTracks } from '../helpers';

/** Optional "Sign in with Cyberspace": members-only posts, errors, token refresh, sign-out. */

async function signIn(page: Page, email = AUTH_USER.email, password = AUTH_USER.password) {
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('signin-email').fill(email);
  await page.getByTestId('signin-password').fill(password);
  await page.getByTestId('signin-submit').click();
}

const homeRow = (page: Page, title: string) =>
  page.getByTestId('screen-home').getByTestId('track-row').filter({ has: page.getByTestId('track-title').getByText(title, { exact: true }) });

test('signed out: the Account card offers sign-in; nothing is members-only', async ({ page, backend }) => {
  await start(page);
  await expect(page.getByTestId('members-tag')).toHaveCount(0);
  await page.getByTestId('tab-settings').click();
  const card = page.getByTestId('account');
  await expect(card).toContainText('Sign in with Cyberspace');
  await expect(page.getByTestId('signin-note')).toHaveText('Your password goes only to Cyberspace.');
  await expect(card.getByRole('link', { name: 'Create one on cyberspace.online' })).toBeVisible();
  for (const id of ['signin-email', 'signin-password', 'signin-submit', 'signin-reveal']) {
    expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByTestId('signin-reveal').click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  // Signed out, no request ever carries a token.
  expect(backend.calls.members).toBe(0);
  expect(backend.calls.public).toBeGreaterThan(0);
});

test('signing in shows [members] posts in Latest, search and Now Playing; signing out removes them everywhere', async ({ page, backend }) => {
  await start(page);
  await expect(homeRow(page, MEMBERS_POSTS[0].title)).toHaveCount(0);
  await signIn(page);
  await expect(page.getByTestId('signed-in')).toBeVisible();
  await expect(page.getByTestId('account-name')).toHaveText('@' + AUTH_USER.username);
  await expect(page.getByTestId('signin-form')).toHaveCount(0);
  expect(backend.calls.signIn).toBe(1);

  // Home: members-only posts on top, tagged; the banned post is hidden.
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  const row = homeRow(page, MEMBERS_POSTS[0].title);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('members-tag')).toHaveText('[members]');
  await expect(page.getByTestId('screen-home').getByTestId('track-title').first()).toHaveText(MEMBERS_POSTS[0].title);
  await expect(homeRow(page, BANNED_POST.title)).toHaveCount(0);
  const firstPublic = page.getByTestId('screen-home').getByTestId('track-row').nth(MEMBERS_POSTS.length);
  await expect(firstPublic.getByTestId('members-tag')).toHaveCount(0);

  // The members query, with the token, no isPublic / ban filters.
  expect(backend.tokens.every((t) => t === 'Bearer fake-id-1')).toBe(true);
  const q = backend.memberBodies[0];
  expect(JSON.stringify(q.where)).not.toMatch(/isPublic|isBanned|isShadowBanned/);
  expect(q.orderBy!.map((o) => o.field.fieldPath)).toEqual(['createdAt', '__name__']);

  // Like it and play it (history), and look at its lyrics (cache): all members-only.
  await row.getByTestId('track-more').click();
  await page.getByTestId('menu-like').click();
  await row.getByTestId('track-play').click();
  await page.getByTestId('mini-open').click();
  await expect(page.getByTestId('now-playing').getByTestId('members-tag')).toBeVisible();
  await page.getByTestId('np-lyrics-toggle').click();
  await expect(page.getByTestId('np-lyrics')).not.toHaveAttribute('data-kind', 'loading');
  await page.getByTestId('np-close').click();

  // Search (the catalog, fully refreshed after sign-in) finds them, tagged; never the banned one.
  await page.getByTestId('search-fab').click();
  await page.getByTestId('search-input').fill(MEMBERS_POSTS[1].title);
  const results = page.getByTestId('search-results');
  await expect(results.getByTestId('track-title').first()).toHaveText(MEMBERS_POSTS[1].title);
  await expect(results.getByTestId('members-tag').first()).toBeVisible();
  await page.getByTestId('search-input').fill(BANNED_POST.title);
  await expect(page.getByTestId('search').getByTestId('track-title').getByText(BANNED_POST.title)).toHaveCount(0);
  await page.getByTestId('search-close').click();

  // A genre page, signed in, filters the catalog (no genre query).
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-grid').getByTestId('genre-tile').first().click();
  await expect(page.getByTestId('screen-genre').getByTestId('track-row').first()).toBeVisible();
  await page.getByTestId('genre-back').click();
  expect(backend.memberBodies.some((b) => JSON.stringify(b.where).includes('audioAttachmentGenre'))).toBe(false);

  // The password and the refresh token are nowhere in web storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(AUTH_USER.password);
  expect(stored).not.toContain('fake-refresh');
  // The members catalog is its own file.
  expect(stored).toContain('cyberjuke/catalog-members.json');

  // Sign out: members posts are gone from Home, search, Liked, history, the lyrics cache and storage.
  await page.getByTestId('tab-settings').click();
  // Sign out asks first (M3).
  await page.getByTestId('signout').click();
  const confirm = page.getByTestId('confirm-sheet');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Members-only tracks will be hidden');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('signin-form')).toBeVisible();
  // The members-only track that was playing left the queue too (K5).
  await expect.poll(async () => (await playerCalls(page)).some((c) => c[0] === 'removeIds' && JSON.stringify(c[1]).includes(MEMBERS_POSTS[0].id))).toBe(true);
  await expect(page.getByTestId('mini-player')).not.toContainText(MEMBERS_POSTS[0].title);
  const before = backend.calls.members;
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  await expect(homeRow(page, MEMBERS_POSTS[0].title)).toHaveCount(0);
  await expect(page.getByTestId('screen-home').getByTestId('members-tag')).toHaveCount(0);
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-row')).toHaveCount(0);
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('recent-list').getByText(MEMBERS_POSTS[0].title)).toHaveCount(0);
  await page.getByTestId('search-fab').click();
  await page.getByTestId('mode-jukebox').click();
  await page.getByTestId('search-input').fill(MEMBERS_POSTS[1].title);
  await expect(page.getByTestId('search-results').or(page.getByTestId('search-empty'))).toBeVisible();
  await expect(page.getByTestId('search').getByTestId('track-title').getByText(MEMBERS_POSTS[1].title)).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((ids) => {
      const all = JSON.stringify({ ...localStorage });
      return ids.some((id) => all.includes(id)) || all.includes('cyberjuke/catalog-members.json');
    }, MEMBERS_POSTS.map((p) => p.id)))
    .toBe(false);
  expect(backend.calls.members).toBe(before);
  await toastsGone(page);
});

test('signed out at startup: members-only tracks restored from a backup are dropped', async ({ page }) => {
  const tr = (id: string, title: string, membersOnly = false) => ({
    id,
    ytId: 'abcdefghij' + id.slice(-1),
    title,
    artist: 'Seeded Artist',
    genre: 'test',
    by: 'someone',
    postTitle: '',
    postUrl: '',
    createdAt: '2026-01-01T00:00:00Z',
    nsfw: false,
    artworkUrl: '',
    ...(membersOnly && { membersOnly: true }),
  });
  await seedStorage(page, {
    'CapacitorStorage.liked': [tr('m1', 'Members Liked', true), tr('p2', 'Public Liked')],
    'CapacitorStorage.history': [
      { track: tr('m3', 'Members Played', true), playedAt: Date.now() - 60_000 },
      { track: tr('p4', 'Public Played'), playedAt: Date.now() - 120_000 },
    ],
  });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-title')).toHaveText(['Public Liked']);
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('recent-list').getByTestId('track-title')).toHaveText(['Public Played']);
  await expect.poll(() => page.evaluate(() => /Members (Liked|Played)/.test(JSON.stringify({ ...localStorage })))).toBe(false);
});

test('sign-in errors: wrong password, too many attempts, no network', async ({ page }) => {
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

test.describe('a token Firestore rejects', () => {
  test.use({ backendOptions: { rejectFirstToken: true } });
  test('is refreshed (401) and the request retried once', async ({ page, backend }) => {
    await start(page);
    await signIn(page);
    await expect(page.getByTestId('signed-in')).toBeVisible();
    await page.getByTestId('tab-home').click();
    await expect(homeRow(page, MEMBERS_POSTS[0].title)).toBeVisible();
    expect(backend.calls.unauthorized).toBe(1);
    expect(backend.calls.refresh).toBe(1);
    expect(backend.tokens[0]).toBe('Bearer fake-id-1');
    expect(backend.tokens).toContain('Bearer fake-id-2');
  });
});
