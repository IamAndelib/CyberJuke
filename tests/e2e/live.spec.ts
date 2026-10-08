import { expect, test } from '../fixtures';

/**
 * @live: one smoke test against the real, read-only Firestore (skipped unless
 * PW_LIVE=1). Checks that the query shapes the app sends still work and parse.
 */
test.use({ live: true });

test('live Firestore: Home loads real posts and the catalog indexes @live', async ({ page }) => {
  await page.goto('/');
  const rows = page.getByTestId('track-row');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  await expect(rows.first()).toContainText('by @');
  await page.getByTestId('tab-genres').click();
  await expect(page.locator('.topbar-sub')).toContainText(/\d+ genres/, { timeout: 30_000 });
});
