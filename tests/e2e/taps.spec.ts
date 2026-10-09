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

test('a late real click after a supplied one is dropped even when the control is gone', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-genres').click();
  await page.getByTestId('genre-grid').getByTestId('genre-tile').first().click();
  const back = page.getByTestId('genre-back');
  const box = (await back.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await pressWithoutClick(back);
  await expect(page.getByTestId('screen-genre')).toHaveCount(0); // the supplied click went Back
  // Whatever is under the finger now (a probe here) must not get the same tap's late click.
  await page.evaluate(
    ([px, py]) => {
      const probe = document.createElement('div');
      probe.id = 'probe';
      probe.dataset.clicks = '0';
      Object.assign(probe.style, { position: 'fixed', left: `${px - 20}px`, top: `${py - 20}px`, width: '40px', height: '40px', zIndex: '9999' });
      probe.addEventListener('click', () => (probe.dataset.clicks = String(Number(probe.dataset.clicks) + 1)));
      document.body.append(probe);
    },
    [x, y],
  );
  await page.mouse.click(x, y);
  await expect(page.locator('#probe')).toHaveAttribute('data-clicks', '0');
  // A real tap later, elsewhere, works as usual.
  await page.waitForTimeout(450);
  await page.mouse.click(x, y);
  await expect(page.locator('#probe')).toHaveAttribute('data-clicks', '1');
});
