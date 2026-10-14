import { expect, test } from '../../fixtures';
import { clockStart, fakeYt, playerCalls, runFor, setOffline, start, trackError, waitForTracks, waitingForNetwork } from '../../helpers';

/**
 * A commute: music on, the phone drifting from Wi-Fi to mobile data, then through a tunnel.
 * The connection's story is the OS's (setOffline, with the usual handover grace); the
 * player's is what native would report (the stall, the track error, waiting for the carrier),
 * injected through the web player's hooks. The clock is faked so the grace and the waiting
 * delay pass in an instant.
 */

const BANNER = '[ offline ] no carrier · connect to play';

test('a commute: a handover changes nothing; a tunnel pauses the music, which picks up, with the list, once out', async ({ page, backend }) => {
  await clockStart(page);
  await start(page);
  // The usual grace (the fixture turns it off): a lost connection counts after 3 s.
  await page.evaluate(() => (window.__cyberjukeOfflineGraceMs = 3000));
  const title = (await page.getByTestId('track-title').first().textContent())!.trim();
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');

  // Leaving the house: Wi-Fi to mobile data, "not connected" for a second. Nothing shows.
  await setOffline(page, backend, true);
  await runFor(page, 1000);
  await setOffline(page, backend, false);
  await runFor(page, 5000);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await expect(page.getByTestId('mini-title')).toHaveText(title);

  // The tunnel: the stream stalls, and the connection is gone for longer than the grace.
  await setOffline(page, backend, true);
  await fakeYt(page, 'stall');
  await runFor(page, 3500);
  await expect(page.getByTestId('offline-banner')).toHaveText(BANNER);
  // A genre opened now has no carrier (it loads by itself later).
  await page.getByTestId('genre-chip').nth(1).click();
  const home = page.getByTestId('screen-home');
  await expect(home.getByTestId('offline')).toBeVisible();
  // Native gives up on the stream: the signal is lost, and it picks up by itself; then it waits.
  await trackError(page, { kind: 'network', resumes: true });
  await expect(page.getByTestId('toast')).toHaveText(`Signal lost. "${title}" picks up when you're back.`);
  await waitingForNetwork(page, true);
  await runFor(page, 1100);
  await expect(page.getByTestId('mini-waiting')).toHaveText('Waiting for carrier…');
  // The track wasn't skipped, nothing else was started.
  await expect(page.getByTestId('mini-title')).toHaveText(title);

  // Out of the tunnel: the banner goes, the music plays on, the list on screen loads by itself.
  await setOffline(page, backend, false);
  await waitingForNetwork(page, false);
  await fakeYt(page, 'resume');
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await expect(page.getByTestId('mini-waiting')).toHaveCount(0);
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  await waitForTracks(page);
  await expect(home.getByTestId('offline')).toHaveCount(0);
  await expect(page.getByTestId('mini-title')).toHaveText(title);
  expect((await playerCalls(page)).filter((c) => c[0] === 'setQueue')).toHaveLength(1);
});
