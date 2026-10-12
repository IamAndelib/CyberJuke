import type { Route } from '@playwright/test';
import { expect, test } from '../fixtures';
import { isFeedQuery, waitForTracks } from '../helpers';

/**
 * Launch: Home's Latest is always fetched fresh. A query that never answers ends in the
 * error state, not an endless skeleton.
 */

/** The structuredQuery of a runQuery POST (null for a preflight). */
const queryOf = (route: Route) => (route.request().method() === 'POST' ? JSON.parse(route.request().postData() ?? '{}').structuredQuery : null);

/** Latest's (or a genre's) first page. */
const isFirstPage = (q: { limit?: number; startAt?: unknown } | null) => isFeedQuery(q) && !q?.startAt;

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
