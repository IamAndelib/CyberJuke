import { expect, test } from '../fixtures';
import { seedStorage, start } from '../helpers';

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
  // Percent played: the fill's scaleX as last written (not mid-transition).
  const progress = () => page.getByTestId('mini-progress').evaluate((el) => 100 * Number(/scaleX\(([\d.]+)\)/.exec((el.firstElementChild as HTMLElement).style.transform)?.[1] ?? 0));
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

/**
 * With Now Playing open, the clock ticking re-renders the clock and the seek bar, not the
 * sheet. Before this was fixed, the whole sheet (Up next, every row's art) re-rendered every
 * second: about 120 component renders a second with a full Up next.
 */
test('playback with Now Playing open re-renders the clock, not the sheet', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await page.getByTestId('mini-open').click();
  await expect(page.getByTestId('upnext-row').first()).toBeVisible();
  const time = page.getByTestId('time-pos');
  const t1 = await time.textContent();
  await expect(time).not.toHaveText(t1!);
  await page.evaluate(() => (window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.reset());
  const t0 = Date.now();
  const t2 = await time.textContent();
  // Four ticks of the clock.
  for (let i = 0; i < 4; i++) {
    const t = await time.textContent();
    await expect(time).not.toHaveText(t!);
  }
  const secs = (Date.now() - t0) / 1000;
  const counts = await page.evaluate(() => ({ ...(window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.counts }));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.info(`Now Playing open, ${t2} on, renders over ${secs.toFixed(1)} s: ${JSON.stringify(counts)} (${(total / secs).toFixed(2)}/s)`);
  expect(counts.NowPlaying ?? 0).toBe(0);
  // About 1 a second; room for an incidental render (a feed refresh) on a slow runner.
  expect(total / secs, 'component renders per second').toBeLessThan(5);
});

/**
 * A star tap re-renders the star (and its tile), never the grid or page around it. Before
 * this was fixed, the favourites were read at the top of the grids and pages: one tap
 * re-rendered every tile of the Artists grid, even from an artist page on top of it.
 * Times are logged with the CPU slowed 4×, like a mid-range phone.
 */
test('a favourite star tap re-renders the star, not the grid or page around it', async ({ page }) => {
  await start(page);
  const renders = () => page.evaluate(() => ({ ...(window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.counts }));
  const reset = () => page.evaluate(() => (window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.reset());
  // Tap, then wait for the frame that shows it: what the finger feels.
  const tap = (selector: string) =>
    page.evaluate(async (sel) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const t0 = performance.now();
      el.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return Math.round(performance.now() - t0);
    }, selector);
  const cdp = await page.context().newCDPSession(page);
  // The page has finished loading (its shelves, its tracks): nothing renders for 600 ms.
  const quiet = () =>
    expect(async () => {
      await reset();
      await page.waitForTimeout(600);
      expect(Object.keys(await renders())).toHaveLength(0);
    }).toPass({ timeout: 15_000 });

  await page.getByTestId('tab-artists').click();
  // Every tile rendered (the grid fills in chunks).
  await expect.poll(() => page.getByTestId('artist-cell').count(), { timeout: 15_000 }).toBeGreaterThan(300);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const results: Record<string, unknown> = {};

  // 1. A tile's star on the Artists grid.
  await reset();
  results.gridMs = await tap('[data-testid="artist-grid"] [data-testid="artist-fav"]');
  // Moved up into ★ Favourites (gone from the grid).
  await expect(page.getByTestId('fav-artists').getByTestId('artist-fav')).toHaveAttribute('aria-pressed', 'true');
  const grid = await renders();
  results.grid = grid;

  // 2. The star on an artist page, with the Artists grid mounted behind it.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.locator('[data-testid="artist-grid"] [data-testid="artist-tile"]').nth(3).click();
  await expect(page.getByTestId('artist-page-fav')).toBeVisible();
  await quiet();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await reset();
  results.artistPageMs = await tap('[data-testid="artist-page-fav"]');
  await expect(page.getByTestId('artist-page-fav')).toHaveAttribute('aria-pressed', 'true');
  const artistPage = await renders();
  results.artistPage = artistPage;

  // 3. The star on a genre page.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-tile').first().click();
  await expect(page.getByTestId('genre-page-fav')).toBeVisible();
  await quiet();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await reset();
  results.genrePageMs = await tap('[data-testid="genre-page-fav"]');
  await expect(page.getByTestId('genre-page-fav')).toHaveAttribute('aria-pressed', 'true');
  const genrePage = await renders();
  results.genrePage = genrePage;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  console.info(`favourite taps (CPU 4× slower): ${JSON.stringify(results)}`);

  for (const c of [grid, artistPage, genrePage]) {
    for (const big of ['App', 'ArtistGrid', 'ArtistTiles', 'ArtistPage', 'GenreGrid', 'GenreTiles', 'GenreDetail', 'TrackRow']) {
      expect(c[big] ?? 0, `${big} re-rendered`).toBe(0);
    }
  }
  // The tapped tile, and its copy in ★ Favourites.
  expect(grid.ArtistTile ?? 0).toBeLessThanOrEqual(2);
  expect(artistPage.ArtistTile ?? 0).toBeLessThanOrEqual(2);
});

/**
 * A track change re-renders the rows it concerns (the one that stops and the one that
 * starts being current), not the lists around them. Before this was fixed, the Library
 * re-rendered on every track change (its Recently played count), and every row with it;
 * Recently played rendered its whole history (up to 1000 rows) at once.
 */
test('a track change re-renders the current rows, not the lists; history renders in chunks', async ({ page }) => {
  const tr = (i: number) => ({ id: `seed${i}`, ytId: `abcdefg${String(i).padStart(4, '0')}`, title: `Seeded ${i}`, artist: 'Seeded Artist', genre: 'test', by: 'someone' });
  const now = Date.now();
  await seedStorage(page, {
    'CapacitorStorage.liked': Array.from({ length: 200 }, (_, i) => tr(i)),
    'CapacitorStorage.history': Array.from({ length: 400 }, (_, i) => ({ track: tr(1000 + i), playedAt: now - i * 60_000 })),
  });
  await start(page);
  await page.getByTestId('track-play').first().click();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-row').first()).toBeVisible();
  const renders = () => page.evaluate(() => ({ ...(window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.counts }));
  const reset = () => page.evaluate(() => (window as unknown as { __cyberjukeRenders: Renders }).__cyberjukeRenders.reset());
  await reset();
  for (let i = 0; i < 3; i++) {
    const title = await page.getByTestId('mini-title').textContent();
    await page.getByTestId('mini-next').click();
    await expect(page.getByTestId('mini-title')).not.toHaveText(title!);
  }
  const liked = await renders();
  console.info(`3 track changes on Liked: ${JSON.stringify(liked)}`);
  expect(liked.Library ?? 0).toBe(0);
  expect(liked.TrackRow ?? 0).toBeLessThanOrEqual(6);

  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('recent-list').getByTestId('track-row').first()).toBeVisible();
  // The first chunk, not all 400 plays.
  expect(await page.getByTestId('recent-list').getByTestId('track-row').count()).toBeLessThan(150);
});
