import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { clockStart, FAKE_TRACK_MS, openNowPlaying, playOn, start } from '../helpers';

/** Signal Radio: the Radio tab, tuning in, a station that plays on, and its tracks kept. */

interface QTrack {
  id: string;
  title: string;
  source: string;
}
interface QState {
  context: { label: string; mode: 'radio' | 'list' } | null;
  current: QTrack | null;
  seed: QTrack | null;
  list: QTrack[];
  autoplay: QTrack[];
}
const queueState = (page: Page) => page.evaluate(() => (window as unknown as { __cyberjukeQueue: () => QState }).__cyberjukeQueue());

interface StationData {
  id: string;
  desc: string;
  tracks: { ytId: string; title: string }[];
}
const STATIONS = (JSON.parse(readFileSync(new URL('../../src/data/radio/stations.json', import.meta.url), 'utf8')) as { stations: StationData[] }).stations;
const station = (id: string) => STATIONS.find((s) => s.id === id)!;
const titlesOf = (id: string) => station(id).tracks.map((t) => t.title);

/** "3 of 64 · Playing from …": the place in the list, and the list's length. */
async function place(page: Page): Promise<{ at: number; of: number }> {
  const m = /^(\d+) of (\d+)/.exec((await page.getByTestId('np-from').textContent()) ?? '');
  return m ? { at: Number(m[1]), of: Number(m[2]) } : { at: 0, of: 0 };
}

async function openRadio(page: Page) {
  await page.getByTestId('tab-radio').click();
  await expect(page.getByTestId('screen-radio')).toBeVisible();
}

async function tune(page: Page, id: string) {
  await page.locator(`[data-testid="station"][data-station="${id}"]`).getByTestId('station-tune').click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
}

test('the Radio tab lists both bands; tuning in plays the station and Now Playing says so', async ({ page }) => {
  await start(page);
  await openRadio(page);
  const screen = page.getByTestId('screen-radio');
  await expect(screen.locator('.topbar')).toContainText('Signal Radio');
  await expect(page.getByTestId('band-ym').getByTestId('station')).toHaveCount(8);
  await expect(page.getByTestId('band-zm').getByTestId('station')).toHaveCount(8);
  const cipher = page.locator('[data-testid="station"][data-station="cipher"]');
  await expect(cipher).toContainText('133.7');
  await expect(cipher).toContainText('CIPHER');
  await expect(cipher).toContainText('digital infiltration, late-night breakbeat');
  await expect(page.locator('[data-testid="station"][data-station="cold-wave"]')).toContainText('273.0');
  await expect(screen.locator('[aria-current]')).toHaveCount(0);

  await tune(page, 'cipher');
  expect(titlesOf('cipher')).toContain((await page.getByTestId('mini-title').textContent())!.trim());
  // The station row is marked as on air.
  await expect(cipher).toHaveAttribute('aria-current', 'true');
  await expect(cipher.getByTestId('station-on')).toBeVisible();
  await expect(screen.locator('[aria-current]')).toHaveCount(1);

  // The round is the list (all 50 tracks, once each), the next round autoplay.
  const q = await queueState(page);
  expect(q.context).toEqual({ label: 'Signal Radio · CIPHER', mode: 'list' });
  expect(q.current?.source).toBe('signal');
  expect(q.current?.id).toMatch(/^sig:cipher:[A-Za-z0-9_-]{11}$/);
  await expect.poll(async () => (await queueState(page)).autoplay.length).toBeGreaterThan(0);

  await openNowPlaying(page);
  await expect(page.getByTestId('np-from')).toContainText('Signal Radio · CIPHER');
  await expect(page.getByTestId('np-signal')).toHaveText('On Signal Radio · CIPHER');
  // No post to open, no genre page for a callsign.
  await expect(page.getByTestId('np-post')).toHaveCount(0);
  await expect(page.getByTestId('np-genre')).toHaveCount(0);
  await expect.poll(() => place(page)).toEqual({ at: 1, of: 100 });
  await expect(page.getByTestId('upnext-list-label')).toHaveText('Next from: Signal Radio · CIPHER');
  await page.getByTestId('np-close').click();

  // The info button: the station's description and size, and Tune in.
  await page.locator('[data-testid="station"][data-station="the-crypt"]').getByTestId('station-info').click();
  const sheet = page.getByTestId('confirm-sheet');
  await expect(sheet).toContainText('THE CRYPT · 1031.0');
  await expect(sheet).toContainText('32 tracks');
  await expect(sheet).toContainText(station('the-crypt').desc);
  await page.getByTestId('confirm-ok').click();
  // Another station: its own tracks, and the mark moves.
  await expect(page.locator('[data-testid="station"][data-station="the-crypt"]')).toHaveAttribute('aria-current', 'true');
  await expect(cipher).not.toHaveAttribute('aria-current');
  await expect.poll(async () => (await queueState(page)).context?.label).toBe('Signal Radio · THE CRYPT');
  expect(titlesOf('the-crypt')).toContain((await page.getByTestId('mini-title').textContent())!.trim());
  const crypt = await queueState(page);
  expect([crypt.current, ...crypt.list].every((t) => t!.id.startsWith('sig:the-crypt:'))).toBe(true);
});

