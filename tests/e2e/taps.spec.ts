import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures';
import { start } from '../helpers';

/**
 * A tap on the app's controls during a fling. Chromium turns the touch that stops a fling
 * into "stop" and drops its click; the pointerdown and pointerup still arrive. These
 * tests send exactly that (no click) and check the control still acts, once.
 */

/** Finger down and up on `loc` (moved `dy` px), with no click, as after a fling. */
async function pressWithoutClick(loc: Locator, dy = 0): Promise<void> {
  await loc.evaluate((el, d) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const send = (type: string, py: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 9, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: py }));
    send('pointerdown', y);
    send('pointerup', y + d);
  }, dy);
}

test('the search button opens Search on a tap whose click was dropped, exactly once', async ({ page }) => {
  await start(page);
  await pressWithoutClick(page.getByTestId('search-fab'));
  await expect(page.getByTestId('search')).toBeVisible();
  // Opened once: one Back closes it.
  await page.getByTestId('search-close').click();
  await expect(page.getByTestId('search')).toHaveCount(0);
});

test('an ordinary tap on the search button still opens Search once', async ({ page }) => {
  await start(page);
  await page.getByTestId('search-fab').click();
  await expect(page.getByTestId('search')).toBeVisible();
  await page.getByTestId('search-close').click();
  await expect(page.getByTestId('search')).toHaveCount(0);
});

test('the tab bar, a top-bar Back and the mini player work without the click too', async ({ page }) => {
  await start(page);
  await pressWithoutClick(page.getByTestId('tab-genres'));
  await expect(page.getByTestId('screen-genres')).toBeVisible();
  await page.getByTestId('genre-grid').getByTestId('genre-tile').first().click();
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await pressWithoutClick(page.getByTestId('genre-back'));
  await expect(page.getByTestId('screen-genre')).toHaveCount(0);

  await pressWithoutClick(page.getByTestId('tab-home'));
  await page.getByTestId('track-play').first().click();
  const toggle = page.getByTestId('mini-toggle');
  await expect(toggle).toHaveAttribute('aria-label', 'Pause');
  await pressWithoutClick(toggle);
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
});

test('a track row is left alone: a tap that stops a fling plays nothing', async ({ page }) => {
  await start(page);
  await pressWithoutClick(page.getByTestId('track-play').first());
  await page.waitForFunction(() => new Promise((r) => setTimeout(() => r(true), 300)));
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
});

test('a finger that moved (a scroll) activates nothing', async ({ page }) => {
  await start(page);
  await pressWithoutClick(page.getByTestId('search-fab'), 14);
  await page.waitForFunction(() => new Promise((r) => setTimeout(() => r(true), 300)));
  await expect(page.getByTestId('search')).toHaveCount(0);
});

test('a pause tapped right after starting a track stays paused', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  const toggle = page.getByTestId('mini-toggle');
  await expect(toggle).toHaveAttribute('aria-label', 'Pause');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
  // Still paused once the track has finished loading.
  await page.waitForFunction(() => new Promise((r) => setTimeout(() => r(true), 1500)));
  await expect(toggle).toHaveAttribute('aria-label', 'Play');
});
