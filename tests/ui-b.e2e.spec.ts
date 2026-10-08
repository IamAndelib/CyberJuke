import { expect, test, type Page } from '@playwright/test';
import { stubMusic, stubYouTube } from './stubs';

/**
 * Feedback round 3, web engineer B: swipe to close, exact artists, the new-tracks pill
 * and its interval, history day groups, lyrics, Share and the play-next queue.
 * Live Firestore (read-only) plus the browser stubs from stubs.ts.
 */

async function waitForTracks(page: Page) {
  await expect(page.getByTestId('track-row').first()).toBeVisible();
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
}

async function start(page: Page) {
  await stubYouTube(page);
  await stubMusic(page);
  await page.goto('/');
  await waitForTracks(page);
}

async function playAndOpen(page: Page, i = 0) {
  await page.getByTestId('track-play').nth(i).click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await page.getByTestId('mini-open').click();
  await expect(page.getByTestId('now-playing')).toHaveClass(/open/);
  await page.waitForTimeout(350); // open transition
}

const musicCalls = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeMusicCalls: unknown[][] }).__cyberjukeMusicCalls);

/** A one-finger drag through CDP touch events (real touchstart/move/end). */
async function touchDrag(page: Page, x: number, y0: number, y1: number, ms: number, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (y: number) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y0) });
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(ms / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y0 + ((y1 - y0) * i) / steps) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// ---- 1. Swipe down to close ----------------------------------------------------------

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

  // A quick flick closes too, even when short.
  await page.getByTestId('mini-open').click();
  await expect(np).toHaveClass(/open/);
  await page.waitForTimeout(350);
  await touchDrag(page, 200, 150, 250, 60, 4);
  await expect(np).not.toHaveClass(/open/);

  // Scrolled down: dragging down scrolls the content instead of closing.
  await page.getByTestId('mini-open').click();
  await page.waitForTimeout(350);
  await np.locator('.np-scroll').evaluate((el) => el.scrollTo(0, 300));
  await touchDrag(page, 200, 300, 300 + h * 0.4, 500);
  await expect(np).toHaveClass(/open/);
});

// ---- 4. Exact artists ----------------------------------------------------------------

test('"More by Queen" lists only Queen-channel items: no Ivy Queen, no Queen Butterfly', async ({ page }) => {
  await stubYouTube(page);
  await stubMusic(page);
  await page.goto('/');
  await page.getByTestId('search-fab').click();
  await page.getByTestId('mode-global').click();
  await page.getByTestId('search-input').fill('Queen');
  await page.getByTestId('filter-artists').click();
  await expect(page.getByTestId('music-row').first()).toBeVisible();
  await page.getByTestId('music-open').first().click();
  await expect(page.getByTestId('screen-artist')).toBeVisible();
  await expect(page.locator('.topbar-title')).toHaveText('Queen');

  const more = page.getByTestId('artist-more');
  await expect(more.getByTestId('track-row').first()).toBeVisible();
  const artists = await more.locator('.row-artist').allInnerTexts();
  expect(artists.length).toBeGreaterThanOrEqual(10);
  for (const a of artists) {
    expect(a.split(', ')[0]).toBe('Queen');
    expect(a).not.toMatch(/Ivy Queen|Queen Butterfly/);
  }
  const titles = await more.getByTestId('track-title').allInnerTexts();
  expect(titles.some((t) => t.startsWith('Decoy'))).toBe(false);
  expect(titles.some((t) => t.startsWith('Unlinked Decoy'))).toBe(false);
  // A channel-less song credited exactly "Queen" is kept by the fallback.
  expect(titles.some((t) => t.startsWith('Unlinked Original'))).toBe(true);
  await expect(page.getByTestId('artist-albums').getByTestId('album-card').first()).toBeVisible();
  await expect(page.getByTestId('artist-albums')).not.toContainText('Decoy Album');
  // The channel came with the search result: no artist() lookup.
  expect((await musicCalls(page)).filter((c) => c[0] === 'artist')).toHaveLength(0);
});

test('an artist opened from the Artists tab is resolved by exact name', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-artists').click();
  const tile = page.getByTestId('artist-grid').getByTestId('artist-tile').first();
  const artist = (await tile.getAttribute('data-artist'))!;
  await tile.click();
  const more = page.getByTestId('artist-more');
  await expect(more.getByTestId('track-row').first()).toBeVisible();
  expect((await musicCalls(page)).filter((c) => c[0] === 'artist')).toEqual([['artist', artist]]);
  for (const a of await more.locator('.row-artist').allInnerTexts()) expect(a.split(', ')[0].toLowerCase()).toBe(artist.toLowerCase());
  const titles = await more.getByTestId('track-title').allInnerTexts();
  expect(titles.filter((t) => /Decoy/.test(t))).toEqual([]);
  // Paged until 20 matches or 3 pages; Load more continues.
  const before = titles.length;
  await more.getByTestId('load-more').click();
  await expect.poll(() => more.getByTestId('track-row').count()).toBeGreaterThan(before);
});

