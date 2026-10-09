import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { box, musicCalls, openNowPlaying, playAndOpen, playerCalls, setLyricsMode, start, touchDrag } from '../helpers';

/** Mini player, Now Playing (controls, swipe, links), the queue, lyrics and Share. */

test('tapping a track shows the mini player, which opens Now Playing', async ({ page }) => {
  await start(page);
  const title = (await page.getByTestId('track-title').nth(1).textContent())!.trim();
  await page.getByTestId('track-play').nth(1).click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await expect(page.getByTestId('mini-title')).toHaveText(title);
  await expect(page.getByTestId('track-row').nth(1)).toHaveClass(/is-current/);

  await openNowPlaying(page);
  await expect(page.getByTestId('np-title')).toHaveText(title);
  await expect(page.getByTestId('np-post')).toContainText('Posted by @');
  await expect(page.getByTestId('upnext-row').first()).toBeVisible();

  // Remove the first one: it leaves Up next (the list may hold more than is shown).
  const removed = (await page.getByTestId('upnext-row').first().locator('.row-title').textContent())!;
  await page.getByTestId('upnext-remove').first().click();
  await expect(page.getByTestId('upnext-row').first().locator('.row-title')).not.toHaveText(removed);

  await page.getByTestId('np-repeat').click();
  await expect(page.getByTestId('np-repeat')).toHaveAttribute('data-mode', 'all');
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('np-close').click();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  // Closed, the sheet's contents go away (nothing renders or fetches behind it).
  await expect(page.getByTestId('np-title')).toHaveCount(0);
});

test('the play icon is optically centred in its round button', async ({ page }) => {
  await start(page);
  await playAndOpen(page, 0);
  const btn = page.getByTestId('np-toggle');
  await expect(btn).toHaveAttribute('aria-label', 'Pause');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-label', 'Play');

  for (const id of ['np-toggle', 'mini-toggle']) {
    if (id === 'mini-toggle') await page.getByTestId('np-close').click();
    const b = page.getByTestId(id);
    const icon = b.locator('svg[data-icon="play"]');
    await expect(icon).toHaveAttribute('shape-rendering', 'geometricPrecision');
    const m = await b.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const p = el.querySelector('svg path')!.getBoundingClientRect();
      return { bx: r.left + r.width / 2, by: r.top + r.height / 2, left: p.left, top: p.top, w: p.width, h: p.height };
    });
    // Right-pointing triangle: centroid is a third of the way in from the flat side.
    expect(Math.abs(m.left + m.w / 3 - m.bx)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(m.top + m.h / 2 - m.by)).toBeLessThanOrEqual(1);
    const lean = m.left + m.w / 2 - m.bx;
    expect(lean).toBeGreaterThan(0);
    expect(lean).toBeLessThan(m.w / 6 + 1);
  }
});

test('Now Playing: a swipe down closes it, a short drag springs back, the seek bar is ignored', async ({ page }) => {
  await start(page);
  await playAndOpen(page);
  const np = page.getByTestId('now-playing');
  await expect(page.getByTestId('np-grab')).toBeVisible();
  const h = page.viewportSize()!.height;

  // Short, slow drag: springs back.
  await touchDrag(page, 200, 200, 260, 600);
  await expect(np).toHaveClass(/open/);
  await expect.poll(() => np.evaluate((el) => (el as HTMLElement).style.transform)).toBe('');

  // A drag on the seek bar never moves the sheet.
  const seek = (await page.getByTestId('seek').boundingBox())!;
  await touchDrag(page, seek.x + 20, seek.y + seek.height / 2, seek.y + seek.height / 2 + h * 0.4, 400);
  await expect(np).toHaveClass(/open/);

  // Horizontal drag (right to left: headless Chrome turns left-to-right into "back"): nothing.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 320, y: 300, id: 1 }] });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 320 - i * 30, y: 300 + i * 4, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(np).toHaveClass(/open/);

  // Past 25% of the height: closes.
  await touchDrag(page, 200, 150, 150 + h * 0.35, 500);
  await expect(np).not.toHaveClass(/open/);

  // A quick flick closes too, even when short: 100px (< 25%) in 60 ms, by the events'
  // own timestamps (a busy machine can't stretch it past the velocity window).
  await openNowPlaying(page);
  await touchDrag(page, 200, 150, 250, 60, 4, true);
  await expect(np).not.toHaveClass(/open/);

  // Scrolled down: dragging down scrolls the content instead of closing.
  await openNowPlaying(page);
  await np.locator('.np-scroll').evaluate((el) => el.scrollTo(0, 300));
  await touchDrag(page, 200, 300, 300 + h * 0.4, 500);
  await expect(np).toHaveClass(/open/);
});

