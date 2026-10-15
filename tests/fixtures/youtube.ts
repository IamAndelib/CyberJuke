import type { Page } from '@playwright/test';

/**
 * Stand-ins for YouTube hosts (sandboxes and CI can't, and shouldn't, reach them):
 * thumbnails become synthetic 4:3 letterboxed scenes so the art treatment shows, and
 * the IFrame API becomes a fake player that "plays".
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A 480x360 "hqdefault": 16:9 scene with black letterbox bars, like YouTube's. With
 * `wide`, the 320x180 "mqdefault": the same scene without the bars.
 */
function fakeThumb(id: string, wide = false): string {
  const h = hash(id);
  const hue = h % 360;
  const sx = 120 + (h % 240);
  const kind = (h >> 9) % 3;
  const shapes =
    kind === 0
      ? `<circle cx="${sx}" cy="150" r="52" fill="hsl(${(hue + 40) % 360} 90% 70%)"/>
         <path d="M0 315 L110 200 L190 260 L300 150 L480 290 L480 315 Z" fill="hsl(${hue} 50% 22%)"/>`
      : kind === 1
        ? `<rect x="${sx - 70}" y="95" width="140" height="170" rx="6" fill="hsl(${(hue + 180) % 360} 60% 55%)"/>
           <circle cx="${sx}" cy="160" r="38" fill="hsl(${hue} 30% 15%)"/><circle cx="${sx}" cy="160" r="9" fill="#eee"/>`
        : `<ellipse cx="${sx}" cy="210" rx="70" ry="90" fill="hsl(${hue} 25% 20%)"/>
           <circle cx="${sx}" cy="120" r="44" fill="hsl(${(hue + 20) % 360} 35% 72%)"/>
           <rect x="0" y="260" width="480" height="55" fill="hsl(${(hue + 200) % 360} 40% 30%)"/>`;
  const frame = wide ? 'width="320" height="180" viewBox="0 45 480 270"' : 'width="480" height="360" viewBox="0 0 480 360"';
  return `<svg xmlns="http://www.w3.org/2000/svg" ${frame}>
    <rect width="480" height="360" fill="#000"/>
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 60% 30%)"/>
    </linearGradient></defs>
    <rect x="0" y="45" width="480" height="270" fill="url(#g)"/>
    <g>${shapes}</g>
    <rect x="0" y="0" width="480" height="45" fill="#000"/><rect x="0" y="315" width="480" height="45" fill="#000"/>
  </svg>`;
}

/**
 * A stand-in for the YouTube IFrame API, defined before the app loads (the app's CSP
 * blocks the real script): `window.YT.Player` "plays" by the page's clock (Date.now()),
 * starting at 71 s into a 247 s track, and ends the track by itself when it reaches the
 * end: one timer for that, nothing ticking, so `page.clock` runs a long session in an
 * instant (runFor) or a track at a time (fastForward). `window.__cyberjukeYt` drives the
 * last player: `stall()` makes it buffer (its clock stops) and `resume()` plays on;
 * `end()` ends the track now; `error(code)` reports a player error (2, 5, 100, 101, 150:
 * the track can't play here).
 */
