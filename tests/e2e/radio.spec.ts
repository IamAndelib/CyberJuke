import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { OFFLINE } from '../../src/core/offlineText';
import { clockStart, expectStable, FAKE_TRACK_MS, openNowPlaying, openSearch, openSettings, playOn, saved, seedStorage, setOffline, SETTINGS_KEY, start, toListEnd, openLibrary } from '../helpers';

/** Signal Radio: the Radio tab, tuning in, stations that lead on to the next, and their tracks kept. */

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
  /** The first of the list on the way (Up next holds 50 rows). */
  way: QTrack[];
  nextStart: number;
  length: number;
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
const idsOf = (id: string) => station(id).tracks.map((t) => `sig:${id}:${t.ytId}`);
/** The station on the way: all of it, by the queue's length, and its songs first in Up next (ids in play order). */
async function onTheWay(page: Page): Promise<{ station: string; size: number; ids: string[] }> {
  const q = await queueState(page);
  const ids = q.way.map((t) => t.id);
  return { station: /^sig:([^:]+):/.exec(ids[0] ?? '')?.[1] ?? '', size: q.nextStart < 0 ? 0 : q.length - q.nextStart, ids };
}

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
  // The station in its listed order, from its first song.
  await expect(page.getByTestId('mini-title')).toHaveText(titlesOf('cipher')[0]);
  // The station row is marked as on air.
  await expect(cipher).toHaveAttribute('aria-current', 'true');
  await expect(cipher.getByTestId('station-on')).toBeVisible();
  await expect(screen.locator('[aria-current]')).toHaveCount(1);

  // The station is the list (all 50 tracks, in order); the next station, all of it, comes on the way as it starts.
  const q = await queueState(page);
  expect(q.context).toEqual({ label: 'Signal Radio · CIPHER', mode: 'list' });
  expect(q.current?.source).toBe('signal');
  expect(q.current?.id).toMatch(/^sig:cipher:[A-Za-z0-9_-]{11}$/);
  expect([q.current, ...q.list].map((t) => t!.id)).toEqual(idsOf('cipher'));
  await expect.poll(async () => (await onTheWay(page)).size).toBe(50);
  expect((await onTheWay(page)).ids).toEqual(idsOf('distortion-field').slice(0, 1));

  await openNowPlaying(page);
  await expect(page.getByTestId('np-from')).toContainText('Signal Radio · CIPHER');
  await expect(page.getByTestId('np-signal')).toHaveText('On Signal Radio · CIPHER');
  // No post to open, no genre page for a callsign.
  await expect(page.getByTestId('np-post')).toHaveCount(0);
  await expect(page.getByTestId('np-genre')).toHaveCount(0);
  await expect.poll(() => place(page)).toEqual({ at: 1, of: 50 });
  await expect(page.getByTestId('upnext-list-label')).toHaveText('Next from: Signal Radio · CIPHER');
  await page.getByTestId('np-close').click();

  // The info button: the station's description and size, and Tune in.
  await page.locator('[data-testid="station"][data-station="the-crypt"]').getByTestId('station-info').click();
  const sheet = page.getByTestId('confirm-sheet');
  await expect(sheet).toContainText('THE CRYPT · 1031.0');
  await expect(sheet).toContainText('32 tracks');
  await expect(sheet).toContainText(station('the-crypt').desc);
  // Information, not a warning: a plain dialog, with Tune in focused first.
  await expect(sheet).toHaveAttribute('role', 'dialog');
  await expect(page.getByTestId('confirm-ok')).toBeFocused();
  await page.getByTestId('confirm-ok').click();
  // Another station: its own tracks, and the mark moves.
  await expect(page.locator('[data-testid="station"][data-station="the-crypt"]')).toHaveAttribute('aria-current', 'true');
  await expect(cipher).not.toHaveAttribute('aria-current');
  await expect.poll(async () => (await queueState(page)).context?.label).toBe('Signal Radio · THE CRYPT');
  await expect(page.getByTestId('mini-title')).toHaveText(titlesOf('the-crypt')[0]);
  const crypt = await queueState(page);
  expect([crypt.current, ...crypt.list].every((t) => t!.id.startsWith('sig:the-crypt:'))).toBe(true);
});

