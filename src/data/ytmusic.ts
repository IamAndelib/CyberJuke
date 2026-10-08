/**
 * Global search: YouTube Music data from the native `JukeMusic` plugin (NewPipeExtractor).
 * The UI never names YouTube Music; it calls this "Global".
 *
 * - The plugin interface below is a contract with the native side; don't change it.
 * - Results are cached for 10 minutes (paging tokens live native-side, so `more`
 *   calls are cached by token too).
 * - In the browser (dev, e2e) there is no native plugin: every call rejects with code
 *   UNAVAILABLE unless a test stub is installed as `window.__cyberjukeMusicStub`.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { artworkUrl, type Track } from './model';
import { cleanCredit } from './artists';

// ---- Plugin contract (keep in sync with MusicPlugin.kt) ------------------------------

export interface MusicItem {
  kind: 'song' | 'album' | 'artist' | 'playlist';
  title: string;
  subtitle: string; // artist / uploader
  url: string;
  ytId?: string;
  durationSec?: number;
  thumbnailUrl?: string;
  itemCount?: number;
}
export interface MusicPage {
  items: MusicItem[];
  next?: string; // opaque token
}
export type MusicFilter = 'songs' | 'albums' | 'artists' | 'playlists';
export interface JukeMusicPlugin {
  search(o: { query: string; filter: MusicFilter }): Promise<MusicPage>;
  more(o: { next: string }): Promise<MusicPage>;
  playlist(o: { url: string }): Promise<{ title: string; subtitle: string; thumbnailUrl?: string } & MusicPage>; // albums too
}

export const JukeMusic = registerPlugin<JukeMusicPlugin>('JukeMusic');

declare global {
  interface Window {
    /** e2e only: a fake JukeMusic used in the browser build. */
    __cyberjukeMusicStub?: JukeMusicPlugin;
  }
}

// ---- Errors ---------------------------------------------------------------------------

export type MusicErrorCode = 'BOT_CHECK' | 'NETWORK' | 'UNAVAILABLE';
const CODES: readonly MusicErrorCode[] = ['BOT_CHECK', 'NETWORK', 'UNAVAILABLE'];

export class MusicError extends Error {
  constructor(
    readonly code: MusicErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'MusicError';
  }
}

/** Normalize any rejection (Capacitor error, stub error, string) to a MusicError. */
export function toMusicError(e: unknown): MusicError {
  if (e instanceof MusicError) return e;
  const raw = e as { code?: unknown; message?: unknown } | null;
  const message = typeof raw?.message === 'string' ? raw.message : String(e ?? '');
  const given = typeof raw?.code === 'string' ? CODES.find((c) => c === raw.code) : undefined;
  // Fall back to the "CODE: detail" message prefix the plugin uses.
  const code = given ?? CODES.find((c) => message.startsWith(c + ':')) ?? 'UNAVAILABLE';
  return new MusicError(code, message);
}

/** What the UI shows for a failed Global request. Never names the provider. */
export function musicErrorText(e: { code: MusicErrorCode } | null | undefined): string {
  if (e?.code === 'NETWORK') return "Couldn't reach Global search. Check your connection and try again.";
  return "Global search isn't available on this network right now, try again later";
}

/** An expired/unknown paging token is reported as UNAVAILABLE: treat it as the end of the list. */
export function isEndOfList(e: unknown): boolean {
  const m = toMusicError(e);
  return m.code === 'UNAVAILABLE' && /paging token|expired/i.test(m.message);
}

// ---- Mapping --------------------------------------------------------------------------

export const YTM_PREFIX = 'ytm:';
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function idFromUrl(url: string): string | undefined {
  try {
    const v = new URL(url).searchParams.get('v');
    return v && YT_ID.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A song item as a playable Track (id `ytm:<ytId>`, no genre, poster or post), or null
 * for anything that isn't a playable song. Artwork uses the video's hqdefault frame so
 * it gets the same crop and pixel treatment as Jukebox tracks.
 */
export function musicItemToTrack(item: MusicItem, fallbackArtist = ''): Track | null {
  if (item.kind !== 'song') return null;
  const ytId = item.ytId && YT_ID.test(item.ytId) ? item.ytId : idFromUrl(item.url);
  if (!ytId) return null;
  return {
    id: YTM_PREFIX + ytId,
    ytId,
    title: (item.title ?? '').trim() || 'Untitled',
    artist: cleanCredit(item.subtitle ?? '') || fallbackArtist || 'Unknown artist',
    genre: '',
    by: '',
    postTitle: '',
    postUrl: '',
    createdAt: '',
    nsfw: false,
    artworkUrl: artworkUrl(ytId),
    source: 'ytmusic',
  };
}

export function musicTracks(items: MusicItem[], fallbackArtist = ''): Track[] {
  const out: Track[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const t = musicItemToTrack(it, fallbackArtist);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

// ---- Client with a 10-minute cache ----------------------------------------------------

export const MUSIC_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

export type AlbumPage = { title: string; subtitle: string; thumbnailUrl?: string } & MusicPage;

export interface MusicClient {
  search(query: string, filter: MusicFilter): Promise<MusicPage>;
  more(next: string): Promise<MusicPage>;
  playlist(url: string): Promise<AlbumPage>;
  /** A cached, still-fresh search result, if any (lets screens render instantly on remount). */
  peekSearch(query: string, filter: MusicFilter): MusicPage | undefined;
  clear(): void;
}

export interface MusicClientDeps {
  /** The plugin to call, or null when there is none (web without a stub). */
  plugin: () => JukeMusicPlugin | null;
  now?: () => number;
  ttlMs?: number;
}

export function createMusicClient(deps: MusicClientDeps): MusicClient {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.ttlMs ?? MUSIC_CACHE_TTL_MS;
  const cache = new Map<string, { at: number; value: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();

  function fresh<T>(key: string): T | undefined {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (now() - hit.at >= ttl) {
      cache.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  function call<T>(key: string, run: (p: JukeMusicPlugin) => Promise<T>): Promise<T> {
    const hit = fresh<T>(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = deps.plugin();
    if (!p) return Promise.reject(new MusicError('UNAVAILABLE', 'UNAVAILABLE: Global search needs the Android app'));
    const req = Promise.resolve()
      .then(() => run(p))
      .then((value) => {
        cache.set(key, { at: now(), value });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
        return value;
      })
      .catch((e) => {
        throw toMusicError(e);
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, req);
    return req;
  }

  const sKey = (query: string, filter: MusicFilter) => `s|${filter}|${query.trim().toLowerCase()}`;

  return {
    search: (query, filter) => call(sKey(query, filter), (p) => p.search({ query: query.trim(), filter })),
    more: (next) => call(`m|${next}`, (p) => p.more({ next })),
    playlist: (url) => call(`p|${url}`, (p) => p.playlist({ url })),
    peekSearch: (query, filter) => fresh<MusicPage>(sKey(query, filter)),
    clear: () => cache.clear(),
  };
}

function appPlugin(): JukeMusicPlugin | null {
  if (typeof window !== 'undefined' && window.__cyberjukeMusicStub) return window.__cyberjukeMusicStub;
  return Capacitor.isNativePlatform() ? JukeMusic : null;
}

/** The app's Global search client. */
export const music = createMusicClient({ plugin: appPlugin });
