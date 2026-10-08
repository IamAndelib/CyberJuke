import { expect, test, type Page } from '@playwright/test';
import { stubMusic, stubYouTube } from './stubs';

/**
 * Lean search header and Rail, Popular/A–Z grids, the overlay scrollbar and A–Z fast
 * scroller, the Here search scope, and Global search from the first letter.
 * Live Firestore (read-only); Global and YouTube are stubbed.
 */

type Calls = { __cyberjukeMusicCalls: unknown[][] };
const musicCalls = (page: Page) => page.evaluate(() => (window as unknown as Calls).__cyberjukeMusicCalls);

async function waitForTracks(page: Page) {
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
}

async function openSearch(page: Page) {
  await page.getByTestId('search-fab').click();
  await expect(page.getByTestId('search')).toBeVisible();
  await expect(page.getByTestId('search-input')).toBeFocused();
}

async function headerBox(page: Page) {
  return (await page.getByTestId('search').locator('header.search-bar').boundingBox())!;
}

test('search header: lean, same height in both modes, underline on the rule, 44px targets', async ({ page }) => {
  await stubMusic(page);
  await page.goto('/');
  await openSearch(page);
  const jukebox = await headerBox(page);
  expect(jukebox.height).toBeLessThanOrEqual(96);

  const field = page.locator('.search-field');
  expect(await field.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');

  await page.getByTestId('search-input').fill('lumen');
  await page.getByTestId('mode-global').click();
  // Keeps the query and the keyboard (input focus); filters appear in the same row.
  await expect(page.getByTestId('search-input')).toHaveValue('lumen');
  await expect(page.getByTestId('search-input')).toBeFocused();
  await expect(page.getByTestId('filter-songs')).toBeVisible();
  const global = await headerBox(page);
  expect(global.height).toBe(jukebox.height);

  // The active mode's underline sits on the header rule.
  const on = page.getByTestId('mode-global');
  const under = await on.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const a = getComputedStyle(el, '::after');
    return { bottom: r.bottom - parseFloat(a.bottom), h: parseFloat(a.height), bg: a.backgroundColor };
  });
  expect(Math.abs(under.bottom - (global.y + global.height))).toBeLessThanOrEqual(1);
  expect(under.h).toBe(2);
  expect(under.bg).not.toBe('rgba(0, 0, 0, 0)');

  for (const id of ['mode-jukebox', 'mode-global', 'filter-songs', 'filter-albums']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.width, id).toBeGreaterThanOrEqual(44);
    expect(b.height, id).toBeGreaterThanOrEqual(44);
  }

  // Arrow keys move between modes (roving tabindex).
  await on.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('mode-jukebox')).toBeFocused();
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('mode-global')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('mode-global')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveValue('lumen');

  // No visible text names YouTube.
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/youtube/i);
});