// ---- 5 + 6. New-tracks pill, interval ------------------------------------------------

test('the new-tracks pill appears when there are newer posts; tapping it refreshes and scrolls to the top', async ({ page }) => {
  const future = Date.now() + 3600_000;
  let latestFetches = 0;
  await page.route(/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    const body = route.request().postData() ?? '';
    const q = JSON.parse(body).structuredQuery;
    const fields = q.select?.fields?.map((f: { fieldPath: string }) => f.fieldPath) ?? [];
    if (fields.length === 1 && fields[0] === 'createdAt') {
      // The freshness check: createdAt-only mask, createdAt > newest, limit 25.
      expect(q.limit).toBe(25);
      expect(JSON.stringify(q.where)).toContain('GREATER_THAN');
      const rows = [0, 1, 2].map((i) => ({
        document: { name: `projects/p/databases/(default)/documents/posts/new${i}`, fields: { createdAt: { timestampValue: new Date(future - i * 1000).toISOString() } } },
        readTime: new Date().toISOString(),
      }));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    }
    if (!q.select && !q.startAt && q.where.compositeFilter.filters.length === 5) latestFetches++;
    return route.continue();
  });
  await start(page);
  const first = (await page.getByTestId('track-title').first().innerText()).trim();
  const fetchesBefore = latestFetches;
  await page.getByTestId('screen-home').evaluate((el) => el.scrollTo(0, 900));

  await page.evaluate(() => (window as unknown as { __cyberjukeFreshness: { check(): Promise<void> } }).__cyberjukeFreshness.check());
  const pill = page.getByTestId('new-tracks-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText(/3 new tracks/);
  // The feed itself didn't change.
  expect((await page.getByTestId('track-title').first().innerText()).trim()).toBe(first);
  expect(latestFetches).toBe(fetchesBefore);

  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect.poll(() => page.getByTestId('screen-home').evaluate((el) => el.scrollTop)).toBeLessThan(5);
  await expect.poll(() => latestFetches).toBeGreaterThan(fetchesBefore);
  await waitForTracks(page);
});

test('"Check for new tracks" interval is a setting that persists', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-settings').click();
  const group = page.getByTestId('check-every');
  await expect(group).toBeVisible();
  await expect(page.getByTestId('check-every-15')).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('radio')).toHaveText(['5 min', '15 min', '30 min', '1 hour', 'Only when I refresh']);
  await page.getByTestId('check-every-0').click();
  await expect(page.getByTestId('check-every-0')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('check-every-0')).toHaveAttribute('aria-checked', 'true');
  // Arrow keys move the choice.
  await page.getByTestId('check-every-0').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('check-every-5')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('check-every-5')).toBeFocused();
});

// ---- 7. History ----------------------------------------------------------------------

test('history is grouped by day, old untimed history is migrated, and new plays land in Today', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const tr = (id: string, title: string) => ({ id, ytId: 'abcdefghij' + id.slice(-1), title, artist: 'Seeded Artist', genre: 'test', by: 'someone', postTitle: '', postUrl: '', createdAt: '2026-01-01T00:00:00Z', nsfw: false, artworkUrl: '' });
    const now = Date.now();
    const D = 86_400_000;
    const at = (daysAgo: number) => {
      const d = new Date(now - daysAgo * D);
      d.setHours(12, 0, 0, 0);
      return d.getTime();
    };
    localStorage.setItem(
      'CapacitorStorage.history',
      JSON.stringify([
        { track: tr('s1', 'Seed Today'), playedAt: Math.min(now, at(0)) },
        { track: tr('s2', 'Seed Yesterday'), playedAt: at(1) },
        { track: tr('s1', 'Seed Today'), playedAt: at(1) - 1000 },
        { track: tr('s3', 'Seed Three Days'), playedAt: at(3) },
      ]),
    );
  });
  await stubYouTube(page);
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  const labels = page.getByTestId('history-day-label');
  await expect(labels).toHaveCount(3);
  const texts = (await labels.allInnerTexts()).map((t) => t.split('\n')[0].trim());
  expect(texts[0]).toMatch(/^today$/i);
  expect(texts[1]).toMatch(/^yesterday$/i);
  expect(texts[2]).toMatch(/^(mon|tue|wed|thu|fri|sat|sun) \d{1,2} [a-z]{3}/i);
  // Same track on two days: listed on both; the count is of unique tracks.
  await expect(page.getByTestId('history-day').nth(1).getByTestId('track-row')).toHaveCount(2);
  await expect(page.getByTestId('lib-recent').locator('.count')).toHaveText('3');

  // A new play lands at the top of Today.
  await page.getByTestId('tab-home').click();
  await waitForTracks(page);
  const title = (await page.getByTestId('track-title').first().innerText()).trim();
  await page.getByTestId('track-play').first().click();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('history-day').first().getByTestId('track-title').first()).toHaveText(title);
  await page.reload();
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('history-day').first().getByTestId('track-title').first()).toHaveText(title);
});

