import { ATTACHMENT_ONLY_GENRE, expect, test } from '../fixtures';
import { openNowPlaying, start, waitForTracks } from '../helpers';

/** Genres and Artists grids: Popular / A–Z, favorites, genre pages. */

test('the Genres tab lists genres and opens a genre list', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const tile = page.getByTestId('genre-tile').first();
  await expect(tile).toBeVisible();
  const genre = (await tile.getAttribute('data-genre'))!;
  await tile.click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await waitForTracks(page);
  await expect(page.getByTestId('genre-play-all')).toBeEnabled();
  await expect(page.getByTestId('screen-genre').locator('.topbar-title')).toHaveText(genre);
  for (const t of await page.getByTestId('screen-genre').locator('.tag').allTextContents()) expect(t).toBe(genre);
  await page.getByTestId('genre-back').click();
  await expect(page.getByTestId('genre-grid')).toBeVisible();
});

test('hearting a genre adds Favorite genres, which survive a reload and lead Home', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const grid = page.getByTestId('genre-grid');
  await expect(grid).toBeVisible();
  await expect(page.getByTestId('fav-genres')).toHaveCount(0);
  await expect(page.locator('.genre-count')).toHaveCount(0);
  await expect(page.getByTestId('screen-genres').locator('.topbar-sub')).toContainText(/\d+ genres/);
  // Rendered in chunks: the rest of the grid follows in idle time.
  await expect.poll(() => grid.getByTestId('genre-tile').count()).toBeGreaterThan(100);

  const second = grid.getByTestId('genre-cell').nth(1);
  const genre = (await second.getAttribute('data-genre'))!;
  const heart = second.getByTestId('genre-fav');
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('toast').last()).toContainText(`${genre}: added to ★ Favourites`);
  // M8: the grid doesn't move under the finger; Favourites shows it on the next visit.
  await expect(page.getByTestId('fav-genres')).toHaveCount(0);
  await page.getByTestId('tab-home').click();
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('fav-genres').locator('.section-title')).toHaveText('★ Favourites');
  await expect(page.getByTestId('fav-genres').getByTestId('genre-tile')).toHaveText([genre]);

  await page.reload();
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('fav-genres').getByTestId('genre-tile')).toHaveText([genre]);
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('genre-chip').first()).toHaveAttribute('data-genre', genre);
  await page.getByTestId('tab-genres').click();
  const favHeart = page.getByTestId('fav-genres').getByTestId('genre-fav');
  await favHeart.click();
  await expect(favHeart).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('tab-home').click();
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('fav-genres')).toHaveCount(0);
});

test('a genre page opened before the catalog has loaded fills in by itself', async ({ page }) => {
  // Hold the catalog (field-masked, 300-row pages) until the genre page is open.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    const q = route.request().method() === 'POST' ? JSON.parse(route.request().postData() ?? '{}').structuredQuery : null;
    if (q?.limit === 300) await held;
    return route.fallback();
  });
  await start(page);
  const row = page.getByTestId('screen-home').getByTestId('track-row').filter({ has: page.locator('.tag', { hasText: ATTACHMENT_ONLY_GENRE }) }).first();
  await row.getByTestId('track-play').click();
  await openNowPlaying(page);
  await page.getByTestId('np-genre').click();
  const genrePage = page.getByTestId('screen-genre');
  await expect(genrePage).toBeVisible();
  await expect(genrePage.getByTestId('skeleton')).toBeVisible();
  release();
  // The genre query finds nothing (the genre is only on the attachments): the catalog does.
  await expect(genrePage.getByTestId('track-row')).toHaveCount(4);
  await expect(genrePage.getByTestId('empty')).toHaveCount(0);
});

for (const kind of ['genres', 'artists'] as const) {
  test(`${kind}: A–Z sections with separators; the choice persists`, async ({ page }) => {
    await page.goto('/');
    await page.getByTestId(`tab-${kind}`).click();
    const grid = page.getByTestId(kind === 'genres' ? 'genre-grid' : 'artist-grid');
    await expect(grid).toHaveAttribute('data-sort', 'popular');
    await expect(page.getByTestId('grid-sort-popular')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('grid-sort-az').click();
    await expect(grid).toHaveAttribute('data-sort', 'az');
    const heads = grid.getByTestId('az-head');
    await expect.poll(() => heads.count()).toBeGreaterThan(5);
    const tile = kind === 'genres' ? 'genre-tile' : 'artist-tile';
    const attr = kind === 'genres' ? 'data-genre' : 'data-artist';
    const total = page.getByTestId(`screen-${kind}`).locator('.topbar-sub');
    const n = Number(/\d+/.exec((await total.textContent())!)![0]);
    await expect(grid.getByTestId(tile)).toHaveCount(n); // every chunk rendered
    const letters = await heads.evaluateAll((els) => els.map((e) => e.getAttribute('data-letter')!));
    expect(new Set(letters).size).toBe(letters.length);
    expect(letters.every((l) => l === '#' || l === l.toUpperCase())).toBe(true);
    if (letters.includes('#')) expect(letters[0]).toBe('#');
    const ok = await grid.getByTestId('az-section').evaluateAll(
      (secs, [tile, attr]) =>
        secs.every((s) => {
          const l = s.getAttribute('data-letter')!;
          return Array.from(s.querySelectorAll(`[data-testid="${tile}"]`)).every((t) => {
            const c = [...t.getAttribute(attr)!.trim().normalize('NFKD').replace(/\p{M}+/gu, '')][0] ?? '';
            if (/[a-z]/i.test(c)) return c.toUpperCase() === l;
            return /\p{L}/u.test(c) ? l !== '#' : l === '#';
          });
        }),
      [tile, attr],
    );
    expect(ok).toBe(true);
    const rule = (await heads.first().locator('.az-rule').boundingBox())!;
    expect(rule.width).toBeGreaterThan(100);

    await page.reload();
    await page.getByTestId(`tab-${kind}`).click();
    await expect(page.getByTestId('grid-sort-az')).toHaveAttribute('aria-selected', 'true');
    await expect(grid).toHaveAttribute('data-sort', 'az');
    await page.getByTestId('grid-sort-popular').click();
    await expect(grid).toHaveAttribute('data-sort', 'popular');
  });
}

test('★ on a genre page: adds it to Favourites, Undo takes it back, and it follows the grid', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const cell = page.getByTestId('genre-grid').getByTestId('genre-cell').nth(2);
  const genre = (await cell.getAttribute('data-genre'))!;
  await cell.getByTestId('genre-tile').click();
  const star = page.getByTestId('genre-page-fav');
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await expect(star).toHaveAttribute('aria-label', `Add ${genre} to favourites`);

  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('toast').last()).toContainText(`${genre}: added to ★ Favourites`);
  await page.getByTestId('genre-back').click();
  await expect(page.getByTestId('fav-genres').getByTestId('genre-tile')).toHaveText([genre]);

  // Undo from inside the page.
  await page.getByTestId('fav-genres').getByTestId('genre-tile').click();
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('toast').last().getByRole('button', { name: 'Undo' }).click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');

  // Unstarred from the page: gone from Favourites.
  await star.click();
  await page.getByTestId('genre-back').click();
  await page.getByTestId('tab-home').click();
  await page.getByTestId('tab-genres').click();
  await expect(page.getByTestId('fav-genres')).toHaveCount(0);
});
