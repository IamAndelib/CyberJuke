import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { waitForTracks } from '../helpers';

/**
 * Motion and touch: text selection, the marquee, press feedback, pull-to-refresh,
 * the click guard, touch targets, and the mini player swipe.
 */

/** Hold one finger still at (x, y) for `ms` (a long-press), through CDP touch events. */
async function longPress(page: Page, x: number, y: number, ms = 800): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  // Gesture timing, not a wait for the app: the finger stays down this long.
  await new Promise((r) => setTimeout(r, ms));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const selection = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? '');

test('a long-press or double tap selects no text; inputs still can', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-genres').click();
  const title = page.locator('.topbar-title');
  await expect(title).toHaveText(/genres/i);
  const b = (await title.boundingBox())!;
  await longPress(page, b.x + 20, b.y + b.height / 2);
  expect(await selection(page)).toBe('');
  await title.dblclick();
  expect(await selection(page)).toBe('');

  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  await expect(page.locator('.art img').first()).toHaveAttribute('draggable', 'false');
  expect(await page.locator('.art img').first().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-user-drag'))).toBe('none');
  await page.getByTestId('search-fab').click();
  const input = page.getByTestId('search-input');
  await input.fill('select me');
  await input.selectText();
  expect(await input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('select me');
  expect(await input.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text');
});