test('a station leads on to the next station, which plays past its end, and its tracks are kept like any other', async ({ page }) => {
  await clockStart(page);
  await start(page);
  await openRadio(page);
  await tune(page, 'the-crypt');
  await openNowPlaying(page);
  // THE CRYPT; MIRRORBALL, the next on the dial, is on the way from its start, in its order.
  await expect.poll(() => place(page)).toEqual({ at: 1, of: 32 });
  await expect.poll(async () => (await onTheWay(page)).size).toBe(40);
  expect((await onTheWay(page)).ids).toEqual(idsOf('mirrorball').slice(0, 50 - 31));
  // Past THE CRYPT's end: MIRRORBALL's first song, and SLOW ORBIT on the way.
  await playOn(page, 32 * (FAKE_TRACK_MS + 200));
  await expect.poll(async () => (await queueState(page)).current?.id).toBe(idsOf('mirrorball')[0]);
  await expect(page.getByTestId('np-from')).toHaveText('More from MIRRORBALL');
  await expect(page.getByTestId('upnext-autoplay-label').first()).toHaveText('More from MIRRORBALL');
  await expect.poll(async () => (await onTheWay(page)).size).toBe(32);
  const q = await queueState(page);
  expect((await onTheWay(page)).ids).toEqual(idsOf('slow-orbit').slice(0, 50 - 39));
  // The label stays the station tuned in (labels follow the song in a later change).
  expect(q.context?.label).toBe('Signal Radio · THE CRYPT');
  // The rest of MIRRORBALL, in order, before SLOW ORBIT.
  expect(q.autoplay.slice(0, 39).map((t) => t.id)).toEqual(idsOf('mirrorball').slice(1));
  const now = q.current!.title;
  await page.getByTestId('np-close').click();

  // Played station tracks come back after a reload with their titles (Recently played).
  await page.reload();
  await page.getByTestId('tab-library').click();
  await openLibrary(page, 'recent');
  const recent = page.getByTestId('recent-list').getByTestId('track-title');
  await expect(recent.first()).toHaveText(now);
});

