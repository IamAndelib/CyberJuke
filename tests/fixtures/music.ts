import type { Page } from '@playwright/test';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
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
 *
 * radio({ ytId, next }) gives a song's radio: 25 songs a page titled "Radio <n>" by
 * "Radio Artist <k>" (never the seed), with a `next` token for 4 more pages; botCheck
 * rejects it.
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
  const LYRIC_MODES = ['greek', 'english', 'spanish', 'japanese', 'arabic', 'plain', 'none', 'instrumental'];
  const LYRICS = {
    greek: ['Το φεγγάρι λάμπει πάνω από τη θάλασσα', 'Περπατάμε μαζί στον ήσυχο δρόμο', 'Η νύχτα τραγουδά ένα παλιό τραγούδι', 'Και η καρδιά μου χορεύει ξανά'],
    english: ['Neon lights are humming on the boulevard', 'We drive until the static fades to blue', 'Every radio is playing our old song', 'And the night is ours again'],
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
    radio({ ytId, next }) {
      calls.push(['radio', ytId, next ?? null]);
      if (opts.botCheck) return fail('BOT_CHECK', 'Sign in to confirm you are not a bot');
      const n = next ? Number(next.split('|')[2]) : 0;
      const items = [];
      for (let i = 0; i < 25; i++) {
        const k = n * 25 + i;
        items.push(song('Radio ' + (k + 1), 'Radio Artist ' + (k % 7), 'radio|' + ytId + '|' + k));
      }
      const res = { items };
      if (n < 4) res.next = 'radio|' + ytId + '|' + (n + 1);
      return wait(res);
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
function fakeCover(id: string): string {
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

