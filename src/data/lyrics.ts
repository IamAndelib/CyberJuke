/**
 * Lyrics for Now Playing. The lookup runs natively (JukeMusic.lyrics: LRCLIB first,
 * then the licensed LyricFind lyrics as a fallback), so the WebView never hits CORS.
 * This module cleans the lookup metadata, normalizes and caches results, and holds the
 * pure helpers the panel uses (LRC parsing, current line).
 *
 * Cache: an LRU of LYRICS_CACHE_MAX results in the cache file
 * cyberjuke-cache/lyrics.json (migrated once from the Preferences key lyrics.v1);
 * "not found" is cached too, for NOT_FOUND_TTL_MS, so a song without lyrics isn't
 * looked up on every play. Failures (offline, plugin unavailable) are never cached.
 * Lyrics of members-only tracks are marked, so signing out can drop them.
 *
 * Kept: the lyrics of liked songs saved on the phone (keepSaved) go into a second file in the
 * app's data (cyberjuke/lyrics-saved.json), out of the LRU and of what Android clears to free
 * space, as long as the song is liked; those missing are looked up once in the background, one
 * at a time, so they show offline too. Looked up before the song had played (no length to match
 * on), they are asked again with its length the first time they're opened online.
 */
import { cleanCredit, splitArtists } from './artists';
import type { Track } from './model';
import { appPlugin, toMusicError, type JukeMusicPlugin, type LyricsResult } from './ytmusic';
import { Cache, InFlight } from '../core/cache';
import { textFile } from '../core/storage';
import { online } from '../core/network';

interface LyricLine {
  /** ms from the start of the track. */
  t: number;
  text: string;
}

/** Lyrics as shown: the plugin's answer after normalizeLyrics (lines checked and in order). */
export type Lyrics = LyricsResult;

const LYRICS_CACHE_MAX = 300;
export const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---- Cleaning titles for lookups -------------------------------------------------------

/** Words that make a bracketed or dash-separated part "noise" rather than title. */
const NOISE =
  /\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|music video|mv|m\/v|hd|hq|4k|1080p|720p|remaster(ed)?|\d{4} remaster|live|slowed|reverb|sped up|nightcore|remix|mix|edit|version|ver\.?|explicit|clean|full album|out now|premiere|color coded|eng sub|sub español|letra|legendado)\b/i;
const BRACKETS = /\s*(\([^()]*\)|\[[^\]]*\]|\{[^}]*\}|【[^】]*】|「[^」]*」|『[^』]*』|（[^（）]*）)\s*/g;
const FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;

/**
 * A title as a lyrics database knows it: brackets ("(Official Video)", "[slowed +
 * reverb]", "【MV】"), "feat. …", an "Artist - " prefix, and trailing " - Remastered"
 * / " | Lyrics" parts are removed. Falls back to the trimmed original if nothing is left.
 */
export function cleanTitle(title: string, artist = ''): string {
  const original = (title ?? '').replace(/\s+/g, ' ').trim();
  let s = original.replace(BRACKETS, ' ');
  // "Song | Official Video", "Song // Lyrics"
  s = s.split(/\s+(?:\||\/\/|•)\s+/)[0];
  // "Artist - Song" -> "Song"; "Song - Remastered 2011" -> "Song"
  const parts = s.split(/\s+[-–—]\s+/);
  const names = [artist, ...splitArtists(cleanCredit(artist))].map(fold).filter(Boolean);
  if (parts.length > 1 && names.includes(fold(parts[0]))) parts.shift();
  while (parts.length > 1 && NOISE.test(parts[parts.length - 1])) parts.pop();
  s = parts.join(' - ');
  s = s.replace(FEAT, '');
  s = s.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  return s || original;
}

/** The first credited artist, without " - Topic". */
export function cleanArtist(artist: string): string {
  const c = cleanCredit(artist ?? '');
  return splitArtists(c)[0] ?? c;
}

function fold(s: string): string {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

// ---- LRC --------------------------------------------------------------------------------

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i;

/** Whether text carries LRC time tags. */
function looksLikeLrc(text: string): boolean {
  return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text ?? '');
}

/**
 * Parse LRC: one or more `[mm:ss.xx]` tags per line (each makes its own line),
 * `[offset:±ms]` (positive = lyrics come sooner), metadata tags ignored. Lines with a
 * tag but no text are kept as '' (instrumental breaks); untagged lines are dropped.
 * Sorted by time.
 */