test('in Now Playing, the genre opens its genre page and the artist opens the artist page', async ({ page }) => {
  await start(page);
  const row = page.getByTestId('track-row').filter({ has: page.locator('.tag') }).first();
  const genre = (await row.locator('.tag').textContent())!.trim();
  await row.getByTestId('track-play').click();
  await openNowPlaying(page);
  await page.getByTestId('np-genre').click();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  await expect(page.getByTestId('screen-genre')).toBeVisible();
  await expect(page.getByTestId('screen-genre').locator('.topbar-title')).toHaveText(genre);
  // P4: it opens in place, on the tab you were on.
  await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('mini-open').click();
  await page.getByTestId('np-artist').click();
  if (await page.getByTestId('artist-chooser').isVisible()) await page.getByTestId('chooser-artist').first().click();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('artist-jukebox').getByTestId('track-row').first()).toBeVisible();
  await page.getByTestId('artist-jukebox').getByTestId('track-more').first().click();
  await expect(page.getByTestId('menu-more-by').first()).toContainText('More by ');
});

test('several credited artists open a chooser from Now Playing', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('search-fab').click();
  await page.getByTestId('mode-global').click();
  await page.getByTestId('search-input').fill('Lumen');
  const results = page.getByTestId('global-results');
  // The stub credits its second song to "Lumen, Tycho".
  const row = results.getByTestId('track-row').filter({ hasText: 'Lumen, Tycho' }).first();
  await row.getByTestId('track-play').click();
  await page.getByTestId('search-close').click();
  await openNowPlaying(page);
  await page.getByTestId('np-artist').click();
  const chooser = page.getByTestId('artist-chooser');
  await expect(chooser).toBeVisible();
  await expect(chooser.getByTestId('chooser-artist')).toHaveText(['Lumen', 'Tycho']);
  await chooser.getByTestId('chooser-artist').nth(1).click();
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  await expect(page.getByTestId('screen-artist').locator('.topbar-title')).toHaveText('Tycho');
  await expect(chooser).toBeHidden();
});

// ---- Queue ---------------------------------------------------------------------------

/** ⋯ → Add to queue on row i (a real tap: the fast scroller's thumb stays clear of ⋯). */
async function queue(page: Page, i: number) {
  await page.getByTestId('track-more').nth(i).click();
  await expect(page.getByTestId('track-menu')).toBeVisible();
  await page.getByTestId('menu-add-queue').click();
  // The sheet slides away; a tap meanwhile would land on its scrim.
  await expect(page.getByTestId('track-menu')).toBeHidden();
  await expect(page.locator('.sheet-wrap.open')).toHaveCount(0);
}

