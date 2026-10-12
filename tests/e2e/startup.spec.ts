import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures';
import { isFeedQuery, start, waitForTracks } from '../helpers';

/**
 * Launch: Home's Latest is always fetched fresh, so the work is in asking for it first.
 * The query goes out before the first render, and a query that never answers ends in
 * the error state, not an endless skeleton.
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

test.describe('a Latest request that never answers', () => {
  test('ends in the error state with Retry after the timeout', async ({ page }) => {
    await page.addInitScript(() => {
      window.__cyberjukeRequestTimeoutMs = 1500;
    });
    let hang = true;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
      const q = queryOf(route);
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
    hang = false;
    release();
    await home.getByTestId('retry').click();
    await waitForTracks(page);
  });
});
