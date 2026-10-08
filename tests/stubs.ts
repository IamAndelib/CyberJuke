import type { Page } from '@playwright/test';

/**
 * Stand-ins for YouTube hosts, used only by the screenshot spec (sandboxes block
 * i.ytimg.com / youtube.com). Thumbnails become synthetic 4:3 letterboxed scenes so
 * the art treatment is visible; the IFrame API becomes a fake player that "plays".
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A 480x360 "hqdefault": 16:9 scene with black letterbox bars, like YouTube's. */
export function fakeThumb(id: string): string {
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
    <rect width="480" height="360" fill="#000"/>
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 60% 30%)"/>
    </linearGradient></defs>
    <rect x="0" y="45" width="480" height="270" fill="url(#g)"/>
    <g>${shapes}</g>
    <rect x="0" y="0" width="480" height="45" fill="#000"/><rect x="0" y="315" width="480" height="45" fill="#000"/>
  </svg>`;
}

const FAKE_IFRAME_API = `
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
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);
})();
`;

export async function stubYouTube(page: Page): Promise<void> {
  await page.route(/^https:\/\/i\.ytimg\.com\/vi\/([^/]+)\//, (route) => {
    const id = /\/vi\/([^/]+)\//.exec(route.request().url())?.[1] ?? 'x';
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeThumb(id) });
  });
  await page.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_IFRAME_API }),
  );
}

/**
 * A fake `JukeMusic` plugin for the browser build (window.__cyberjukeMusicStub), shaped
 * like the native one: optional fields omitted, artist subtitles empty, album subtitles
 * from playlist() empty, kind 'playlist' outside the albums filter, `next` tokens, and
 * "CODE: detail" rejections. Songs for a query are credited to the query, so an artist
 * page gets "More by" matches. Every song/album/artist carries the first credited
 * artist's channelId (UC + hash of the name), and each songs page mixes in decoys
 * "Ivy <q>" and "<q> Butterfly" (own channels) plus channel-less items, so exact
 * artist matching is exercised ("Ivy Queen" / "Queen Butterfly" for "Queen").
 * artist() returns the decoys first, then the exact name. lyrics() returns synced
 * Greek / Spanish / Japanese / Arabic samples, plain, instrumental or not found
 * (window.__cyberjukeLyricsMode picks one; default by hash of the ytId).
 */
const FAKE_MUSIC = `
(() => {
  const opts = window.__cyberjukeMusicStubOptions || {};
  const SONGS = ['Midnight Drive', 'Neon Rain', 'Paper Moons', 'Static Hearts', 'Low Tide', 'Glass Garden',
    'Satellite Love', 'Afterglow', 'Velvet Static', 'Echo Park', 'Northern Lights', 'Slow Burn',
    'Daydream Radio', 'Golden Hour', 'Cassette Summer', 'Silver Lining', 'Night Swim', 'Blue Hour'];
  const ALBUMS = ['Night Drive', 'Analog Dreams', 'Blue Room Sessions', 'Live at the Roxy', 'Early Tapes'];
  const OTHERS = ['The Midnight', 'Tycho', 'Khruangbin'];
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
  const AB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const mix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
  const ytId = (seed) => { let out = ''; for (let i = 0; i < 11; i++) out += AB[mix(hash(seed + '#' + i)) % 64]; return out; };
  const thumb = (seed) => 'https://lh3.googleusercontent.com/fake/' + ytId(seed) + '=w300-h300';
  const chan = (name) => 'UC' + ytId('chan|' + name) + ytId('chan2|' + name);
  const song = (title, artist, seed, noChannel) => {
    const id = ytId(seed);
    const it = { kind: 'song', title, subtitle: artist, url: 'https://music.youtube.com/watch?v=' + id, ytId: id, thumbnailUrl: thumb(seed) };
    if (!noChannel) {
      const first = artist.split(', ')[0];
      it.channelId = chan(first);
      it.artistUrl = 'https://www.youtube.com/channel/' + it.channelId;
    }
    if (hash(seed) % 5) it.durationSec = 150 + (hash(seed) % 180);
    return it;
  };
  const wait = (v) => new Promise((r) => setTimeout(() => r(v), opts.delay ?? 150));
  const fail = (code, msg) => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(code + ': ' + msg), { code })), 80));
  const page = (query, filter, n) => {
    const q = query.trim();
    if (filter === 'songs') {
      const items = [];
      for (let i = 0; i < 10; i++) {
        const k = n * 10 + i;
        const by = i % 4 === 3 ? OTHERS[k % OTHERS.length] : (i % 5 === 1 ? q + ', ' + OTHERS[k % OTHERS.length] : q);
        items.push(song(SONGS[k % SONGS.length] + (n ? ' (Pt. ' + (n + 1) + ')' : ''), by, q + '|' + k));
      }
      // Decoys (similar names with their own channels) and channel-less items; still 10 a page.
      items[2] = song('Decoy Dance ' + (n + 1), 'Ivy ' + q, q + '|ivy|' + n);
      items[6] = song('Decoy Wings ' + (n + 1), q + ' Butterfly', q + '|bfly|' + n);
      items[8] = song('Unlinked Decoy ' + (n + 1), 'Ivy ' + q, q + '|ivy-nolink|' + n, true);
      items[9] = song('Unlinked Original ' + (n + 1), q, q + '|nolink|' + n, true);
      return items;
    }
    if (filter === 'albums') {
      if (n) return [];
      const albums = ALBUMS.map((a, i) => ({ kind: 'album', title: a, subtitle: i === 4 ? OTHERS[0] : q,
        url: 'https://music.youtube.com/browse/MPREb_' + ytId(q + a), thumbnailUrl: thumb(q + a), channelId: chan(i === 4 ? OTHERS[0] : q) }));
      albums.splice(1, 0, { kind: 'album', title: 'Decoy Album', subtitle: 'Ivy ' + q,
        url: 'https://music.youtube.com/browse/MPREb_' + ytId(q + 'decoy'), thumbnailUrl: thumb(q + 'decoy'), channelId: chan('Ivy ' + q) });
      return albums;
    }
    if (filter === 'artists') {
      return n ? [] : [q, q + ' Orchestra', 'The ' + q + ' Tribute'].map((a) => ({ kind: 'artist', title: a, subtitle: '',
        url: 'https://music.youtube.com/channel/' + chan(a), channelId: chan(a), thumbnailUrl: thumb('artist' + a) }));
    }
    return n ? [] : ['Best of ' + q, q + ' Radio', 'Chill ' + q + ' Mix', q + ' Essentials'].map((p, i) => ({ kind: 'playlist', title: p,
      subtitle: ['Night Owl', 'Curated', 'Mixtapes'][i % 3], url: 'https://music.youtube.com/playlist?list=PL' + ytId(p),
      thumbnailUrl: thumb(p), ...(i === 0 ? { itemCount: 42 } : {}) }));
  };
  const LYRIC_MODES = ['greek', 'spanish', 'japanese', 'arabic', 'plain', 'none', 'instrumental'];
  const LYRICS = {
    greek: ['Το φεγγάρι λάμπει πάνω από τη θάλασσα', 'Περπατάμε μαζί στον ήσυχο δρόμο', 'Η νύχτα τραγουδά ένα παλιό τραγούδι', 'Και η καρδιά μου χορεύει ξανά'],
    spanish: ['Bajo la luna bailamos sin prisa', 'El viento canta en la ciudad dormida', 'Tu voz es un faro en la noche', 'Y el mar nos llama otra vez'],
    japanese: ['夜の街に光が揺れる', '君の声が風に溶けていく', '小さな夢を胸に抱いて', 'もう一度歩き出そう'],
    arabic: ['القمر يضيء فوق البحر', 'نمشي معاً في الطريق الهادئ', 'الليل يغني أغنية قديمة', 'وقلبي يرقص من جديد'],
    plain: ['Static on the radio, a song I used to know', 'Headlights on the ceiling, moving slow', '', 'Hold the tape and press rewind', 'Every chorus left behind'],
  };
  const calls = (window.__cyberjukeMusicCalls = []);
  window.__cyberjukePlayerCalls = [];
  window.__cyberjukeShareStub = (p) => { calls.push(['share', p]); return Promise.resolve(); };
  window.__cyberjukeMusicStub = {
    search({ query, filter }) {
      calls.push(['search', query, filter]);
      if (opts.botCheck) return fail('BOT_CHECK', 'Sign in to confirm you are not a bot');
      const items = page(query, filter, 0);
      return wait(filter === 'songs' ? { items, next: 'tok|songs|' + query + '|1' } : { items });
    },
    more({ next }) {
      calls.push(['more', next]);
      const [, filter, query, n] = next.split('|');
      if (Number(n) >= 6) return fail('UNAVAILABLE', 'unknown or expired paging token');
      const res = { items: page(query, filter, Number(n)) };
      if (Number(n) < 5) res.next = 'tok|' + filter + '|' + query + '|' + (Number(n) + 1);
      return wait(res);
    },
    playlist({ url }) {
      calls.push(['playlist', url]);
      if (opts.botCheck) return fail('BOT_CHECK', 'Sign in to confirm you are not a bot');
      const title = ALBUMS[hash(url) % ALBUMS.length];
      const items = [];
      for (let i = 0; i < 8; i++) items.push(song(SONGS[(hash(url) + i) % SONGS.length], opts.albumArtist || 'Album Artist', url + i));
      return wait({ title, subtitle: '', thumbnailUrl: thumb(url), items });
    },
    artist({ name }) {
      calls.push(['artist', name]);
      if (opts.botCheck) return fail('BOT_CHECK', 'Sign in to confirm you are not a bot');
      const q = name.trim();
      const items = ['Ivy ' + q, q + ' Butterfly', q].map((a) => ({ kind: 'artist', title: a, subtitle: '',
        url: 'https://music.youtube.com/channel/' + chan(a), channelId: chan(a), thumbnailUrl: thumb('artist' + a) }));
      return wait({ items });
    },
    lyrics(o) {
      calls.push(['lyrics', o]);
      const mode = window.__cyberjukeLyricsMode || LYRIC_MODES[hash(o.ytId || o.title) % LYRIC_MODES.length];
      if (mode === 'error') return fail('NETWORK', 'timeout');
      if (mode === 'none') return wait({ found: false });
      if (mode === 'instrumental') return wait({ found: true, source: 'LRCLIB', instrumental: true });
      if (mode === 'plain') return wait({ found: true, source: 'LRCLIB', plain: LYRICS.plain.join('\\n') });
      const lines = LYRICS[mode] || LYRICS.greek;
      const synced = [];
      for (let i = 0; i < 62; i++) synced.push({ t: i * 4000, text: i % 9 === 8 ? '' : lines[i % lines.length] });
      return wait({ found: true, source: mode === 'japanese' ? 'Source: LyricFind' : 'LRCLIB', synced,
        plain: synced.filter((l) => l.text).map((l) => l.text).join('\\n') });
    },
  };
})();
`;

/** Square cover art for Global albums/artists/playlists. */
export function fakeCover(id: string): string {
  const h = hash(id);
  const hue = h % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
    <rect width="300" height="300" fill="hsl(${hue} 55% 40%)"/>
    <circle cx="${90 + (h % 120)}" cy="130" r="70" fill="hsl(${(hue + 50) % 360} 80% 70%)"/>
    <rect x="0" y="210" width="300" height="90" fill="hsl(${(hue + 200) % 360} 45% 22%)"/>
  </svg>`;
}

export async function stubMusic(page: Page, opts: { botCheck?: boolean; delay?: number } = {}): Promise<void> {
  await page.route(/^https:\/\/lh3\.googleusercontent\.com\/fake\//, (route) => {
    const id = /fake\/([^=]+)/.exec(route.request().url())?.[1] ?? 'x';
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeCover(id) });
  });
  await page.addInitScript((o) => {
    (window as unknown as { __cyberjukeMusicStubOptions: unknown }).__cyberjukeMusicStubOptions = o;
  }, opts);
  await page.addInitScript(FAKE_MUSIC);
}