test('stations lead on with Autoplay off too: it is the radio, not autoplay', async ({ page }) => {
  await start(page);
  await openSettings(page);
  const toggle = page.getByTestId('autoplay-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await openRadio(page);
  await tune(page, 'slow-orbit');
  // The next station (AFTER HOURS, 40) is on the way, as with Autoplay on.
  await openNowPlaying(page);
  await expect.poll(() => place(page)).toEqual({ at: 1, of: 32 });
  await toListEnd(page);
  await expect.poll(() => place(page)).toEqual({ at: 32, of: 32 });
  await expect(page.getByTestId('upnext-way-label')).toHaveText('On the way');
  expect(await onTheWay(page)).toEqual({ station: 'after-hours', size: 40, ids: idsOf('after-hours').slice(0, 40) });
  // Turning Autoplay off while a station plays leaves the next one alone.
  await page.getByTestId('np-close').click();
  await openSettings(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await openNowPlaying(page);
  await expect(page.getByTestId('upnext-way-label')).toHaveText('On the way');
  expect(await place(page)).toEqual({ at: 32, of: 32 });
  expect((await onTheWay(page)).station).toBe('after-hours');
});

test('with shuffle, a station plays mixed, then a random station not heard yet, mixed too; toggled, it stays the next', async ({ page }) => {
  await clockStart(page);
  await start(page);
  await openRadio(page);
  await tune(page, 'cipher');
  await openNowPlaying(page);
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('np-close').click();
  // Tuned in with shuffle on: THE CRYPT mixed (from any song), then another station, all of it, mixed.
  await tune(page, 'the-crypt');
  await expect.poll(async () => (await queueState(page)).context?.label).toBe('Signal Radio · THE CRYPT');
  const q = await queueState(page);
  expect([q.current, ...q.list].map((t) => t!.id).sort()).toEqual(idsOf('the-crypt').sort());
  expect([q.current, ...q.list].map((t) => t!.id)).not.toEqual(idsOf('the-crypt'));
  await expect.poll(async () => (await onTheWay(page)).size).toBeGreaterThan(0);
  const first = await onTheWay(page);
  expect(first.station).not.toBe('the-crypt');
  expect(first.size).toBe(station(first.station).tracks.length);
  expect(first.ids.every((id) => id.startsWith(`sig:${first.station}:`))).toBe(true);
  expect(first.ids).not.toEqual(idsOf(first.station).slice(0, first.ids.length));
  // Past THE CRYPT: that station plays, and the next is neither of the two.
  await playOn(page, 32 * (FAKE_TRACK_MS + 200));
  await expect.poll(async () => (await queueState(page)).current?.id.split(':')[1]).toBe(first.station);
  await expect.poll(async () => (await onTheWay(page)).size).toBeGreaterThan(0);
  const second = await onTheWay(page);
  expect([first.station, 'the-crypt']).not.toContain(second.station);
  expect(second.size).toBe(station(second.station).tracks.length);
  // Shuffle off: it stays the next station, in its order now (D10).
  await openNowPlaying(page);
  await page.getByTestId('np-shuffle').click();
  await expect(page.getByTestId('np-shuffle')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await onTheWay(page)).ids[0]).toBe(idsOf(second.station)[0]);
  expect((await onTheWay(page)).station).toBe(second.station);
});

test('with Repeat all, a station loops, also one tuned in with Repeat all already on: no next station', async ({ page }) => {
  await start(page);
  await openRadio(page);
  await tune(page, 'the-crypt');
  await openNowPlaying(page);
  await expect.poll(async () => (await onTheWay(page)).size).toBe(40);
  const repeat = page.getByTestId('np-repeat');
  await repeat.click();
  await expect(repeat).toHaveAttribute('data-mode', 'all');
  await expect(page.getByTestId('upnext-way-label')).toHaveCount(0);
  expect((await onTheWay(page)).size).toBe(0);
  await page.getByTestId('np-close').click();
  // Another station with Repeat all on: it loops, its last song goes round to its first.
  await tune(page, 'slow-orbit');
  await expect.poll(async () => (await queueState(page)).context?.label).toBe('Signal Radio · SLOW ORBIT');
  await openNowPlaying(page);
  await toListEnd(page);
  await expect.poll(() => place(page)).toEqual({ at: 32, of: 32 });
  await expectStable(async () => (await onTheWay(page)).size, 500);
  expect((await onTheWay(page)).size).toBe(0);
  await page.getByTestId('np-next').click();
  await expect.poll(async () => (await queueState(page)).current?.id).toBe(idsOf('slow-orbit')[0]);
});

test("a station's track played from another list is just a track there: with Autoplay off it stops at the end", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const toggle = page.getByTestId('autoplay-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await openRadio(page);
  await tune(page, 'slow-orbit');
  const first = (await page.getByTestId('mini-title').textContent())!.trim();
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  await page.getByTestId('mini-next').click();
  await expect(page.getByTestId('mini-title')).not.toHaveText(first);
  // From Recently played, which now holds two of the station's tracks: the older one.
  await page.getByTestId('tab-library').click();
  await openLibrary(page, 'recent');
  const rows = page.getByTestId('recent-list').getByTestId('track-row');
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: first }).getByTestId('track-play').click();
  await expect(page.getByTestId('mini-title')).toHaveText(first);
  await openNowPlaying(page);
  await expect(page.getByTestId('np-from')).toContainText('Recently played');
  // The two plays and nothing after them: no next station.
  await expectStable(() => place(page), 1000);
  expect(await place(page)).toEqual({ at: 2, of: 2 });
  await expect(page.getByTestId('upnext-autoplay-label')).toHaveCount(0);
});

test('offline the stations dim like any track that cannot play, and a tap says why; the one on air stays bright', async ({ page, backend }) => {
  await start(page);
  await openRadio(page);
  const stations = page.getByTestId('station');
  const cipher = page.locator('[data-testid="station"][data-station="cipher"]');
  await setOffline(page, backend, true);
  await expect(stations.and(page.locator('.off'))).toHaveCount(16);
  await expect(cipher.getByTestId('station-tune')).toHaveAttribute('aria-disabled', 'true');
  // The ⓘ still opens.
  await expect(cipher.getByTestId('station-info')).not.toHaveAttribute('aria-disabled');
  await cipher.getByTestId('station-tune').click({ force: true });
  await expect(page.getByTestId('toast').last()).toHaveText(OFFLINE.tap);
  await expect(page.getByTestId('mini-player')).toHaveCount(0);
  await setOffline(page, backend, false);
  await expect(stations.and(page.locator('.off'))).toHaveCount(0);
  await expect(cipher.getByTestId('station-tune')).not.toHaveAttribute('aria-disabled');

  // Tuned in, then the connection drops: the station playing stays bright, the rest dim.
  await tune(page, 'cipher');
  await setOffline(page, backend, true);
  await expect(stations.and(page.locator('.off'))).toHaveCount(15);
  await expect(cipher).not.toHaveClass(/\boff\b/);
});

