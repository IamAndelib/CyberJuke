import { expect, test } from '../../fixtures';
import { fakeYt, setVisibility, start, trackError, waitForTracks, waitingForNetwork } from '../../helpers';

/**
 * A café's Wi-Fi with a login page: the phone says it's connected, but nothing gets through
 * until the page is passed. The backend stub drops every request (`offline`) while the
 * browser stays online, as the OS would report it.
 */

test('behind a Wi-Fi login page the lists say no carrier, the music waits; once through, both come back on the next sign of a connection', async ({ page, backend }) => {
  await start(page);
  const title = (await page.getByTestId('track-title').first().textContent())!.trim();
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-title')).toHaveText(title);
  const home = page.getByTestId('screen-home');
  const chips = page.getByTestId('genre-chip');

  // Sitting down: the phone joins the café's Wi-Fi. The next list hits the portal.
  backend.offline = true;
  await chips.nth(1).click();
  await expect(home.getByTestId('offline')).toBeVisible();
  // The device isn't offline, so no banner: the list alone says it couldn't get through.
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  // Redial: the OS still says connected, the portal still answers nothing.
  await home.getByTestId('retry').click();
  await expect(home.getByTestId('retry')).toHaveAttribute('aria-busy', 'false');
  await expect(home.getByTestId('offline')).toBeVisible();
  // The buffer runs out: native says the signal is lost, and waits.
  await fakeYt(page, 'stall');
  await trackError(page, { kind: 'network', resumes: true });
  await expect(page.getByTestId('toast')).toHaveText(`Signal lost. "${title}" picks up when you're back.`);
  await waitingForNetwork(page, true);
  await expect(page.getByTestId('mini-waiting')).toHaveText('Waiting for carrier…');

  // The login page is passed; the OS reports the connection again. No tap needed.
  backend.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitForTracks(page);
  await expect(home.getByTestId('offline')).toHaveCount(0);
  await waitingForNetwork(page, false);
  await fakeYt(page, 'resume');
  await expect(page.getByTestId('mini-waiting')).toHaveCount(0);
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  await expect(page.getByTestId('mini-title')).toHaveText(title);

  // The portal's session expires while the app is in the background; a list opened on the way
  // back fails. Logging in again, then returning to the app, is enough: it reloads.
  backend.offline = true;
  await chips.nth(2).click();
  await expect(home.getByTestId('offline')).toBeVisible();
  await setVisibility(page, 'hidden');
  backend.offline = false;
  await setVisibility(page, 'visible');
  await waitForTracks(page);
  await expect(home.getByTestId('offline')).toHaveCount(0);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
});
