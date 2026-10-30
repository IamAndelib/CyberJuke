import { expect, test } from '../fixtures';
import { box, isFeedQuery, openNowPlaying, openSettings, seedStorage, start, toastsGone, waitForTracks } from '../helpers';

/** Home: the Latest feed, genre chips, Most saved, the new-tracks pill and the CI autoplay hook. */

test('tracks load on Home', async ({ page }) => {
  await start(page);
  const rows = page.getByTestId('track-row');
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  const titles = await page.getByTestId('track-title').allTextContents();
  expect(titles.every((t) => t.trim().length > 0)).toBe(true);
  await expect(rows.first()).toContainText('by @');
  await expect(page.getByTestId('sort-latest')).toHaveAttribute('aria-selected', 'true');
  // Home has no Play all (genre pages and Library keep theirs).
  await expect(page.getByTestId('home-play-all')).toHaveCount(0);
  // Signed out: no members-only, banned or deleted posts.
  await expect(page.getByTestId('members-tag')).toHaveCount(0);
});

test('a genre chip filters the list', async ({ page }) => {
  await start(page);
  const chip = page.getByTestId('genre-chip').first();
  const genre = (await chip.getAttribute('data-genre'))!;
  expect(genre).toBeTruthy();
  // Toggle buttons (aria-pressed), not tabs.
  await expect(page.getByTestId('genre-chips')).not.toHaveAttribute('role', 'tablist');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('chip-all')).toHaveAttribute('aria-pressed', 'false');
  await waitForTracks(page);
  const tags = await page.getByTestId('track-list').locator('.tag').allTextContents();
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t.trim()).toBe(genre);
  await page.getByTestId('chip-all').click();
  await expect(page.getByTestId('chip-all')).toHaveAttribute('aria-pressed', 'true');
});

test('a genre of several words fills its chip too (Cyberspace queries it by its slug)', async ({ page }) => {
  await start(page);
  const genre = (await page.locator('[data-testid="genre-chip"][data-genre*=" "]').first().getAttribute('data-genre'))!;
  // By name: the chips may reorder as the catalog loads.
  await page.locator(`[data-testid="genre-chip"][data-genre="${genre}"]`).click();
  await waitForTracks(page);
  const tags = await page.getByTestId('track-list').locator('.tag').allTextContents();
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t.trim()).toBe(genre);
});

test('?autoplay=latest starts the newest track (CI hook, test builds only)', async ({ page }) => {
  await page.goto('/?autoplay=latest');
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await waitForTracks(page);
  const first = (await page.getByTestId('track-title').first().innerText()).trim();
  await expect(page.getByTestId('mini-title')).toHaveText(first);
});

test('Latest | Most saved and the range are Rails', async ({ page }) => {
  await start(page);
  await expect(page.getByTestId('home-sort')).toHaveAttribute('role', 'tablist');
  await expect(page.getByTestId('saved-range')).toHaveCount(0);
  await page.getByTestId('sort-saved').click();
  await expect(page.getByTestId('sort-saved')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('saved-range')).toHaveAttribute('role', 'radiogroup');
  await expect(page.getByTestId('range-month')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('range-all').click();
  await expect(page.getByTestId('range-all')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('saved-list')).toBeVisible();
  await expect(page.locator('.sort-tab, .segmented.range')).toHaveCount(0);
});

test('Most saved, all time, lists tracks by descending saves', async ({ page }) => {
  await start(page);
  await page.getByTestId('sort-saved').click();
  await page.getByTestId('range-all').click();
  const saves = page.getByTestId('saved-list').getByTestId('track-saves');
  await expect(saves.first()).toBeVisible();
  const counts = await saves.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-saves'))));
  expect(counts.length).toBeGreaterThanOrEqual(10);
  expect(counts[0]).toBeGreaterThan(1);
  for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
  expect(counts.every((c) => c >= 1)).toBe(true);
  await expect(saves.first()).toHaveText(String(counts[0]));
  // The sort survives a tab switch.
  await page.getByTestId('tab-library').click();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('sort-saved')).toHaveAttribute('aria-selected', 'true');
});

test('the search button sits above the tab bar, then above the mini player; hidden in Settings', async ({ page }) => {
  await start(page);
  const fab = page.getByTestId('search-fab');
  const f0 = await box(fab);
  expect(f0.y + f0.height).toBeLessThanOrEqual((await box(page.locator('.tabbar'))).y);
  await page.getByTestId('track-play').first().click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await expect.poll(async () => (await box(fab)).y + (await box(fab)).height).toBeLessThanOrEqual((await box(page.getByTestId('mini-player'))).y);
  expect((await box(fab)).width).toBeGreaterThanOrEqual(44);
  await openSettings(page);
  await expect(fab).toHaveCount(0);
});