test('Add to queue plays next in the order added, under "Queued by you"', async ({ page }) => {
  await start(page);
  const titles = (await page.getByTestId('track-title').allTextContents()).map((t) => t.trim());
  await page.getByTestId('track-play').nth(0).click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  for (const i of [5, 6]) {
    await queue(page, i);
    await expect(page.getByTestId('menu-play-next')).toHaveCount(0); // merged into Add to queue
  }
  await openNowPlaying(page);
  const rows = page.getByTestId('upnext-row');
  await expect(rows.nth(0).locator('.row-title')).toHaveText(titles[5]);
  await expect(rows.nth(1).locator('.row-title')).toHaveText(titles[6]);
  await expect(rows.nth(2)).toHaveAttribute('data-section', 'autoplay');
  await expect(page.getByTestId('upnext-queued-label')).toHaveText('Queued by you');
  await expect(page.locator('[data-testid="upnext-row"][data-queued="true"]')).toHaveCount(2);
  expect((await playerCalls(page)).filter((c) => c[0] === 'queueNext')).toHaveLength(2);

  // With shuffle on, queued tracks still play next.
  await page.getByTestId('np-shuffle').click();
  await expect(rows.nth(0).locator('.row-title')).toHaveText(titles[5]);
  await expect(rows.nth(1).locator('.row-title')).toHaveText(titles[6]);
  // Playing one removes it from "Queued by you".
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(titles[5]);
  await expect(page.locator('[data-testid="upnext-row"][data-queued="true"]')).toHaveCount(1);
});

test('a seek-bar drag held still before release still seeks, and the bar follows the next track', async ({ page }) => {
  await start(page);
  await playAndOpen(page);
  const pos = page.getByTestId('time-pos');
  // The fake player starts every track at 1:11 of 4:07.
  await expect(pos).toHaveText(/^1:1\d$/);
  const bar = (await page.getByTestId('seek').boundingBox())!;
  const y = bar.y + bar.height / 2;
  const xAt = (sec: number) => bar.x + (bar.width * sec) / 247;
  // Press on the thumb, drag to about 2:54, then hold still while the bar re-renders (the
  // clock ticks every second while playing) before letting go.
  await page.mouse.move(xAt(72), y);
  await page.mouse.down();
  await page.mouse.move(xAt(174), y, { steps: 8 });
  await page.waitForTimeout(1600);
  await page.mouse.up();
  await expect(pos).toHaveText(/^2:5\d$/);
  // One seek for the whole drag, when it ends (not one per step).
  expect(await page.evaluate(() => (window as unknown as { __ytSeeks?: number }).__ytSeeks)).toBe(1);
  // Next: the new track starts at 1:11 again, and the bar shows that, not the dragged spot.
  await page.getByTestId('np-next').click();
  await expect(pos).toHaveText(/^1:1\d$/);
  await expect.poll(async () => Number(await page.getByTestId('seek').inputValue())).toBeLessThan(80_000);
});

test('the Now Playing heart follows the track: liked on one, empty on the next, liked again back', async ({ page }) => {
  await start(page);
  await playAndOpen(page);
  const heart = page.getByTestId('np-like');
  const title = page.getByTestId('np-title');
  const first = (await title.textContent())!.trim();
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('np-next').click();
  await expect(title).not.toHaveText(first);
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  // Previous restarts a track past its first seconds; the second one goes back.
  await page.getByTestId('np-prev').click();
  await page.getByTestId('np-prev').click();
  await expect(title).toHaveText(first);
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
});

test('a scroll that starts on the seek bar scrolls Now Playing and seeks nothing', async ({ page }) => {
  await start(page);
  await playAndOpen(page);
  const pos = page.getByTestId('time-pos');
  await expect(pos).toHaveText(/^1:1\d$/);
  const bar = (await page.getByTestId('seek').boundingBox())!;
  const scroller = page.locator('.np-scroll');
  const top0 = await scroller.evaluate((el) => el.scrollTop);
  // A finger lands on the seek bar (right of the thumb) and pushes the sheet up.
  await touchDrag(page, bar.x + bar.width * 0.85, bar.y + bar.height / 2, bar.y + bar.height / 2 - 300, 300);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(top0 + 50);
  expect(await page.evaluate(() => (window as unknown as { __ytSeeks?: number }).__ytSeeks ?? 0)).toBe(0);
  await expect(pos).toHaveText(/^1:[12]\d$/);
});

