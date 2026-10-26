/**
 * Stand-ins for Jukebox MP3s (Cyberspace 4.0): latex.gg share links and their covers on
 * bunker.cyberspace.online. The MP3 is a few seconds of silence, built frame by frame.
 */
import type { Page } from '@playwright/test';
import { imageFails } from './youtube';

/** Seconds of silence each fake MP3 lasts. */
export const FAKE_MP3_SECONDS = 4;

/**
 * Silent MPEG-1 Layer III: 32 kbit/s, 44.1 kHz, mono, no CRC. A frame is 104 bytes
 * (144 * 32000 / 44100) and 1152 samples; zeroed side info and main data decode to silence.
 */
function silentMp3(seconds: number): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x10, 0xc4]);
  const frame = Buffer.concat([header, Buffer.alloc(104 - header.length)]);
  const frames = Math.ceil((seconds * 44100) / 1152);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

const MP3 = silentMp3(FAKE_MP3_SECONDS);

function fakeCover(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
    <rect width="400" height="400" fill="hsl(${hue} 45% 30%)"/>
    <circle cx="200" cy="200" r="120" fill="hsl(${(hue + 150) % 360} 70% 60%)"/>
  </svg>`;
}

/** Routes latex.gg MP3s and their covers. `failMp3`: the files 404 (gone from latex.gg). */
export async function stubLatex(page: Page, opts: { failMp3?: boolean } = {}): Promise<void> {
  await page.route(/^https:\/\/latex\.gg\/share\/[A-Za-z0-9_-]+\.mp3$/i, (route) => {
    if (opts.failMp3) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'audio/mpeg', headers: { 'accept-ranges': 'bytes' }, body: MP3 });
  });
  await page.route(/^https:\/\/bunker\.cyberspace\.online\/uploads\//, (route) => {
    if (imageFails(page, route.request().url())) return route.abort('internetdisconnected');
    const name = route.request().url().split('/').pop() ?? 'x';
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeCover(name) });
  });
}
