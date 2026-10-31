import { AUTH_USER, expect, MEMBERS_POSTS, test } from '../../fixtures';
import type { Page } from '@playwright/test';
import { openSettings, playerCalls, saved, setOffline, start, toastsGone, waitForTracks } from '../../helpers';

/**
 * Signed in, a members-only track is liked and played; the listening cache is still saving it
 * when the user signs out. The web has no cache, so the test hook plays native's part: it says
 * which liked songs are saved (the public one, not the members-only one still downloading).
 * What must hold: native hears the new Liked before `signedOut`, the track leaves Liked, the
 * queue and Recently played, and nothing complains.
 */

const BANNER_LIKED = '[ offline ] no carrier · your liked songs still play';

const homeRow = (page: Page, title: string) =>
  page.getByTestId('screen-home').getByTestId('track-row').filter({ has: page.getByTestId('track-title').getByText(title, { exact: true }) });


test('signing out while a members-only like is being saved: Liked is sent first, then signedOut; the track is gone everywhere, quietly', async ({ page, backend }) => {
  await start(page);
  await openSettings(page);
  await page.getByTestId('signin-email').fill(AUTH_USER.email);
  await page.getByTestId('signin-password').fill(AUTH_USER.password);
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signed-in')).toBeVisible();
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);

  // Like a public track, then the members-only one on top, and play it.
  const members = MEMBERS_POSTS[0];
  const publicRow = page.getByTestId('screen-home').getByTestId('track-row').nth(MEMBERS_POSTS.length);
  const publicTitle = (await publicRow.getByTestId('track-title').textContent())!.trim();
  await publicRow.getByTestId('track-more').click();
  await page.getByTestId('menu-like').click();
  await homeRow(page, members.title).getByTestId('track-more').click();
  await page.getByTestId('menu-like').click();
  await homeRow(page, members.title).getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(members.title);
  const cacheCalls = async () => (await playerCalls(page)).filter((c) => c[0] === 'setLikedIds' || c[0] === 'signedOut');
  // Native got Liked, newest like first; it saves the public one at once, the members-only one is still on its way.
  await expect.poll(async () => (await cacheCalls()).at(-1)?.[1]).toEqual([members.yt, expect.any(String)]);
  const publicYt = ((await cacheCalls()).at(-1)![1] as string[])[1];
  await saved(page, [publicYt]);
  await toastsGone(page);
  const before = (await cacheCalls()).length;

  // Sign out (it asks first).
  await openSettings(page);
  await page.getByTestId('signout').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('signin-form')).toBeVisible();

  // Native hears Liked without the members-only song first, then that the user signed out:
  // the save in progress is dropped with its audio, the public song stays saved.
  await expect.poll(async () => (await cacheCalls()).slice(before)).toEqual([
    ['setLikedIds', [publicYt]],
    ['signedOut'],
  ]);
  // The playing track left the queue (K5), Liked and Recently played.
  await expect.poll(async () => (await playerCalls(page)).some((c) => c[0] === 'removeIds' && JSON.stringify(c[1]).includes(members.id))).toBe(true);
  await expect(page.getByTestId('mini-player')).not.toContainText(members.title);
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-title')).toHaveText([publicTitle]);
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('recent-list').getByText(members.title)).toHaveCount(0);
  await toastsGone(page);
  expect(backend.calls.members).toBeGreaterThan(0);

  // On the train home, offline: the public like still plays; nothing remembers the other one.
  await setOffline(page, backend, true);
  await expect(page.getByTestId('offline-banner')).toHaveText(BANNER_LIKED);
  await page.getByTestId('lib-liked').click();
  const row = page.getByTestId('liked-list').getByTestId('track-row');
  await expect(row).toHaveCount(1);
  await expect(row.first().getByTestId('track-play')).not.toHaveAttribute('aria-disabled');
  await expect(page.getByTestId('toast')).toHaveCount(0);
});