test('quick taps on the Now Playing heart leave one toast, about the last tap', async ({ page }) => {
  await start(page);
  await playAndOpen(page);
  const heart = page.getByTestId('np-like');
  for (let i = 0; i < 3; i++) await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  const toasts = page.getByTestId('toast');
  await expect(toasts).toHaveCount(1);
  await expect(toasts).toHaveText('Added to Liked songs');
  await heart.click();
  await expect(toasts).toHaveCount(1);
  await expect(toasts).toContainText('Removed from Liked');
});

test('skipping past queued tracks keeps them next (tests/spec/queue-rules.json)', async ({ page }) => {
  await start(page);
  const titles = (await page.getByTestId('track-title').allTextContents()).map((t) => t.trim());
  await page.getByTestId('track-play').nth(0).click();
  // The mini player appearing shifts the layout: let it land before tapping ⋯.
  await expect(page.getByTestId('mini-title')).toHaveText(titles[0]);
  await queue(page, 7);
  await queue(page, 8);
  await openNowPlaying(page);
  // Jump to a track further down the list (not a queued one).
  const target = page.locator('[data-testid="upnext-row"][data-section="autoplay"]').nth(2);
  const pick = (await target.locator('.row-title').textContent())!.trim();
  await target.locator('.row-main').click();
  await expect(page.getByTestId('np-title')).toHaveText(pick);
  const rows = page.getByTestId('upnext-row');
  await expect(rows.nth(0).locator('.row-title')).toHaveText(titles[7]);
  await expect(rows.nth(1).locator('.row-title')).toHaveText(titles[8]);
  await expect(page.locator('[data-testid="upnext-row"][data-queued="true"]')).toHaveCount(2);
  await expect(page.getByTestId('upnext-queued-label')).toBeVisible();
});

// ---- Lyrics --------------------------------------------------------------------------

test('lyrics replace the art: synced lines follow the position, a tap seeks, other scripts and states', async ({ page }) => {
  await start(page);
  await setLyricsMode(page, 'greek');
  await playAndOpen(page, 0);
  const artBox = (await page.locator('.np-art .dos-frame').boundingBox())!;
  await page.getByTestId('np-art').click();
  const panel = page.getByTestId('np-lyrics');
  await expect(panel).toHaveAttribute('data-kind', 'synced');
  const lyrBox = (await page.locator('.np-art .dos-frame').boundingBox())!;
  expect(Math.abs(lyrBox.width - artBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(lyrBox.height - artBox.height)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('lyrics-credit')).toHaveText('Lyrics: LRCLIB');
  await expect(panel).toContainText('Το φεγγάρι λάμπει');

  // The fake player starts at 71 s: lines are 4 s apart.
  const synced = page.getByTestId('lyrics-synced');
  await expect.poll(async () => Number(await synced.getAttribute('data-current'))).toBeGreaterThanOrEqual(17);
  const current = page.locator('.lyr-line.on');
  if (await current.count()) await expect(current).toBeInViewport();

  // Tap a line: seeks there. A tap that lands while the panel glides to the next line
  // only stops it (clickGuard), so tap again if it did.
  const line = page.locator('.lyr-line[data-i="40"]');
  await expect(async () => {
    await line.click();
    await expect.poll(async () => Number(await synced.getAttribute('data-current')), { timeout: 2000 }).toBeGreaterThanOrEqual(40);
  }).toPass();
  await expect(line).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('time-pos')).toHaveText(/^2:4\d$/);
  for (const d of await page.getByTestId('lyric-line').evaluateAll((els) => els.slice(0, 5).map((e) => e.getAttribute('dir')))) expect(d).toBe('auto');

  // Arabic (right to left) on the next track; the panel stays open.
  await setLyricsMode(page, 'arabic');
  await page.getByTestId('np-next').click();
  await expect(panel).toContainText('القمر يضيء فوق البحر');
  const rtl = await page.getByTestId('lyric-line').first().evaluate((el) => el.matches(':dir(rtl)') && getComputedStyle(el).direction === 'rtl');
  expect(rtl).toBe(true);

  await setLyricsMode(page, 'japanese');
  await page.getByTestId('np-next').click();
  await expect(panel).toContainText('夜の街に光が揺れる');
  await expect(page.getByTestId('lyrics-credit')).toHaveText('Source: LyricFind');

  await setLyricsMode(page, 'spanish');
  await page.getByTestId('np-next').click();
  await expect(panel).toContainText('Bajo la luna bailamos');

  await setLyricsMode(page, 'plain');
  await page.getByTestId('np-next').click();
  await expect(panel).toHaveAttribute('data-kind', 'plain');
  await expect(panel).toContainText('Hold the tape and press rewind');

  await setLyricsMode(page, 'none');
  await page.getByTestId('np-next').click();
  await expect(panel).toHaveAttribute('data-kind', 'none');
  await expect(page.getByTestId('lyrics-state')).toHaveText('No lyrics found');

  await setLyricsMode(page, 'instrumental');
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('lyrics-state')).toContainText('Instrumental');

  const req = (await musicCalls(page)).filter((c) => c[0] === 'lyrics').map((c) => c[1] as { ytId: string; title: string });
  expect(req.length).toBeGreaterThanOrEqual(7);
  for (const r of req) {
    expect(r.ytId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(r.title).not.toMatch(/official (music )?video/i);
  }

  await page.getByTestId('np-lyrics-toggle').click();
  await expect(page.getByTestId('np-lyrics')).toHaveCount(0);
  await expect(page.getByTestId('np-art')).toBeVisible();
  expect(await page.getByTestId('now-playing').innerText()).not.toMatch(/youtube/i);
});