test('Home: Latest | Most saved and the range are Rails', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  await expect(page.getByTestId('home-sort')).toHaveAttribute('role', 'tablist');
  await expect(page.getByTestId('saved-range')).toHaveCount(0);
  await page.getByTestId('sort-saved').click();
  await expect(page.getByTestId('sort-saved')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('saved-range')).toHaveAttribute('role', 'radiogroup');
  await expect(page.getByTestId('range-month')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('range-all').click();
  await expect(page.getByTestId('range-all')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('saved-list')).toBeVisible();
  // No filled-block toggles left.
  await expect(page.locator('.sort-tab, .segmented.range')).toHaveCount(0);
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
    expect(await heads.count()).toBeGreaterThan(5);
    const letters = await heads.evaluateAll((els) => els.map((e) => e.getAttribute('data-letter')!));
    expect(new Set(letters).size).toBe(letters.length);
    expect(letters.every((l) => l === '#' || l === l.toUpperCase())).toBe(true);
    if (letters.includes('#')) expect(letters[0]).toBe('#');
    // Every tile sits under the letter its name starts with (accents folded).
    const tile = kind === 'genres' ? 'genre-tile' : 'artist-tile';
    const attr = kind === 'genres' ? 'data-genre' : 'data-artist';
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
    // A separator rule beside each letter.
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

test('scrollbar: appears while scrolling, fades, and drags on a long list; A–Z shows the letter', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('grid-sort-az').click();
  const screen = page.getByTestId('screen-artists');
  await expect(screen.getByTestId('az-head').first()).toBeVisible();
  const sb = screen.getByTestId('scrollbar');
  // No native scrollbar.
  expect(await screen.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(0);
  await expect(sb).not.toHaveClass(/\bon\b/);

  await screen.evaluate((el) => el.scrollTo(0, el.scrollHeight * 0.3));
  await expect(sb).toHaveClass(/\bon\b/);
  await expect(sb).toHaveClass(/draggable/);
  const popup = screen.getByTestId('az-popup');
  await expect(popup).toHaveClass(/\bon\b/);
  // The popup letter is the section at the top of the list.
  const topLetter = () =>
    screen.evaluate((el) => {
      const top = el.querySelector('.topbar')!.getBoundingClientRect().bottom + 8;
      let cur = '';
      for (const h of el.querySelectorAll<HTMLElement>('.az-head')) if (h.getBoundingClientRect().top <= top) cur = h.dataset.letter!;
      return cur;
    });
  await expect(popup).toHaveText(await topLetter());
  // Centred, about 96px.
  const pb = (await popup.locator('.az-pop-letter').boundingBox())!;
  expect(pb.width).toBeGreaterThanOrEqual(90);
  expect(Math.abs(pb.x + pb.width / 2 - page.viewportSize()!.width / 2)).toBeLessThanOrEqual(8);
  // Fades: popup after 600ms, the bar after 1.2s.
  await expect(popup).not.toHaveClass(/\bon\b/, { timeout: 1500 });
  await expect(sb).not.toHaveClass(/\bon\b/, { timeout: 2500 });

  // Drag the thumb (44px touch area) to the bottom.
  await screen.evaluate((el) => el.scrollBy(0, 10));
  const thumb = screen.getByTestId('scroll-thumb');
  const tb = (await thumb.boundingBox())!;
  expect(tb.width).toBeGreaterThanOrEqual(44);
  const before = await screen.evaluate((el) => el.scrollTop);
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 10);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 250, { steps: 6 });
  await expect(sb).toHaveClass(/dragging/);
  await expect(popup).toHaveClass(/\bon\b/);
  await expect(screen.getByTestId('scroll-label')).toHaveText(await topLetter());
  await page.mouse.move(tb.x + tb.width / 2, 2000, { steps: 6 });
  const atEnd = await screen.evaluate((el) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) <= 2);
  expect(atEnd).toBe(true);
  await expect(popup).toHaveText(await topLetter());
  await page.mouse.up();
  expect(await screen.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  await expect(sb).not.toHaveClass(/dragging/);
  // The bar ends above the search button.
  const track = (await screen.locator('.sb-track').boundingBox())!;
  const fab = (await page.getByTestId('search-fab').boundingBox())!;
  expect(track.y + track.height).toBeLessThanOrEqual(fab.y);
  // Pull-to-refresh did not trigger.
  await expect(screen.getByTestId('ptr')).toHaveCSS('height', '0px');
});

test('scrollbar: no letter popup in Popular order; reduced motion has no fade transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const screen = page.getByTestId('screen-genres');
  await expect(screen.getByTestId('genre-tile').first()).toBeVisible();
  await page.getByTestId('grid-sort-popular').click();
  await screen.evaluate((el) => el.scrollTo(0, 600));
  await expect(screen.getByTestId('scrollbar')).toHaveClass(/\bon\b/);
  await expect(screen.getByTestId('az-popup')).toHaveCount(0);
  const dur = await screen.getByTestId('scrollbar').evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(dur).toBeLessThan(0.01);
});

