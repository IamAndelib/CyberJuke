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
 *
 * artistPage() returns the artist's page: 5 top songs credited to the artist, a top
 * songs playlist (12 songs, the top 5 among them), and releases of every kind: albums
 * (one titled "Alive", which is not live), a live album classified natively, another
 * only by its title ("Live at the Roxy"), EPs, singles (one "Live Forever", which
 * stays a single), with years and `more` tokens; artistReleases() gives the full
 * lists behind them. Options: noArtistPage (artistPage rejects, so the page falls
 * back to search), shelves (only these kinds), evictToken (the first artistReleases
 * call rejects UNAVAILABLE, like an evicted token), topSongPages (the songs playlist
 * gets that many pages: after the first, more() gives 10 "<Name> Rarity <k>" songs a
 * page, the last page ending with "Moonlit Rarity"; songPageDelay slows those pages).
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
  const NAMES = {};
  const chan = (name) => { const id = 'UC' + ytId('chan|' + name) + ytId('chan2|' + name); NAMES[id] = name; return id; };
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
  const ALBUMS_FULL = [['A Night in Neon', '2023'], ['Analog Dreams', '2019'], ['Alive', '2017'], ['Blue Room Sessions', '2014'],
    ['Early Tapes', '2011'], ['Glass Garden', '2009']];
  const LIVE_FULL = [['Wembley Nights', '2020', 'live'], ['Live at the Roxy', '2015', 'album'], ['Unplugged in Tokyo', '2012', 'album']];
  const EPS_FULL = [['Night Shift EP', '2022'], ['Paper Moons EP', '2018'], ['Satellite EP', '2013']];
  const SINGLES_FULL = [['Static Hearts', '2024'], ['Golden Hour', '2024'], ['Live Forever', '2023'], ['Low Tide', '2022'],
    ['Echo Park', '2021'], ['Neon Rain', '2020'], ['Slow Burn', '2016']];
  const release = (name, kind, [title, year, native]) => ({ kind: native || kind, title, year,
    url: 'https://music.youtube.com/browse/MPREb_' + ytId(name + '|rel|' + title), thumbnailUrl: thumb(name + title) });
  const keep = (kind) => !opts.shelves || opts.shelves.includes(kind);
  const releasesFor = (name, which, full) => {
    const out = [];
    if (which !== 'singles') {
      if (keep('album')) out.push(...ALBUMS_FULL.slice(0, full ? 6 : 4).map((r) => release(name, 'album', r)));
      if (keep('live')) out.push(...LIVE_FULL.slice(0, full ? 3 : 2).map((r) => release(name, 'album', r)));
    }
    if (which !== 'albums') {
      if (keep('ep')) out.push(...EPS_FULL.slice(0, full ? 3 : 2).map((r) => release(name, 'ep', r)));
      if (keep('single')) out.push(...SINGLES_FULL.slice(0, full ? 7 : 4).map((r) => release(name, 'single', r)));
    }
    return out;
  };
  let releaseCalls = 0;
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
      if (filter === 'top') {
        const pages = opts.topSongPages || 1;
        const items = [];
        for (let i = 0; i < 10; i++) {
          const k = (Number(n) - 1) * 10 + i;
          const last = Number(n) === pages - 1 && i === 9;
          items.push(song(last ? 'Moonlit Rarity' : 'Rarity ' + (k + 1), query, query + '|rare|' + k));
        }
        const res = { items };
        if (Number(n) + 1 < pages) res.next = 'tok|top|' + query + '|' + (Number(n) + 1);
        return new Promise((r) => setTimeout(() => r(res), opts.songPageDelay ?? opts.delay ?? 150));
      }
      if (Number(n) >= 6) return fail('UNAVAILABLE', 'unknown or expired paging token');
      const res = { items: page(query, filter, Number(n)) };
      if (Number(n) < 5) res.next = 'tok|' + filter + '|' + query + '|' + (Number(n) + 1);
      return wait(res);
    },
    playlist({ url }) {
      calls.push(['playlist', url]);
      if (opts.botCheck) return fail('BOT_CHECK', 'Sign in to confirm you are not a bot');
      const top = /list=TOPSONGS_(.+)$/.exec(url);
      if (top) {
        const name = decodeURIComponent(top[1]);
        const items = [];
        for (let i = 0; i < 12; i++) items.push(song(SONGS[i % SONGS.length] + (i >= 5 ? ' (Deep Cut)' : ''), name, name + '|top|' + i));
        const res = { title: 'Top songs', subtitle: name, items };
        if ((opts.topSongPages || 1) > 1) res.next = 'tok|top|' + name + '|1';
        return wait(res);
      }
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
    artistPage({ channelId }) {
      calls.push(['artistPage', channelId]);
      if (opts.botCheck) return fail('BOT_CHECK', 'Sign in to confirm you are not a bot');
      if (opts.noArtistPage) return fail('UNAVAILABLE', 'artist page could not be read');
      const name = NAMES[channelId] || 'Artist';
      const topSongs = [];
      for (let i = 0; i < 5; i++) topSongs.push(song(SONGS[i % SONGS.length], name, name + '|top|' + i));
      return wait({ name, thumbnailUrl: thumb('artist' + name), topSongs,
        topSongsPlaylistUrl: 'https://music.youtube.com/playlist?list=TOPSONGS_' + encodeURIComponent(name),
        releases: releasesFor(name, 'all', false),
        more: { albums: 'rel|albums|' + name, singles: 'rel|singles|' + name } });
    },
    artistReleases({ token }) {
      calls.push(['artistReleases', token]);
      releaseCalls++;
      if (opts.evictToken && releaseCalls === 1) return fail('UNAVAILABLE', 'unknown or expired token');
      const [, which, name] = token.split('|');
      return wait({ releases: releasesFor(name, which, true) });
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

export interface MusicStubOptions {
  botCheck?: boolean;
  delay?: number;
  /** artistPage() rejects: the artist page falls back to channel-filtered search. */
  noArtistPage?: boolean;
  /** Only these release kinds on the artist page. */
  shelves?: ('album' | 'live' | 'ep' | 'single')[];
  /** The first artistReleases() call rejects UNAVAILABLE (an evicted "See all" token). */
  evictToken?: boolean;
  /** Pages of the artist's songs playlist (default 1); later pages hold "Rarity" songs, the last "Moonlit Rarity". */
  topSongPages?: number;
  /** Delay of those later pages, in ms (default `delay`, else 150). */
  songPageDelay?: number;
}

export async function stubMusic(page: Page, opts: MusicStubOptions = {}): Promise<void> {
  await page.route(/^https:\/\/lh3\.googleusercontent\.com\/fake\//, (route) => {
    const id = /fake\/([^=]+)/.exec(route.request().url())?.[1] ?? 'x';
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeCover(id) });
  });
  await page.addInitScript((o) => {
    (window as unknown as { __cyberjukeMusicStubOptions: unknown }).__cyberjukeMusicStubOptions = o;
  }, opts);
  await page.addInitScript(FAKE_MUSIC);
}