test('lyrics are fetched only while the lyrics panel shows', async ({ page }) => {
  await start(page);
  await setLyricsMode(page, 'spanish');
  await playAndOpen(page, 0);
  await page.getByTestId('np-lyrics-toggle').click();
  await expect(page.getByTestId('lyrics-synced')).toBeVisible();
  const lyricsCalls = async () => (await musicCalls(page)).filter((c) => c[0] === 'lyrics').length;
  const n = await lyricsCalls();
  expect(n).toBe(1);
  // Closed sheet (lyrics still chosen): skipping tracks looks nothing up.
  await page.getByTestId('np-close').click();
  await expect(page.getByTestId('np-lyrics')).toHaveCount(0);
  const title = await page.getByTestId('mini-title').textContent();
  await page.getByTestId('mini-next').click();
  await expect(page.getByTestId('mini-title')).not.toHaveText(title!);
  await page.getByTestId('mini-next').click();
  expect(await lyricsCalls()).toBe(n);
  // Opening it again fetches the current track's.
  await openNowPlaying(page);
  await expect(page.getByTestId('np-lyrics')).toHaveAttribute('data-kind', 'synced');
  expect(await lyricsCalls()).toBe(n + 1);
});

test('scrolling the lyrics by hand pauses the auto-scroll', async ({ page }) => {
  await start(page);
  await setLyricsMode(page, 'spanish');
  await playAndOpen(page, 0);
  await page.getByTestId('np-lyrics-toggle').click();
  const synced = page.getByTestId('lyrics-synced');
  await expect(synced).toBeVisible();
  // Auto-scroll has centred the current line.
  await expect.poll(() => synced.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
  // Scroll to the top by hand and watch for 2.5 s of the 4 s pause, all inside the
  // page (no round trips eating into the pause on a busy machine).
  const seen = await synced.evaluate(async (el) => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -2000, bubbles: true }));
    el.scrollTo({ top: 0, behavior: 'auto' });
    const tops: number[] = [];
    const t0 = performance.now();
    await new Promise<void>((r) => {
      const tick = () => {
        tops.push(el.scrollTop);
        if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
        else r();
      };
      requestAnimationFrame(tick);
    });
    return tops;
  });
  expect(seen.length).toBeGreaterThan(10);
  // Near the top (an auto-scroll already in flight may stop a few px short), and still there:
  // nothing scrolled it back during the pause.
  expect(seen[0]).toBeLessThan(20);
  expect(new Set(seen)).toEqual(new Set([seen[0]]));
  // After the pause it centres the current line again.
  await expect.poll(() => synced.evaluate((el) => el.scrollTop), { timeout: 8000 }).toBeGreaterThan(50);
});

