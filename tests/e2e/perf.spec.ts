import { expect, test } from '../fixtures';
import { start } from '../helpers';

/**
 * Playback must not re-render the screen. Counts Preact renders through the dev/test
 * `options` hook (window.__cyberjukeRenders) while a track plays with Now Playing
 * closed. Before this was fixed: App re-rendered every second and the tree did ~200
 * component renders a second.
 */

type Renders = { counts: Record<string, number>; reset(): void };

test('playback with the sheet closed re-renders (almost) nothing', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  // Wait for playback to have settled (buffering over: the progress bar moves).
  const progress = () => page.getByTestId('mini-progress').evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--progress')));
  const p0 = await progress();
  await expect.poll(progress).toBeGreaterThan(p0);

  await page.evaluate(() => (window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.reset());
  const t0 = Date.now();
  // About 4 s of playback: the fake player's clock (and our progress bar) keeps moving.
  const p1 = await progress();
  await expect.poll(async () => (await progress()) - p1, { timeout: 10_000 }).toBeGreaterThan((4 / 247) * 100);
  const secs = (Date.now() - t0) / 1000;
  const counts = await page.evaluate(() => ({ ...(window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.counts }));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.info(`renders over ${secs.toFixed(1)} s: ${JSON.stringify(counts)} (${(total / secs).toFixed(2)}/s)`);
  expect((counts.App ?? 0) / secs, 'full-app renders per second').toBeLessThan(2);
  expect(counts.App ?? 0).toBe(0);
  expect(counts.TrackRow ?? 0).toBe(0);
  expect(total / secs, 'component renders per second').toBeLessThan(2);

  // Control: the counter does count (opening Now Playing renders it).
  await page.getByTestId('mini-open').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.counts.NowPlaying ?? 0)).toBeGreaterThan(0);
});