test('offline, a tap on another station is refused and changes nothing: the stations heard in the chain playing stay', async ({ page, backend }) => {
  await start(page);
  await openRadio(page);
  await tune(page, 'cipher');
  const heard = () => page.evaluate(() => localStorage.getItem('CapacitorStorage.radio.heard'));
  await expect.poll(heard).toBe('["cipher"]');
  await setOffline(page, backend, true);
  await page.locator('[data-testid="station"][data-station="the-crypt"]').getByTestId('station-tune').click({ force: true });
  await expect(page.getByTestId('toast').last()).toHaveText(OFFLINE.tap);
  expect((await queueState(page)).context?.label).toBe('Signal Radio · CIPHER');
  await expectStable(heard, 500);
  expect(await heard()).toBe('["cipher"]');
});

test('offline a station dims even with one of its tracks saved: tuning in needs the network', async ({ page, backend }) => {
  await start(page);
  await openRadio(page);
  const cipher = page.locator('[data-testid="station"][data-station="cipher"]');
  await saved(page, [station('cipher').tracks[0].ytId]);
  await setOffline(page, backend, true);
  await expect(cipher).toHaveClass(/\boff\b/);
  await expect(cipher.getByTestId('station-tune')).toHaveAttribute('aria-disabled', 'true');
});

test('the station on air, paused: a tap plays it on (as a track row does), and Now Playing stays shut', async ({ page }) => {
  await start(page);
  await openRadio(page);
  const cipher = page.locator('[data-testid="station"][data-station="cipher"]');
  await tune(page, 'cipher');
  const first = (await page.getByTestId('mini-title').textContent())!.trim();
  await page.getByTestId('mini-toggle').click();
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Play');
  await cipher.getByTestId('station-tune').click();
  await expect(page.getByTestId('mini-toggle')).toHaveAttribute('aria-label', 'Pause');
  await expect(page.getByTestId('mini-title')).toHaveText(first);
  await expect(page.getByTestId('now-playing')).not.toHaveClass(/open/);
  // Playing, the same tap opens Now Playing.
  await cipher.getByTestId('station-tune').click();
  await expect(page.getByTestId('now-playing')).toHaveClass(/open/);
});

test('Here on the Radio tab searches every station track, and plays the one found', async ({ page }) => {
  await start(page);
  await openRadio(page);
  await openSearch(page);
  await expect(page.getByTestId('mode-here')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('search-input')).toHaveAttribute('placeholder', 'Search in Signal Radio');
  await page.getByTestId('search-input').fill('vintervaldet');
  const found = page.getByTestId('here-results').getByTestId('track-title');
  await expect(found).toHaveText(['Vinterväldet']);
  await found.first().click();
  await expect(page.getByTestId('mini-title')).toHaveText('Vinterväldet');
});

for (const [width, theme] of [[320, 'dark'], [360, 'dark'], [320, 'c64'], [320, 'brutalist'], [320, 'vt320']] as const) {
  test(`five tabs fit at ${width} px in ${theme}, every label whole and apart`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await seedStorage(page, { [SETTINGS_KEY]: { theme } });
    await start(page);
    const tabs = page.locator('.tabbar .tab');
    await expect(tabs).toHaveCount(5);
    await expect(tabs.locator('.tab-label')).toHaveText(['Home', 'Genres', 'Artists', 'Library', 'Radio']);
    const fits = await page.locator('.tabbar').evaluate((bar) => {
      const labels = [...bar.querySelectorAll<HTMLElement>('.tab-label')];
      const rects = labels.map((l) => l.getBoundingClientRect());
      return {
        bar: bar.scrollWidth <= bar.clientWidth,
        labels: labels.map((l, i) => {
          const tab = l.closest('.tab')!.getBoundingClientRect();
          const r = rects[i];
          return r.left >= tab.left - 0.5 && r.right <= tab.right + 0.5 && l.scrollWidth <= Math.ceil(r.width) && r.height < 20;
        }),
        // Neighbouring labels never read as one word: a visible gap between them.
        apart: rects.slice(1).every((r, i) => r.left - rects[i].right >= 3),
      };
    });
    expect(fits).toEqual({ bar: true, labels: [true, true, true, true, true], apart: true });
  });
}