test('a station plays on past its rounds, and its tracks are kept like any other', async ({ page }) => {
  await clockStart(page);
  await start(page);
  await openRadio(page);
  await tune(page, 'the-crypt');
  await openNowPlaying(page);
  // The first round, and the next one queued behind it.
  await expect.poll(() => place(page)).toEqual({ at: 1, of: 64 });
  // Past both of them but the last few: another round comes.
  await playOn(page, 60 * (FAKE_TRACK_MS + 200));
  await expect.poll(() => place(page)).toEqual({ at: 61, of: 96 });
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveText('More from THE CRYPT');
  const q = await queueState(page);
  expect(q.context?.label).toBe('Signal Radio · THE CRYPT');
  expect([...q.list, ...q.autoplay].every((t) => t.id.startsWith('sig:the-crypt:'))).toBe(true);
  const now = q.current!.title;
  expect(titlesOf('the-crypt')).toContain(now);
  await page.getByTestId('np-close').click();

  // Played station tracks come back after a reload with their titles (Recently played).
  await page.reload();
  await page.getByTestId('tab-library').click();
  await page.getByTestId('lib-recent').click();
  const recent = page.getByTestId('recent-list').getByTestId('track-title');
  await expect(recent.first()).toHaveText(now);
});

test('a station plays on with Autoplay off too: it is the station, not autoplay', async ({ page }) => {
  await start(page);
  await page.getByTestId('tab-settings').click();
  const toggle = page.getByTestId('autoplay-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await openRadio(page);
  await tune(page, 'slow-orbit');
  // Its next round (32 more) follows the first, as with Autoplay on.
  await openNowPlaying(page);
  await expect.poll(() => place(page)).toEqual({ at: 1, of: 64 });
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveText('More from SLOW ORBIT');
  // Turning Autoplay off while a station plays leaves its rounds alone.
  await page.getByTestId('np-close').click();
  await page.getByTestId('tab-settings').click();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveText('More from SLOW ORBIT');
  expect(await place(page)).toEqual({ at: 1, of: 64 });
});

for (const width of [320, 360]) {
  test(`six tabs fit at ${width} px, every label whole`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await start(page);
    const tabs = page.locator('.tabbar .tab');
    await expect(tabs).toHaveCount(6);
    await expect(tabs.locator('.tab-label')).toHaveText(['Home', 'Radio', 'Genres', 'Artists', 'Library', 'Settings']);
    const fits = await page.locator('.tabbar').evaluate((bar) => ({
      bar: bar.scrollWidth <= bar.clientWidth,
      labels: [...bar.querySelectorAll<HTMLElement>('.tab-label')].map((l) => {
        const tab = l.closest('.tab')!.getBoundingClientRect();
        const r = l.getBoundingClientRect();
        return r.left >= tab.left - 0.5 && r.right <= tab.right + 0.5 && l.scrollWidth <= Math.ceil(r.width) && r.height < 20;
      }),
    }));
    expect(fits).toEqual({ bar: true, labels: [true, true, true, true, true, true] });
  });
}
