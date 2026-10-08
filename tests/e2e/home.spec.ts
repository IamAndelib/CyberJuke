import { expect, test } from '../fixtures';
import { box, start, toastsGone, waitForTracks } from '../helpers';

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
  await page.getByTestId('tab-settings').click();
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
    if (!q.select && !q.startAt && q.where.compositeFilter.filters.length === 5) latestFetches++;
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