// ---- Share ---------------------------------------------------------------------------

test('Share in the ⋯ menu shares the track title, artist and music.youtube.com link', async ({ page }) => {
  await start(page);
  await playAndOpen(page, 0);
  const src = (await page.locator('.np-art img').getAttribute('src'))!;
  const ytId = /\/vi\/([^/]+)\//.exec(src)![1];
  const title = (await page.getByTestId('np-title').innerText()).trim();
  await page.getByTestId('np-more').click();
  // One Share item: the track link (no separate "Share post").
  await expect(page.getByTestId('menu-share')).toHaveText('Share');
  await expect(page.getByTestId('menu-share-post')).toHaveCount(0);
  await page.getByTestId('menu-share').click();
  await expect(page.getByTestId('track-menu')).not.toBeVisible();
  const shares = (await musicCalls(page)).filter((c) => c[0] === 'share').map((c) => c[1] as { title: string; text: string; url: string });
  expect(shares).toHaveLength(1);
  expect(shares[0].url).toBe(`https://music.youtube.com/watch?v=${ytId}`);
  expect(shares[0].title.startsWith(title)).toBe(true);
  expect(shares[0].text).toBe(shares[0].title);
  await page.getByTestId('np-close').click();
  await page.getByTestId('track-more').nth(3).click();
  await expect(page.getByTestId('menu-share')).toBeVisible();
});

test('the Now Playing genre tag takes a tap a little above or below it (44px target)', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await openNowPlaying(page);
  const tag = page.getByTestId('np-genre');
  const b = (await tag.boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="np-genre"]') != null, [b.x + b.width / 2, b.y - 10]);
  expect(hit).toBe(true);
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="np-genre"]') != null, [b.x + b.width / 2, b.y + b.height + 10])).toBe(true);
});

test('Up next from the keyboard: focus follows a moved row, and goes to the next row after a removal', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await openNowPlaying(page);
  const rows = page.locator('[data-testid="upnext-row"][data-section="autoplay"]');
  const id = (await rows.nth(1).getAttribute('data-track-id'))!;
  const focused = () => page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return `${a?.dataset.testid}:${a?.closest('[data-testid="upnext-row"]')?.getAttribute('data-track-id')}`;
  });
  await rows.nth(1).getByTestId('upnext-down').focus();
  await page.keyboard.press('Enter');
  await expect(rows.nth(2)).toHaveAttribute('data-track-id', id);
  await expect.poll(focused).toBe(`upnext-down:${id}`);
  // Up from the top of the list: the Up button disables, so focus goes to Down.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(rows.nth(1)).toHaveAttribute('data-track-id', id);
  await expect.poll(focused).toBe(`upnext-up:${id}`);

  const after = (await rows.nth(2).getAttribute('data-track-id'))!;
  await rows.nth(1).getByTestId('upnext-remove').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`[data-testid="upnext-row"][data-track-id="${id}"]`)).toHaveCount(0);
  await expect.poll(focused).toBe(`upnext-remove:${after}`);
});

test('in Now Playing an Undo message sits at the bottom, and Up next scrolls clear of it', async ({ page }) => {
  await start(page);
  await page.getByTestId('track-play').first().click();
  await openNowPlaying(page);
  const rows = page.getByTestId('upnext-row');
  await expect(rows.nth(3)).toBeVisible();
  await rows.first().getByTestId('upnext-remove').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('Removed from queue');
  const t = await box(toast);
  const vh = page.viewportSize()!.height;
  expect(vh - (t.y + t.height)).toBeLessThanOrEqual(30);
  // At the end of Up next, the last row's buttons are all above the message.
  await page.locator('.np-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const last = rows.last();
  for (const id of ['upnext-up', 'upnext-down', 'upnext-remove']) {
    const b = await box(last.getByTestId(id));
    expect(b.y + b.height, id).toBeLessThanOrEqual(t.y);
  }
});
