import { expect, test } from '../../fixtures';
import { clockStart, homeSettled, pickGenre, requestsFor, runFor, start, waitForTracks } from '../../helpers';

/**
 * Browsing the Jukebox on a slow connection (a train, a crowded cell). The backend's `delay`
 * plays the network: Chromium's own throttling (CDP) doesn't touch responses a test supplies
 * through page.route, so the slowness lives in the stub. The page's clock is faked, so the
 * 15 s the app gives a request runs out in an instant instead of being waited for.
 */

test('slow answers show a skeleton, then the rows; one that never comes offers Retry; nothing is asked twice', async ({ page, backend }) => {
  await clockStart(page);
  await start(page);
  // The catalog has loaded (else the delay below would hold it, and the chips would change under the finger).
  await homeSettled(page, backend);
  const home = page.getByTestId('screen-home');

  // Five-second round trips: the skeleton, then the rows. One request.
  backend.delay = 5000;
  const genre1 = await pickGenre(page, 1);
  await expect(home.locator('[data-testid="skeleton"]:visible').first()).toBeVisible();
  await expect(home.getByTestId('error')).toHaveCount(0);
  await waitForTracks(page);
  expect(requestsFor(backend, genre1)).toBe(1);

  // Longer than the app waits: it stops at 15 s and says so, with Retry (still one request:
  // a slow answer isn't a lost one).
  backend.delay = 16_000;
  const genre2 = await pickGenre(page, 2);
  await expect(home.locator('[data-testid="skeleton"]:visible').first()).toBeVisible();
  await runFor(page, 15_100);
  const error = home.getByTestId('error');
  await expect(error).toContainText("Couldn't load the Jukebox");
  await expect(error).toContainText("Cyberspace didn't answer in time");
  await expect(home.getByTestId('offline')).toHaveCount(0);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  expect(requestsFor(backend, genre2)).toBe(1);

  // The connection picks up: Retry loads it, one more request.
  backend.delay = 0;
  await error.getByTestId('retry').click();
  await waitForTracks(page);
  await expect(home.getByTestId('error')).toHaveCount(0);
  expect(requestsFor(backend, genre2)).toBe(2);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});