test('old untimed history is kept on upgrade', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('CapacitorStorage.history')) return;
    const tr = (id: string) => ({ id, ytId: 'abcdefghij' + id.slice(-1), title: 'Old ' + id, artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '', nsfw: false, artworkUrl: '' });
    localStorage.setItem('CapacitorStorage.recent', JSON.stringify([tr('o1'), tr('o2'), tr('o3')]));
  });
  await page.goto('/');
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  await expect(page.getByTestId('recent-list').getByTestId('track-title')).toHaveText(['Old o1', 'Old o2', 'Old o3']);
  await expect(page.getByTestId('history-day-label')).toHaveCount(1);
});

// ---- 8. Lyrics -----------------------------------------------------------------------

const setLyricsMode = (page: Page, mode: string) => page.evaluate((m) => ((window as unknown as { __cyberjukeLyricsMode: string }).__cyberjukeLyricsMode = m), mode);

test('lyrics replace the art: synced lines follow the position, a tap seeks, other scripts and states', async ({ page }) => {
  await start(page);
  await setLyricsMode(page, 'greek');
  await playAndOpen(page, 0);
  const artBox = (await page.locator('.np-art .dos-frame').boundingBox())!;
  await page.getByTestId('np-art').click();
  const panel = page.getByTestId('np-lyrics');
  await expect(panel).toHaveAttribute('data-kind', 'synced');
  // Same frame, same size as the art.
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

  // Tap a line: seeks there.
  const line = page.locator('.lyr-line[data-i="40"]');
  await line.click();
  await expect.poll(async () => Number(await synced.getAttribute('data-current'))).toBeGreaterThanOrEqual(40);
  await expect(line).toHaveClass(/\bon\b/);
  const pos = await page.getByTestId('time-pos').innerText();
  expect(pos).toMatch(/^2:4\d$/);
  for (const d of await page.getByTestId('lyric-line').evaluateAll((els) => els.slice(0, 5).map((e) => e.getAttribute('dir')))) expect(d).toBe('auto');

  // Arabic (right to left) on the next track; the panel stays open.
  await setLyricsMode(page, 'arabic');
  await page.getByTestId('np-next').click();
  await expect(panel).toContainText('القمر يضيء فوق البحر');
  const rtl = await page.getByTestId('lyric-line').first().evaluate((el) => el.matches(':dir(rtl)') && getComputedStyle(el).direction === 'rtl');
  expect(rtl).toBe(true);

  // Japanese, credited to LyricFind.
  await setLyricsMode(page, 'japanese');
  await page.getByTestId('np-next').click();
  await expect(panel).toContainText('夜の街に光が揺れる');
  await expect(page.getByTestId('lyrics-credit')).toHaveText('Source: LyricFind');

  // Spanish.
  await setLyricsMode(page, 'spanish');
  await page.getByTestId('np-next').click();
  await expect(panel).toContainText('Bajo la luna bailamos');

  // Plain lyrics.
  await setLyricsMode(page, 'plain');
  await page.getByTestId('np-next').click();
  await expect(panel).toHaveAttribute('data-kind', 'plain');
  await expect(panel).toContainText('Hold the tape and press rewind');

  // Not found.
  await setLyricsMode(page, 'none');
  await page.getByTestId('np-next').click();
  await expect(panel).toHaveAttribute('data-kind', 'none');
  await expect(page.getByTestId('lyrics-state')).toHaveText('No lyrics found');

  // Instrumental.
  await setLyricsMode(page, 'instrumental');
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('lyrics-state')).toContainText('Instrumental');

  // The lookup got a cleaned title, the first artist and the ytId.
  const req = (await musicCalls(page)).filter((c) => c[0] === 'lyrics').map((c) => c[1] as { ytId: string; title: string; artist: string });
  expect(req.length).toBeGreaterThanOrEqual(7);
  for (const r of req) {
    expect(r.ytId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(r.title).not.toMatch(/official (music )?video/i);
  }

  // Back to the art; the app never says YouTube.
  await page.getByTestId('np-lyrics-toggle').click();
  await expect(page.getByTestId('np-lyrics')).toHaveCount(0);
  await expect(page.getByTestId('np-art')).toBeVisible();
  expect(await page.getByTestId('now-playing').innerText()).not.toMatch(/youtube/i);
});

