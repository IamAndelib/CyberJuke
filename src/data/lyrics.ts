/**
 * Lyrics for Now Playing. The lookup runs natively (JukeMusic.lyrics: LRCLIB first,
 * then the licensed LyricFind lyrics as a fallback), so the WebView never hits CORS.
 * This module cleans the lookup metadata, normalizes and caches results, and holds the
 * pure helpers the panel uses (LRC parsing, current line).
 *
 * Cache: an LRU of LYRICS_CACHE_MAX results in Preferences; "not found" is cached too,
 * for NOT_FOUND_TTL_MS, so a song without lyrics isn't looked up on every play.
 * Failures (offline, plugin unavailable) are never cached.
 */
import { cleanCredit, splitArtists } from './artists';
import type { Track } from './model';
import { appPlugin, toMusicError, type JukeMusicPlugin, type LyricsResult } from './ytmusic';

export interface LyricLine {
  /** ms from the start of the track. */
  t: number;
  text: string;
}

export interface Lyrics {
  found: boolean;
  source?: string;
  synced?: LyricLine[];
  plain?: string;
  instrumental?: boolean;
}

export const LYRICS_CACHE_MAX = 300;
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
export function looksLikeLrc(text: string): boolean {
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

export interface LyricsStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface CacheEntry {
  at: number;
  l: Lyrics;
}

export const LYRICS_CACHE_KEY = 'lyrics.v1';

export type LyricsOutcome = { status: 'ok'; lyrics: Lyrics } | { status: 'error'; offline: boolean };

export interface LyricsClient {
  get(track: Track, durationMs?: number): Promise<LyricsOutcome>;
  /** A cached result, if any (no request). */
  peek(trackId: string): Lyrics | undefined;
}

export interface LyricsDeps {
  plugin: () => Pick<JukeMusicPlugin, 'lyrics'> | null;
  storage: LyricsStorage;
  now?: () => number;
  max?: number;
  isOffline?: () => boolean;
}

export function createLyricsClient(deps: LyricsDeps): LyricsClient {
  const now = deps.now ?? (() => Date.now());
  const max = deps.max ?? LYRICS_CACHE_MAX;
  /** Insertion order = recency (oldest first). */
  let map: Map<string, CacheEntry> | null = null;
  let loading: Promise<Map<string, CacheEntry>> | null = null;
  const inflight = new Map<string, Promise<LyricsOutcome>>();
  // Requests go one at a time (LRCLIB rate-limits).
  let chain: Promise<unknown> = Promise.resolve();

  const ready = () =>
    map
      ? Promise.resolve(map)
      : (loading ??= deps.storage
          .get(LYRICS_CACHE_KEY)
          .catch(() => null)
          .then((raw) => {
            const m = new Map<string, CacheEntry>();
            try {
              const o = raw ? (JSON.parse(raw) as [string, CacheEntry][]) : [];
              if (Array.isArray(o)) for (const [k, v] of o) if (v && typeof v.at === 'number' && v.l) m.set(k, v);
            } catch {
              /* corrupt cache: start over */
            }
            return (map = m);
          }));

  const persist = () => {
    if (map) deps.storage.set(LYRICS_CACHE_KEY, JSON.stringify([...map])).catch(() => {});
  };

  const fresh = (e: CacheEntry | undefined) => !!e && (e.l.found || now() - e.at < NOT_FOUND_TTL_MS);

  function touch(id: string, e: CacheEntry): void {
    map!.delete(id);
    map!.set(id, e);
    while (map!.size > max) map!.delete(map!.keys().next().value!);
  }

  return {
    peek(id) {
      const e = map?.get(id);
      return fresh(e) ? e!.l : undefined;
    },
    async get(track, durationMs) {
      const m = await ready();
      const hit = m.get(track.id);
      if (fresh(hit)) {
        touch(track.id, hit!);
        return { status: 'ok', lyrics: hit!.l };
      }
      const pending = inflight.get(track.id);
      if (pending) return pending;
      const p = deps.plugin();
      if (!p) return { status: 'error', offline: false };
      const req: Promise<LyricsOutcome> = chain
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
          touch(track.id, { at: now(), l: lyrics });
          persist();
          return { status: 'ok', lyrics };
        })
        .catch((e): LyricsOutcome => {
          const code = toMusicError(e).code;
          return { status: 'error', offline: code === 'NETWORK' || !!deps.isOffline?.() };
        })
        .finally(() => inflight.delete(track.id));
      chain = req;
      inflight.set(track.id, req);
      return req;
    },
  };
}

const prefsStorage: LyricsStorage = {
  get: async (key) => {
    const { Preferences } = await import('@capacitor/preferences');
    return (await Preferences.get({ key })).value;
  },
  set: async (key, value) => {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key, value });
  },
};

/** The app's lyrics client. */
export const lyrics = createLyricsClient({
  plugin: appPlugin,
  storage: prefsStorage,
  isOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
});