test('the new-tracks pill appears when there are newer posts; tapping it refreshes and scrolls to the top', async ({ page }) => {
  const future = Date.now() + 3600_000;
  let latestFetches = 0;
  await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    const q = JSON.parse(route.request().postData() ?? '{}').structuredQuery;
    const fields: string[] = q.select?.fields?.map((f: { fieldPath: string }) => f.fieldPath) ?? [];
    if (fields[0] === 'createdAt' && q.limit === 25) {
      // The freshness check: createdAt (and, NSFW hidden, isNSFW) mask, createdAt > newest.
      expect(fields).toEqual(['createdAt', 'isNSFW']);
      expect(JSON.stringify(q.where)).toContain('GREATER_THAN');
      const rows = [0, 1, 2, 3].map((i) => ({
        document: {
          name: `projects/p/databases/(default)/documents/posts/new${i}`,
          fields: { createdAt: { timestampValue: new Date(future - i * 1000).toISOString() }, isNSFW: { booleanValue: i === 3 } },
        },
        readTime: new Date().toISOString(),
      }));
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(rows) });
    }
    if (isFeedQuery(q) && !q.startAt && q.where.compositeFilter.filters.length === 5) latestFetches++;
    return route.fallback();
  });
  await start(page);
  const first = (await page.getByTestId('track-title').first().innerText()).trim();
  const before = latestFetches;
  await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, 900));

  await page.evaluate(() => (window as unknown as { __cyberjukeFreshness: { check(): Promise<void> } }).__cyberjukeFreshness.check());
  const pill = page.getByTestId('new-tracks-pill');
  // The NSFW post isn't counted while NSFW is hidden.
  await expect(pill).toHaveText(/3 new tracks/);
  expect((await page.getByTestId('track-title').first().innerText()).trim()).toBe(first);
  expect(latestFetches).toBe(before);

  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect.poll(() => page.getByTestId('screen-home').evaluate((el) => el.scrollTop)).toBeLessThan(5);
  await expect.poll(() => latestFetches).toBeGreaterThan(before);
  await waitForTracks(page);
  await toastsGone(page);
});

test('the new-tracks pill on Most saved or a genre chip shows Latest from every genre, where the new posts are', async ({ page }) => {
  const future = Date.now() + 3600_000;
  await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    const q = JSON.parse(route.request().postData() ?? '{}').structuredQuery;
    if (q.select?.fields?.[0]?.fieldPath === 'createdAt' && q.limit === 25) {
      const rows = [{ document: { name: 'projects/p/databases/(default)/documents/posts/new0', fields: { createdAt: { timestampValue: new Date(future).toISOString() }, isNSFW: { booleanValue: false } } }, readTime: new Date().toISOString() }];
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(rows) });
    }
    return route.fallback();
  });
  await start(page);
  await page.getByTestId('genre-chip').first().click();
  await page.getByTestId('sort-saved').click();
  await page.evaluate(() => (window as unknown as { __cyberjukeFreshness: { check(): Promise<void> } }).__cyberjukeFreshness.check());
  const pill = page.getByTestId('new-tracks-pill');
  await expect(pill).toHaveText(/1 new track/);
  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect(page.getByTestId('sort-latest')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('chip-all')).toHaveAttribute('aria-pressed', 'true');
  await waitForTracks(page);
});

test('a song picture still on its way leaves a dark box, not a bright square (dark theme)', async ({ page }) => {
  await seedStorage(page, { 'CapacitorStorage.settings': { theme: 'dark' } });
  // The pictures never arrive (a slow connection, or a list that just opened).
  await page.route(/^https:\/\/i\.ytimg\.com\//, () => undefined);
  await start(page);
  const png = await page.getByTestId('track-row').first().locator('.art').screenshot();
  // Mean luminance of the box (0 black, 1 white), decoded in the page (no network, so no CSP).
  const lum = await page.evaluate(async (bytes) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4) / 255;
  }, [...png]);
  expect(lum).toBeLessThan(0.3);
});

test("Shuffle follows the genre chip: that genre's songs, and more of them after", async ({ page }) => {
  type Q = { context: { label: string } | null; list: { genre: string }[]; autoplay: { genre: string }[] };
  const queue = () => page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => Q }).__cyberjukeQueue());
  await start(page);
  const hero = page.getByTestId('shuffle-all');
  await expect(hero).toContainText('Shuffle the Jukebox');
  await expect(hero).toContainText('Random picks from the whole Jukebox');
  const chip = page.getByTestId('genre-chip').first();
  const genre = (await chip.getAttribute('data-genre'))!;
  await chip.click();
  await expect(hero).toContainText(`Shuffle ${genre}`);
  await expect(hero).toContainText(`Random picks from ${genre}`);
  await hero.click();
  await expect.poll(async () => (await queue()).list.length).toBeGreaterThan(0);
  expect((await queue()).context?.label).toBe(`Jukebox shuffle · ${genre}`);
  // Already random: played in that order, and the Shuffle button stays off for the next list.
  await openNowPlaying(page);
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('np-close').click();
  // Near the end of the list: more of the genre after it.
  await openNowPlaying(page);
  await page.locator('[data-testid="upnext-row"][data-section="list"] .row-main').last().click();
  await expect.poll(async () => (await queue()).autoplay.length, { message: 'more of the genre after the list' }).toBeGreaterThan(0);
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveText(`More random picks from ${genre}`);
  const q = await queue();
  expect([...q.list, ...q.autoplay].every((t) => t.genre === genre)).toBe(true);
  await page.getByTestId('np-close').click();
  // Back to All: the whole Jukebox again.
  await page.getByTestId('chip-all').click();
  await expect(hero).toContainText('Shuffle the Jukebox');
});
