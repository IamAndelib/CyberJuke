import { expect, test } from '../../fixtures';
import { fakeYt, homeSettled, pickGenre, playerCalls, requestsFor, start, waitForTracks, waitingForNetwork } from '../../helpers';

/**
 * Leaving Wi-Fi for mobile data, twice, with music playing and the Jukebox being browsed. The
 * OS reports each switch within the handover grace, so the app never counts as offline; what
 * breaks is a request caught in the gap (the backend drops it: `failNext`). One dropped
 * request is sent again by itself; a list whose second try is dropped too waits for the next
 * word from the OS, and the stalled music says it waits for the carrier.
 */

test('two handovers: a dropped request is retried by itself; a list that failed twice reloads when the OS reports connected', async ({ page, backend }) => {
  await start(page);
  // A grace a handover never outlasts: the app stays "online" throughout.
  await page.evaluate(() => (window.__cyberjukeOfflineGraceMs = 60_000));
  const title = (await page.getByTestId('track-title').first().textContent())!.trim();
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);
  // The start-up's own requests (the catalog) are done: what is dropped below is the genre page's.
  await homeSettled(page, backend);
  const home = page.getByTestId('screen-home');

  // The first handover: the genre page's request is lost in the gap. It is sent again a
  // second later, and the rows come as if nothing had happened.
  backend.failNext = 1;
  const genre1 = await pickGenre(page, 1);
  await waitForTracks(page);
  expect(requestsFor(backend, genre1)).toBe(2);
  await expect(home.getByTestId('offline')).toHaveCount(0);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveCount(0);

  // The second one takes longer: both tries are lost, and the music stalls meanwhile.
  backend.failNext = 2;
  const genre2 = await pickGenre(page, 2);
  await fakeYt(page, 'stall');
  await waitingForNetwork(page, true);
  await expect(home.getByTestId('offline')).toBeVisible();
  // The device isn't offline: no banner; the list alone says it couldn't get through.
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await expect(page.getByTestId('mini-waiting')).toHaveText('Waiting for carrier…');
  expect(requestsFor(backend, genre2)).toBe(2);

  // The OS says "connected" at the end of the handover: the list loads by itself, no tap.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitForTracks(page);
  await expect(home.getByTestId('offline')).toHaveCount(0);
  expect(requestsFor(backend, genre2)).toBe(3);
  await waitingForNetwork(page, false);
  await fakeYt(page, 'resume');
  await expect(page.getByTestId('mini-waiting')).toHaveCount(0);
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  await expect(page.getByTestId('mini-title')).toHaveText(title);
  // Nothing was skipped or restarted, and nothing complained.
  expect((await playerCalls(page)).filter((c) => c[0] === 'setQueue')).toHaveLength(1);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});
