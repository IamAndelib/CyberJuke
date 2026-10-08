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
export function fakeThumb(id: string, wide = false): string {
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
 * blocks the real script): `window.YT.Player` "plays" by advancing a clock, starting
 * at 71 s into a 247 s track.
 */
const FAKE_YT = `
(() => {
  class Player {
    constructor(el, opts) {
      this.opts = opts; this.t = 0; this.state = -1; this.timer = null;
      setTimeout(() => opts.events.onReady && opts.events.onReady(), 30);
    }
    emit(s) { this.state = s; this.opts.events.onStateChange && this.opts.events.onStateChange({ data: s }); }
    loadVideoById() { this.t = 0; this.emit(3); setTimeout(() => this.playVideo(), 150); }
    cueVideoById() { this.t = 0; this.emit(5); }
    playVideo() {
      clearInterval(this.timer);
      this.timer = setInterval(() => { this.t += 0.25; }, 250);
      this.emit(1);
    }
    pauseVideo() { clearInterval(this.timer); this.emit(2); }
    seekTo(s) { this.t = s - 71; }
    getCurrentTime() { return this.t + 71; }
    getDuration() { return 247; }
    setPlaybackQuality() {}
  }
  window.YT = { Player };
})();
`;

/** Synthetic thumbnails for i.ytimg.com and the fake IFrame player. */
export async function stubYouTube(page: Page): Promise<void> {
  await page.route(/^https:\/\/i\.ytimg\.com\/vi\/([^/]+)\//, (route) => {
    const id = /\/vi\/([^/]+)\//.exec(route.request().url())?.[1] ?? 'x';
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeThumb(id, /\/mqdefault\.jpg$/.test(route.request().url())) });
  });
  await page.addInitScript(FAKE_YT);
}