// ---- Fake Cyberspace login (Firebase Auth) and the signed-in Firestore query ----------

export const AUTH_USER = { email: 'nightowl@example.com', password: 'correct horse battery', username: 'nightowl', uid: 'fakeUid0001' };

/** Members-only posts the fake server adds to signed-in queries (newest first). */
export const MEMBERS_POSTS = [
  { id: 'membersPost001', title: 'Velvet Underground Hours', artist: 'Midnight Members', genre: 'synthwave', yt: 'Mbr00000001', by: 'nightowl' },
  { id: 'membersPost002', title: 'Secret Garden Tape', artist: 'Closed Circle', genre: 'ambient', yt: 'Mbr00000002', by: 'moth' },
  { id: 'membersPost003', title: 'Backroom Radio', artist: 'Midnight Members', genre: 'lo-fi', yt: 'Mbr00000003', by: 'nightowl' },
];
/** A post by a banned author: the members query returns it, the phone must hide it. */
export const BANNED_POST = { id: 'bannedPost001', title: 'Banned Broadcast', artist: 'Nobody', genre: 'noise', yt: 'Ban00000001', by: 'spammer' };

export interface AuthStub {
  calls: { signIn: number; refresh: number; userDoc: number; members: number; unauthorized: number; public: number };
  /** Authorization headers of signed-in queries, in order. */
  tokens: string[];
  /** Bodies of signed-in queries (structuredQuery JSON). */
  memberBodies: any[];
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function fsDoc(p: typeof BANNED_POST, createdAt: string, extra: Record<string, unknown>) {
  return {
    document: {
      name: `projects/cyberspace-cyberspace/databases/(default)/documents/posts/${p.id}`,
      fields: {
        authorUsername: { stringValue: p.by },
        slug: { stringValue: p.id.toLowerCase() },
        title: { stringValue: p.title },
        isNSFW: { booleanValue: false },
        createdAt: { timestampValue: createdAt },
        audioAttachmentGenre: { stringValue: p.genre },
        bookmarksCount: { integerValue: '0' },
        repliesCount: { integerValue: '0' },
        attachments: {
          arrayValue: {
            values: [
              {
                mapValue: {
                  fields: {
                    type: { stringValue: 'audio' },
                    origin: { stringValue: 'youtube' },
                    src: { stringValue: `https://www.youtube.com/watch?v=${p.yt}` },
                    title: { stringValue: p.title },
                    artist: { stringValue: p.artist },
                    genre: { stringValue: p.genre },
                  },
                },
              },
            ],
          },
        },
        ...extra,
      },
    },
  };
}

const PUBLIC_ONLY = [
  ['isPublic', { booleanValue: true }],
  ['isBanned', { booleanValue: false }],
  ['isShadowBanned', { booleanValue: false }],
].map(([fieldPath, value]) => ({ fieldFilter: { field: { fieldPath }, op: 'EQUAL', value } }));

/**
 * A fake Cyberspace login: identitytoolkit (sign-in) and securetoken (refresh), the
 * users/{uid} doc, and the signed-in runQuery. A request with a valid Bearer token
 * gets the live public rows (the members query turned into the public one, sent
 * without the token) plus MEMBERS_POSTS and BANNED_POST, newer than every real post.
 * Requests without a token go to live Firestore untouched.
 *
 * Sign-in errors by input: password "wrong" → INVALID_LOGIN_CREDENTIALS, email
 * starting "busy" → TOO_MANY_ATTEMPTS_TRY_LATER, email starting "offline" → the
 * request fails. `rejectFirstToken`: the first ID token gets one 401 from Firestore.
 */
export async function stubAuth(page: Page, opts: { rejectFirstToken?: boolean } = {}): Promise<AuthStub> {
  const stub: AuthStub = { calls: { signIn: 0, refresh: 0, userDoc: 0, members: 0, unauthorized: 0, public: 0 }, tokens: [], memberBodies: [] };
  const base = Date.now();
  let issued = 0;
  const valid = new Set<string>();
  let rejected = false;
  const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

  await page.route(/^https:\/\/identitytoolkit\.googleapis\.com\//, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    stub.calls.signIn++;
    const body = JSON.parse(req.postData() ?? '{}');
    if (String(body.email).startsWith('offline')) return route.abort('internetdisconnected');
    if (String(body.email).startsWith('busy'))
      return route.fulfill(json(400, { error: { code: 400, message: 'TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled' } }));
    if (body.password === 'wrong' || body.email !== AUTH_USER.email || body.password !== AUTH_USER.password)
      return route.fulfill(json(400, { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } }));
    const idToken = `fake-id-${++issued}`;
    valid.add(idToken);
    return route.fulfill(json(200, { idToken, refreshToken: 'fake-refresh', expiresIn: '3600', localId: AUTH_USER.uid, email: AUTH_USER.email, registered: true }));
  });

  await page.route(/^https:\/\/securetoken\.googleapis\.com\//, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    stub.calls.refresh++;
    const form = new URLSearchParams(req.postData() ?? '');
    if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== 'fake-refresh')
      return route.fulfill(json(400, { error: { code: 400, message: 'INVALID_REFRESH_TOKEN' } }));
    const idToken = `fake-id-${++issued}`;
    valid.add(idToken);
    return route.fulfill(json(200, { id_token: idToken, refresh_token: 'fake-refresh', expires_in: '3600', user_id: AUTH_USER.uid }));
  });

  await page.route(/^https:\/\/firestore\.googleapis\.com\/v1\/projects\/[^/]+\/databases\/\(default\)\/documents\/users\//, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    stub.calls.userDoc++;
    return route.fulfill(json(200, { name: 'users/' + AUTH_USER.uid, fields: { username: { stringValue: AUTH_USER.username } } }));
  });

  await page.route(/^https:\/\/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const auth = (await req.allHeaders())['authorization'];
    if (!auth) {
      stub.calls.public++;
      return route.fallback();
    }
    stub.calls.members++;
    stub.tokens.push(auth);
    const token = auth.replace(/^Bearer /, '');
    if (!valid.has(token)) return route.fulfill(json(401, [{ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }]));
    if (opts.rejectFirstToken && token === 'fake-id-1' && !rejected) {
      rejected = true;
      stub.calls.unauthorized++;
      return route.fulfill(json(401, [{ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }]));
    }
    const body = JSON.parse(req.postData() ?? '{}');
    stub.memberBodies.push(body.structuredQuery);
    // The live public equivalent (Firestore refuses the members query without a real login).
    const pub = structuredClone(body);
    const filters = pub.structuredQuery.where.compositeFilter.filters as any[];
    pub.structuredQuery.where.compositeFilter.filters = [PUBLIC_ONLY[0], filters[0], PUBLIC_ONLY[1], PUBLIC_ONLY[2], ...filters.slice(1)];
    const headers = { ...(await req.allHeaders()) };
    delete headers['authorization'];
    let rows: any[];
    try {
      const res = await route.fetch({ postData: JSON.stringify(pub), headers });
      rows = (await res.json()) as any[];
    } catch {
      // The test ended (or the network failed) while the request was out.
      return route.abort('failed').catch(() => {});
    }
    let extra: any[] = [];
    if (!body.structuredQuery.startAt) {
      const since = filters.find((f) => f.fieldFilter?.op === 'GREATER_THAN')?.fieldFilter.value.timestampValue as string | undefined;
      extra = [
        ...MEMBERS_POSTS.map((p, i) => fsDoc(p, new Date(base - i * 1000).toISOString(), { isPublic: { booleanValue: false } })),
        fsDoc(BANNED_POST, new Date(base - 500).toISOString(), { isPublic: { booleanValue: true }, isBanned: { booleanValue: true } }),
      ]
        .filter((d) => !since || d.document.fields.createdAt.timestampValue > since)
        .sort((a, b) => (a.document.fields.createdAt.timestampValue < b.document.fields.createdAt.timestampValue ? 1 : -1));
    }
    const docs = rows.filter((r) => r.document);
    return route.fulfill(json(200, docs.length || extra.length ? [...extra, ...docs] : rows));
  });
  return stub;
}