test('scrolling the lyrics by hand pauses the auto-scroll', async ({ page }) => {
  await start(page);
  await setLyricsMode(page, 'spanish');
  await playAndOpen(page, 0);
  await page.getByTestId('np-lyrics-toggle').click();
  const synced = page.getByTestId('lyrics-synced');
  await expect(synced).toBeVisible();
  await page.waitForTimeout(500);
  await synced.hover();
  await page.mouse.wheel(0, -2000);
  await page.waitForTimeout(300);
  const top = await synced.evaluate((el) => el.scrollTop);
  // The next line arrives within 4 s; the panel stays where the user put it.
  await page.waitForTimeout(2500);
  expect(Math.abs((await synced.evaluate((el) => el.scrollTop)) - top)).toBeLessThan(3);
  // After the pause it centres the current line again.
  await expect.poll(() => synced.evaluate((el) => el.scrollTop), { timeout: 8000 }).toBeGreaterThan(top + 50);
});

// ---- 10. Share -----------------------------------------------------------------------

test('Share in the ⋯ menu shares the track title, artist and music.youtube.com link', async ({ page }) => {
  await start(page);
  await playAndOpen(page, 0);
  const src = (await page.locator('.np-art img').getAttribute('src'))!;
  const ytId = /\/vi\/([^/]+)\//.exec(src)![1];
  const title = (await page.getByTestId('np-title').innerText()).trim();
  await page.getByTestId('np-more').click();
  await expect(page.getByTestId('menu-share')).toHaveText('Share');
  await page.getByTestId('menu-share').click();
  await expect(page.getByTestId('track-menu')).not.toBeVisible();
  const shares = (await musicCalls(page)).filter((c) => c[0] === 'share').map((c) => c[1] as { title: string; text: string; url: string });
  expect(shares).toHaveLength(1);
  expect(shares[0].url).toBe(`https://music.youtube.com/watch?v=${ytId}`);
  expect(shares[0].title.startsWith(title)).toBe(true);
  expect(shares[0].text).toBe(shares[0].title);
  // Track rows have it too.
  await page.getByTestId('np-close').click();
  await page.getByTestId('track-more').nth(3).click();
  await expect(page.getByTestId('menu-share')).toBeVisible();
});

// ---- 11. Queue -----------------------------------------------------------------------

test('Add to queue plays next in the order added, under "Queued by you"', async ({ page }) => {
  await start(page);
  const titles = (await page.getByTestId('track-title').allInnerTexts()).map((t) => t.trim());
  await page.getByTestId('track-play').nth(0).click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  for (const i of [5, 6]) {
    await page.getByTestId('track-more').nth(i).click();
    await expect(page.getByTestId('menu-play-next')).toHaveCount(0); // merged into Add to queue
    await page.getByTestId('menu-add-queue').click();
  }
  await page.getByTestId('mini-open').click();
  const rows = page.getByTestId('upnext-row');
  await expect(rows.nth(0).locator('.row-title')).toHaveText(titles[5]);
  await expect(rows.nth(1).locator('.row-title')).toHaveText(titles[6]);
  await expect(rows.nth(2).locator('.row-title')).toHaveText(titles[1]);
  await expect(page.getByTestId('upnext-queued-label')).toHaveText('Queued by you');
  await expect(page.locator('[data-testid="upnext-row"][data-queued="true"]')).toHaveCount(2);
  const calls = await page.evaluate(() => (window as unknown as { __cyberjukePlayerCalls: unknown[][] }).__cyberjukePlayerCalls);
  expect(calls.filter((c) => c[0] === 'queueNext')).toHaveLength(2);

  // With shuffle on, queued tracks still play next.
  await page.getByTestId('np-shuffle').click();
  await expect(rows.nth(0).locator('.row-title')).toHaveText(titles[5]);
  await expect(rows.nth(1).locator('.row-title')).toHaveText(titles[6]);
  // Playing one removes it from "Queued by you".
  await page.getByTestId('np-next').click();
  await expect(page.getByTestId('np-title')).toHaveText(titles[5]);
  await expect(page.locator('[data-testid="upnext-row"][data-queued="true"]')).toHaveCount(1);
});