export function parseLrc(text: string): LyricLine[] {
  let offset = 0;
  const out: LyricLine[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const off = OFFSET_TAG.exec(raw);
    if (off) {
      offset = Number(off[1]) || 0;
      continue;
    }
    const times: number[] = [];
    TIME_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    let end = 0;
    // Tags are at the start of the line, possibly several in a row.
    while ((m = TIME_TAG.exec(raw)) && raw.slice(end, m.index).trim() === '') {
      const frac = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0;
      times.push(Number(m[1]) * 60_000 + Number(m[2]) * 1000 + frac);
      end = m.index + m[0].length;
    }
    if (!times.length) continue;
    const lineText = raw.slice(end).trim();
    for (const t of times) out.push({ t, text: lineText });
  }
  for (const l of out) l.t = Math.max(0, l.t - offset);
  return out.sort((a, b) => a.t - b.t);
}

/** Index of the line being sung at `ms` (the last one starting at or before it), -1 before the first. */
export function activeLine(lines: LyricLine[], ms: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Plugin result -> Lyrics. Plain text carrying LRC tags is parsed as synced. */
export function normalizeLyrics(r: LyricsResult | null | undefined): Lyrics {
  if (!r || !r.found) return { found: false };
  const out: Lyrics = { found: true, ...(r.source && { source: r.source }) };
  if (r.instrumental) out.instrumental = true;
  const synced = Array.isArray(r.synced)
    ? r.synced
        .filter((l) => l && typeof l.t === 'number' && isFinite(l.t) && typeof l.text === 'string')
        .map((l) => ({ t: Math.max(0, l.t), text: l.text.trim() }))
        .sort((a, b) => a.t - b.t)
    : [];
  if (synced.some((l) => l.text)) out.synced = synced;
  const plain = typeof r.plain === 'string' ? r.plain.replace(/\r\n/g, '\n').trim() : '';
  if (plain) {
    if (!out.synced && looksLikeLrc(plain)) {
      const parsed = parseLrc(plain);
      if (parsed.some((l) => l.text)) out.synced = parsed;
    } else out.plain = plain;
  }
  if (!out.synced && !out.plain && !out.instrumental) return { found: false };
  return out;
}

// ---- Cache ---------------------------------------------------------------------------------

interface LyricsStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface CacheEntry {
  at: number;
  l: Lyrics;
  /** For a members-only track. */
  m?: true;
  /** Looked up without the track's length (kept ahead of playing it): asked again with it once online. */
  nd?: true;
}

/** Between two background lookups for saved songs (LRCLIB rate-limits; nothing waits on them). */
export const KEEP_LOOKUP_GAP_MS = 3000;

export const LYRICS_CACHE_KEY = 'lyrics.v1';
/**
 * The cache file is written this long after the last lookup that changed it: the whole file
 * each time, so the track's and the next one's lookups make one write. Signing out writes at once.
 */
export const LYRICS_PERSIST_MS = 2000;

export type LyricsOutcome = { status: 'ok'; lyrics: Lyrics } | { status: 'error'; offline: boolean };

interface LyricsClient {
  get(track: Track, durationMs?: number): Promise<LyricsOutcome>;
  /** A cached result, if any (no request). */
  peek(trackId: string): Lyrics | undefined;
  /** Forget the lyrics of members-only tracks (signed out). */
  dropMembersOnly(): Promise<void>;
  /**
   * Keep the lyrics of `saved` (the liked songs saved on the phone), looking up those not known
   * yet in the background; kept ones go once their song is no longer in `likedIds` (never on an
   * empty list: Liked unread). Call again whenever either changes.
   */
  keepSaved(saved: readonly Track[], likedIds: ReadonlySet<string>): Promise<void>;
}

interface LyricsDeps {
  plugin: () => Pick<JukeMusicPlugin, 'lyrics'> | null;
  storage: LyricsStorage;
  /** Where the kept lyrics of saved songs live (keepSaved); none: they aren't kept. */
  keptStorage?: LyricsStorage;
  now?: () => number;
  max?: number;
  isOffline?: () => boolean;
  /** Waits between two background lookups (tests pass one that doesn't). */
  pause?: (ms: number) => Promise<void>;
}

export function createLyricsClient(deps: LyricsDeps): LyricsClient {
  const now = deps.now ?? (() => Date.now());
  const max = deps.max ?? LYRICS_CACHE_MAX;
  /** Least recently used first; "not found" is stale after NOT_FOUND_TTL_MS, found lyrics never are. */
  let cache: Cache<string, CacheEntry> | null = null;
  let loading: Promise<Cache<string, CacheEntry>> | null = null;
  const inflight = new InFlight<string, LyricsOutcome>();
  // Requests go one at a time (LRCLIB rate-limits).
  let chain: Promise<unknown> = Promise.resolve();
  /** Bumped by dropMembersOnly: a members-only lookup from before it isn't kept. */
  let drops = 0;
  /** The kept lyrics of saved liked songs (keepSaved), by track id; read with the cache. */
  const kept = new Map<string, CacheEntry>();
  /** The saved songs whose lyrics are kept (the last keepSaved), and the members-only ones among them. */
  let keepIds = new Set<string>();
  let keepMembers = new Set<string>();
  /** Saved songs still to look up in the background, in order; a running loop takes from it. */
  let toLookUp: Track[] = [];
  let lookingUp = false;
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** The entries of a stored file, or none (unreadable or corrupt: start over). */
  const read = (s: LyricsStorage | undefined): Promise<[string, CacheEntry][]> =>
    (s ? s.get(LYRICS_CACHE_KEY) : Promise.resolve(null))
      .catch(() => null)
      .then((raw) => {
        try {
          const o: unknown = raw ? JSON.parse(raw) : [];
          return Array.isArray(o) ? (o as [string, CacheEntry][]).filter(([k, v]) => typeof k === 'string' && v && typeof v.at === 'number' && v.l) : [];
        } catch {
          return [];
        }
      });
  const ready = () =>
    cache
      ? Promise.resolve(cache)
      : (loading ??= Promise.all([read(deps.storage), read(deps.keptStorage)]).then(([lru, keptEntries]) => {
          const c = new Cache<string, CacheEntry>({ max, now, ttlMs: (e) => (e.l.found ? Infinity : NOT_FOUND_TTL_MS) });
          for (const [k, v] of lru) c.restore(k, v, v.at);
          for (const [k, v] of keptEntries) kept.set(k, v);
          return (cache = c);
        }));
  /** A kept entry still good: found lyrics, or "not found" for NOT_FOUND_TTL_MS. */
  const fresh = (e: CacheEntry | undefined): e is CacheEntry => !!e && (e.l.found || now() - e.at < NOT_FOUND_TTL_MS);
  // The kept file, written as the cache file is: once, a moment after the last change.
  let keptTimer: ReturnType<typeof setTimeout> | null = null;
  const persistKeptNow = () => {
    if (keptTimer) clearTimeout(keptTimer);
    keptTimer = null;
    deps.keptStorage?.set(LYRICS_CACHE_KEY, JSON.stringify([...kept])).catch(() => {});
  };
  const persistKept = () => {
    keptTimer ??= setTimeout(persistKeptNow, LYRICS_PERSIST_MS);
  };

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persistNow = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    if (cache) deps.storage.set(LYRICS_CACHE_KEY, JSON.stringify(cache.pairs())).catch(() => {});
  };
  const persist = () => {
    persistTimer ??= setTimeout(persistNow, LYRICS_PERSIST_MS);
  };

  const client: LyricsClient = {
    peek(id) {
      return kept.get(id)?.l ?? cache?.get(id)?.l;
    },
    async dropMembersOnly() {
      drops++;
      const c = await ready();
      let changed = false;
      for (const [k, v] of c.pairs()) {
        if (v.m) {
          c.delete(k);
          changed = true;
        }
      }
      // Members-only lyrics leave the phone now, not a moment later (S8).
      if (changed) persistNow();
      // Nor are they looked up any more (a loop running goes on with the rest).
      for (const id of keepMembers) keepIds.delete(id);
      keepMembers = new Set();
      toLookUp = toLookUp.filter((t) => !t.membersOnly);
      let keptChanged = false;
      for (const [k, v] of kept) if (v.m) keptChanged = kept.delete(k) || keptChanged;
      if (keptChanged) persistKeptNow();
    },
    async keepSaved(saved, likedIds) {
      await ready();
      keepIds = new Set(saved.map((t) => t.id));
      keepMembers = new Set(saved.filter((t) => t.membersOnly).map((t) => t.id));
      let changed = false;
      // Unliked: no longer kept (an empty Liked is one not read, never a reason).
      if (likedIds.size) for (const k of kept.keys()) if (!likedIds.has(k)) changed = kept.delete(k) || changed;
      for (const t of saved) {
        if (kept.has(t.id)) continue;
        const e = cache?.get(t.id);
        if (e?.l.found) {
          kept.set(t.id, e);
          changed = true;
        }
      }
      if (changed) persistKept();
      // Those still unknown (not even "not found" lately): looked up one at a time.
      toLookUp = saved.filter((t) => !fresh(kept.get(t.id)) && !cache?.get(t.id));
      if (lookingUp) return;
      lookingUp = true;
      try {
        for (let t = toLookUp.shift(); t; t = toLookUp.shift()) {
          if (deps.isOffline?.() || !deps.plugin()) break;
          if (fresh(kept.get(t.id)) || cache?.get(t.id) || !keepIds.has(t.id)) continue;
          await client.get(t);
          await pause(KEEP_LOOKUP_GAP_MS);
        }
      } finally {
        lookingUp = false;
      }
    },
    async get(track, durationMs) {
      const c = await ready();
      // Kept, unless it was looked up without a length and now one can be matched online (or
      // it's a "not found" from over a week ago).
      const k = fresh(kept.get(track.id)) ? kept.get(track.id) : undefined;
      if (k && !(k.nd && durationMs && !deps.isOffline?.())) return { status: 'ok', lyrics: k.l };
      const hit = k ? undefined : c.touch(track.id);
      if (hit) return { status: 'ok', lyrics: hit.l };
      const pending = inflight.get(track.id);
      if (pending) return pending;
      const p = deps.plugin();
      if (!p) return { status: 'error', offline: false };
      const asked = drops;
      const req: Promise<LyricsOutcome> = inflight.track(
        track.id,
        chain
          .catch(() => {})
          .then(() =>
            p.lyrics({
              ytId: track.ytId,
              title: cleanTitle(track.title, track.artist),
              artist: cleanArtist(track.artist),
              ...(durationMs && durationMs > 0 && { durationSec: Math.round(durationMs / 1000) }),
            }),
          )
          .then((r): LyricsOutcome => {
            const lyrics = normalizeLyrics(r);
            // Signed out while it was looked up: members-only lyrics don't stay (S8).
            if (track.membersOnly && asked !== drops) return { status: 'ok', lyrics };
            const e: CacheEntry = { at: now(), l: lyrics, ...(track.membersOnly && { m: true as const }), ...(!durationMs && { nd: true as const }) };
            // A saved (or kept) song's goes to the kept file only, "not found" too (asked again in
            // a week), so it doesn't push recent lyrics out of the cache. Asked again with its
            // length and not found that way, the one kept stays, asked no more.
            if (k || keepIds.has(track.id)) {
              kept.set(track.id, lyrics.found || !k?.l.found ? e : { ...k, nd: undefined });
              persistKept();
              return { status: 'ok', lyrics: kept.get(track.id)!.l };
            }
            c.set(track.id, e, e.at);
            persist();
            return { status: 'ok', lyrics };
          })
          .catch((e): LyricsOutcome => {
            // Asking a kept one again failed: it still shows.
            if (k) return { status: 'ok', lyrics: k.l };
            const code = toMusicError(e).code;
            return { status: 'error', offline: code === 'NETWORK' || !!deps.isOffline?.() };
          }),
      );
      chain = req;
      return req;
    },
  };
  return client;
}

const cacheFile = textFile('cache', 'lyrics', { legacyKeys: [LYRICS_CACHE_KEY] });
const keptFile = textFile('data', 'lyrics-saved');

/** One cache file; the key is kept in the interface for tests. */
const fileStorage: LyricsStorage = {
  get: () => cacheFile.read(),
  set: (_key, value) => cacheFile.write(value),
};

/** The app's lyrics client. */
export const lyrics = createLyricsClient({
  plugin: appPlugin,
  storage: fileStorage,
  keptStorage: { get: () => keptFile.read(), set: (_key, value) => keptFile.write(value) },
  isOffline: () => !online.peek(),
});