const FAKE_YT = `
(() => {
  const START = 71, DURATION = 247;
  let last = null;
  class Player {
    constructor(el, opts) {
      last = this;
      this.opts = opts; this.base = 0; this.playingSince = null; this.state = -1; this.ending = null; this.starting = null;
      setTimeout(() => opts.events.onReady && opts.events.onReady(), 30);
    }
    emit(s) { this.state = s; this.opts.events.onStateChange && this.opts.events.onStateChange({ data: s }); }
    // Seconds played of this track: what was played before the last pause, plus the stretch since.
    played() { return this.base + (this.playingSince == null ? 0 : (Date.now() - this.playingSince) / 1000); }
    hold() { this.base = this.played(); this.playingSince = null; clearTimeout(this.ending); this.ending = null; }
    // Like the real player: buffering, then playing, unless paused (or cued) meanwhile.
    loadVideoById() { this.hold(); this.base = 0; this.emit(3); clearTimeout(this.starting); this.starting = setTimeout(() => this.playVideo(), 150); }
    cueVideoById() { clearTimeout(this.starting); this.hold(); this.base = 0; this.emit(5); }
    playVideo() {
      this.hold();
      this.playingSince = Date.now();
      this.scheduleEnd();
      this.emit(1);
    }
    // The end comes when the clock gets there (checked, so a jump of the clock can't end a track early).
    scheduleEnd() {
      const left = DURATION - this.getCurrentTime();
      this.ending = setTimeout(() => (this.getCurrentTime() >= DURATION ? this.end() : this.scheduleEnd()), Math.max(0, left * 1000));
    }
    pauseVideo() { clearTimeout(this.starting); this.hold(); this.emit(2); }
    // The stream stalls: buffering, the clock stopped, until resume().
    stall() { clearTimeout(this.starting); this.hold(); this.emit(3); }
    resume() { this.playVideo(); }
    // The track reached its end (the app moves on to the next one).
    end() { clearTimeout(this.starting); this.hold(); this.base = DURATION - START; this.emit(0); }
    error(code) { clearTimeout(this.starting); this.hold(); this.opts.events.onError && this.opts.events.onError({ data: code }); }
    seekTo(s) { const playing = this.playingSince != null; this.hold(); this.base = s - START; if (playing) { this.playingSince = Date.now(); this.scheduleEnd(); } window.__ytSeeks = (window.__ytSeeks || 0) + 1; }
    getCurrentTime() { return this.played() + START; }
    getDuration() { return DURATION; }
    setPlaybackQuality() {}
  }
  window.YT = { Player };
  window.__cyberjukeYt = {
    stall: () => last && last.stall(),
    resume: () => last && last.resume(),
    end: () => last && last.end(),
    error: (code) => last && last.error(code),
  };
})();
`;

/**
 * Pages whose image hosts (these thumbnails, and the Global covers in music.ts) are cut off:
 * their requests fail like a lost connection. setOffline sets it, since the browser's offline
 * mode doesn't reach routed requests; set alone, the app counts as online but no image gets
 * through (a Wi-Fi login page).
 */
const imagesCutOff = new WeakSet<Page>();

export function setImagesOffline(page: Page, off: boolean): void {
  if (off) imagesCutOff.add(page);
  else imagesCutOff.delete(page);
}

const imagesOffline = (page: Page): boolean => imagesCutOff.has(page);

/** Pages whose next request for each image fails once, and the images that already did. */
const switching = new WeakMap<Page, Set<string>>();

/**
 * The connection is back, but the network is still switching: the next request for each image
 * fails once, as Chromium fails the requests in flight when the network changes
 * (ERR_NETWORK_CHANGED); the one after that loads.
 */
export function failImagesOnce(page: Page): void {
  switching.set(page, new Set());
}

/** The image request this route answers fails: the host is cut off, or it is caught in a switch. */
export function imageFails(page: Page, url: string): boolean {
  if (imagesOffline(page)) return true;
  const failed = switching.get(page);
  if (!failed || failed.has(url)) return false;
  failed.add(url);
  return true;
}

/** Synthetic thumbnails for i.ytimg.com and the fake IFrame player. */
export async function stubYouTube(page: Page): Promise<void> {
  await page.route(/^https:\/\/i\.ytimg\.com\/vi\/([^/]+)\//, (route) => {
    if (imageFails(page, route.request().url())) return route.abort('internetdisconnected');
    const id = /\/vi\/([^/]+)\//.exec(route.request().url())?.[1] ?? 'x';
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeThumb(id, /\/mqdefault\.jpg$/.test(route.request().url())) });
  });
  await page.addInitScript(FAKE_YT);
}