test('Here: search from a genre page is scoped to it; Home has no Here', async ({ page }) => {
  await stubMusic(page);
  await page.goto('/');
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveCount(0);
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'Search the Jukebox');
  await expect(page.getByTestId('search-latest')).toBeVisible();
  await page.getByTestId('search-close').click();

  // The genres grid has no Here either.
  await page.getByTestId('tab-genres').click();
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveCount(0);
  await page.getByTestId('search-close').click();

  const pop = page.getByTestId('genre-grid').locator('[data-testid="genre-tile"][data-genre="pop"]');
  const tile = (await pop.count()) ? pop : page.getByTestId('genre-grid').getByTestId('genre-tile').first();
  const genre = (await tile.getAttribute('data-genre'))!;
  await tile.click();
  await expect(page.getByTestId('screen-genre').getByTestId('track-row').first()).toBeVisible();
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', `Search in ${genre}`);
  const list = page.getByTestId('here-list');
  await expect(list.getByTestId('track-row').first()).toBeVisible();
  const tags = await list.locator('.tag').allInnerTexts();
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t.trim()).toBe(genre);

  // Typing filters within the genre.
  const firstTitle = (await list.getByTestId('track-title').first().innerText()).trim();
  await page.getByTestId('search-input').fill(firstTitle);
  const results = page.getByTestId('here-results');
  await expect(results.getByTestId('track-title').first()).toBeVisible();
  for (const t of await results.locator('.tag').allInnerTexts()) expect(t.trim()).toBe(genre);

  // Jukebox and Global keep the query.
  await page.getByTestId('mode-jukebox').click();
  await expect(page.getByTestId('search-input')).toHaveValue(firstTitle);
  await expect(page.getByTestId('search-results')).toBeVisible();
  await page.getByTestId('mode-global').click();
  await expect(page.getByTestId('global-results')).toBeVisible();
  await page.getByTestId('mode-here').click();
  await expect(page.getByTestId('here-results')).toBeVisible();
});

test('Here: search from an album page searches the album, above it', async ({ page }) => {
  await stubYouTube(page);
  await stubMusic(page);
  await page.goto('/');
  await page.getByTestId('tab-artists').click();
  await page.getByTestId('artist-grid').getByTestId('artist-tile').first().click();
  await page.getByTestId('artist-albums').getByTestId('album-card').first().click();
  const album = page.getByTestId('screen-album');
  await expect(album.getByTestId('track-row').first()).toBeVisible();
  const title = (await page.getByTestId('album-title').innerText()).trim();
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', `Search in ${title}`);
  await expect(page.getByTestId('here-list').getByTestId('track-row')).toHaveCount(8);
  // Back closes search first, back onto the album.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search')).toHaveCount(0);
  await expect(album).toBeVisible();
});

test('Global search runs from the first letter; no "at least 2 letters" text', async ({ page }) => {
  await stubMusic(page);
  await page.goto('/');
  await openSearch(page);
  await page.getByTestId('mode-global').click();
  await expect(page.getByTestId('global-idle')).toBeVisible();
  await expect(page.getByTestId('search')).not.toContainText(/at least/i);
  await page.getByTestId('search-input').fill('q');
  await expect(page.getByTestId('global-results')).toBeVisible();
  expect(await musicCalls(page)).toContainEqual(['search', 'q', 'songs']);
  // Debounced: quick typing sends only the last query.
  const n = (await musicCalls(page)).length;
  await page.getByTestId('search-input').pressSequentially('rst', { delay: 30 });
  await expect(page.getByTestId('global-results')).toBeVisible();
  await page.waitForTimeout(600);
  const after = (await musicCalls(page)).slice(n).filter((c) => c[0] === 'search');
  expect(after).toEqual([['search', 'qrst', 'songs']]);
});

test('Here: search from Library is scoped to Liked', async ({ page }) => {
  await page.goto('/');
  await waitForTracks(page);
  const title = (await page.getByTestId('track-title').nth(2).innerText()).trim();
  await page.getByTestId('track-more').nth(2).click();
  await page.getByTestId('menu-like').click();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('liked-list').getByTestId('track-row')).toHaveCount(1);
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'Search in Liked');
  await expect(page.getByTestId('here-list').getByTestId('track-title')).toHaveText([title]);
  await page.getByTestId('search-input').fill('qzxv nebulon');
  await expect(page.getByTestId('here-empty')).toBeVisible();
  await page.getByTestId('here-bridge').click();
  await expect(page.getByTestId('mode-jukebox')).toHaveAttribute('aria-selected', 'true');
});
