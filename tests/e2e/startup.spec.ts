import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures';
import { isFeedQuery, start, waitForTracks } from '../helpers';

/**
 * Launch: Home's Latest is always fetched fresh, so the work is in asking for it first.
 * The query goes out before the first render, the catalog's download waits until it has
 * answered (its saved copy doesn't), and a query that never answers ends in the error
 * state, not an endless skeleton.
 */

declare global {
  interface Window {
    __cyberjukeMarks?: () => Record<string, number>;
  }
}

const marks = (page: Page) => page.evaluate(() => window.__cyberjukeMarks!());

/** The structuredQuery of a runQuery POST (null for a preflight). */
const queryOf = (route: Route) => (route.request().method() === 'POST' ? JSON.parse(route.request().postData() ?? '{}').structuredQuery : null);

/** Latest's (or a genre's) first page. */
const isFirstPage = (q: { limit?: number; startAt?: unknown } | null) => isFeedQuery(q) && !q?.startAt;

test.describe('a Latest page that takes a while', () => {
  test.use({ backendOptions: { delay: 800 } });

  test('Latest is asked for before Home first renders, and only once (Home gets that same request)', async ({ page, backend }) => {
    await start(page);
    const m = await marks(page);
    expect(m.request).toBeLessThan(m.render);
    expect(m.render).toBeLessThan(m['first-row']);
    // That first query was Latest's first page, and Home's list didn't send another.
    expect(isFirstPage(backend.queries[0])).toBe(true);
    expect(backend.queries.filter(isFirstPage)).toHaveLength(1);
    // With the field mask: only what a track is made of.
    expect(backend.queries[0].select?.fields.map((f) => f.fieldPath)).toEqual(expect.arrayContaining(['attachments', 'title', 'createdAt', 'isNSFW']));
  });
});

test('the catalog download (network) waits until Latest has answered', async ({ page }) => {
  const events: string[] = [];
  await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    const q = queryOf(route);
    if (q?.limit === 300) events.push('catalog');
    if (isFirstPage(q) && !events.includes('latest')) {
      // Slower than the idle wait the catalog used to start after (1.5 s), well under the cap (5 s).
      await new Promise((r) => setTimeout(r, 2500));
      events.push('latest');
    }
    return route.fallback();
  });
  await start(page);
  await expect.poll(() => events.includes('catalog')).toBe(true);
  expect(events.indexOf('latest')).toBeLessThan(events.indexOf('catalog'));
});

test('a saved catalog shows on the next launch without waiting for Latest', async ({ page }) => {
  let hold = false;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    if (hold && isFirstPage(queryOf(route))) await held;
    return route.fallback().catch(() => {});
  });
  await start(page);
  // The first launch downloads the catalog and saves it.
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.includes('catalog-public')))).toBe(true);
  hold = true;
  await page.reload();
  const home = page.getByTestId('screen-home');
  await page.getByTestId('sort-saved').click();
  // Well before the 5 s that the catalog's download may wait for Latest.
  await expect(home.getByTestId('saved-list').getByTestId('track-row').first()).toBeVisible({ timeout: 3000 });
  // Latest hasn't answered yet.
  await page.getByTestId('sort-latest').click();
  await expect(home.getByTestId('skeleton').first()).toBeVisible();
  release();
  await waitForTracks(page);
});

test.describe('a Latest request that never answers', () => {
  test('ends in the error state with Retry after the timeout, and the catalog loads anyway', async ({ page }) => {
    await page.addInitScript(() => {
      window.__cyberjukeRequestTimeoutMs = 1500;
    });
    let hang = true;
    let catalogAsked = false;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
      const q = queryOf(route);
      if (q?.limit === 300) catalogAsked = true;
      if (hang && isFirstPage(q)) {
        await held;
        return route.abort().catch(() => {});
      }
      return route.fallback();
    });
    await page.goto('/');
    const home = page.getByTestId('screen-home');
    await expect(home.getByTestId('skeleton').first()).toBeVisible();
    // Not offline: it couldn't load, with Retry.
    await expect(home.getByTestId('error')).toBeVisible();
    await expect(home.getByTestId('offline')).toHaveCount(0);
    await expect.poll(() => catalogAsked).toBe(true);
    hang = false;
    release();
    await home.getByTestId('retry').click();
    await waitForTracks(page);
  });
});
