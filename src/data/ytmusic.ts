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
import { artistKey, cleanCredit, splitArtists } from './artists';
import { Cache } from '../core/cache';
import { TEST_HOOKS } from '../core/testHooks';
import { isObj, parseMusicItems, parseMusicPage } from '../core/guards';

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
  /** Songs and albums: the first credited artist's channel URL. */
  artistUrl?: string;
  /** Songs and albums: the first credited artist's channel id; artists: their own. */
  channelId?: string;
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
  /** Artist candidates for a name (kind 'artist', channelId set), best match first. */
  artist(o: { name: string }): Promise<{ items: MusicItem[] }>;
  lyrics(o: LyricsRequest): Promise<LyricsResult>;
  /** The artist's own page: top songs and every release shelf, exactly that artist's. */
  artistPage(o: { channelId: string }): Promise<ArtistPageResult>;
  /** A "See all" token from `artistPage().more`: the full list of that shelf. */
  artistReleases(o: { token: string }): Promise<{ releases: Release[] }>;
  /**
   * The song's radio (Global autoplay): songs without the seed; `next` gives the page
   * after. Rejects BOT_CHECK without a request during a YouTube back-off.
   */
  radio(o: { ytId: string; next?: string }): Promise<MusicPage>;
}

export type ReleaseKind = 'album' | 'ep' | 'single' | 'live';
export interface Release {
  kind: ReleaseKind;
  title: string;
  year?: string;
  url: string;
  thumbnailUrl?: string;
}
interface ArtistPageResult {
  name: string;
  thumbnailUrl?: string;
  topSongs: MusicItem[];
  /** "See all" songs: a playlist URL the existing playlist() reads. */
  topSongsPlaylistUrl?: string;
  releases: Release[];
  /** Opaque tokens for artistReleases(): albums (albums and live albums), singles (singles and EPs). */
  more?: { albums?: string; singles?: string };
}

interface LyricsRequest {
  ytId: string;
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
}
export interface LyricsResult {
  /** e.g. 'LRCLIB' or 'LyricFind'. */
  source?: string;
  /** Time-synced lines, t in ms. */
  synced?: { t: number; text: string }[];
  plain?: string;
  instrumental?: boolean;
  found: boolean;
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

const YTM_PREFIX = 'ytm:';
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

// ---- Exact artist identity (channel ids) ---------------------------------------------

const CHANNEL_ID = /\/channel\/(UC[A-Za-z0-9_-]{10,})/;

/** "UC…" from a channel URL, or undefined. */
export function channelIdFromUrl(url: string | undefined): string | undefined {
  return url ? CHANNEL_ID.exec(url)?.[1] : undefined;
}

/** The channel an item belongs to: an artist's own, or a song's/album's first credited artist. */
export function itemChannelId(item: MusicItem): string | undefined {
  if (item.channelId) return item.channelId;
  return channelIdFromUrl(item.artistUrl) ?? (item.kind === 'artist' ? channelIdFromUrl(item.url) : undefined);
}

/**
 * The channel of the artist named `name` among `candidates`: the first artist result
 * whose normalized name equals it (results are best-first), or null when none is
 * exact ("Ivy Queen" and "Queen Butterfly" are not "Queen").
 */
export function resolveArtistChannel(candidates: MusicItem[], name: string): string | null {
  const key = artistKey(name);
  if (!key) return null;
  for (const c of candidates) {
    if (c.kind !== 'artist') continue;
    const id = itemChannelId(c);
    if (id && artistKey(c.title) === key) return id;
  }
  return null;
}

/**
 * Whether an item is by the artist with channel `channelId`: its channel matches (the
 * first credited artist is this artist). Items without a channel link are kept only
 * when one of their split credits is exactly the artist's name, never a substring.
 */
export function isByArtist(item: MusicItem, channelId: string, name: string, credit = item.subtitle): boolean {
  const id = itemChannelId(item);
  if (id) return id === channelId;
  const key = artistKey(name);
  return !!key && splitArtists(cleanCredit(credit ?? '')).some((a) => artistKey(a) === key);
}

// ---- Discography shelves --------------------------------------------------------------

/** Shelves on the artist page, in order. */
export const SHELF_ORDER: readonly ReleaseKind[] = ['album', 'live', 'ep', 'single'];
export const SHELF_LABEL: Record<ReleaseKind, string> = { album: 'Albums', live: 'Live albums', ep: 'EPs', single: 'Singles' };
/** What one release is called (the album page's subtitle). */
export const RELEASE_LABEL: Record<ReleaseKind, string> = { album: 'Album', live: 'Live album', ep: 'EP', single: 'Single' };

/** Titles that make an album a live album (same rule as the native side). */
const LIVE_TITLE = /\blive\b|unplugged|in concert|live at|live from/i;

/**
 * The shelf a release goes on. The native side classifies already; this keeps the
 * same rule on the phone too (an album or EP whose title says it's live is a live
 * album; a live single stays a single) and puts unknown kinds on Albums.
 */
export function releaseShelf(r: Pick<Release, 'kind' | 'title'>): ReleaseKind {
  const kind = SHELF_ORDER.includes(r.kind) ? r.kind : 'album';
  if ((kind === 'album' || kind === 'ep') && LIVE_TITLE.test(r.title ?? '')) return 'live';
  return kind;
}

/** Releases by shelf, each once (by URL), in the order given. */
export function groupReleases(releases: Release[]): Record<ReleaseKind, Release[]> {
  const out: Record<ReleaseKind, Release[]> = { album: [], live: [], ep: [], single: [] };
  const seen = new Set<string>();
  for (const r of releases ?? []) {
    if (!r?.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out[releaseShelf(r)].push(r);
  }
  return out;
}

/** The "See all" token behind a shelf: Albums and Live albums share one, EPs and Singles the other. */
export function shelfToken(kind: ReleaseKind, more: ArtistPageResult['more']): string | undefined {
  return kind === 'album' || kind === 'live' ? more?.albums : more?.singles;
}

// ---- Client with a 10-minute cache ----------------------------------------------------

export const MUSIC_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

export type AlbumPage = { title: string; subtitle: string; thumbnailUrl?: string } & MusicPage;

export interface MusicClient {
  search(query: string, filter: MusicFilter): Promise<MusicPage>;
  more(next: string): Promise<MusicPage>;
  playlist(url: string): Promise<AlbumPage>;
  /** Artist candidates for a name. */
  artist(name: string): Promise<MusicItem[]>;
  /** `fresh`: skip the cache (a "See all" token was evicted native-side; get new ones). */
  artistPage(channelId: string, fresh?: boolean): Promise<ArtistPageResult>;
  artistReleases(token: string): Promise<Release[]>;
  /** One page of a song's radio (not cached: each page is asked for once). */
  radio(ytId: string, next?: string): Promise<MusicPage>;
  /** A cached, still-fresh search result, if any (lets screens render instantly on remount). */
  peekSearch(query: string, filter: MusicFilter): MusicPage | undefined;
  clear(): void;
}

interface MusicClientDeps {
  /** The plugin to call, or null when there is none (web without a stub). */
  plugin: () => JukeMusicPlugin | null;
  now?: () => number;
  ttlMs?: number;
}

export function createMusicClient(deps: MusicClientDeps): MusicClient {
  // Oldest stored first past CACHE_MAX; a stale entry is dropped when found.
  const cache = new Cache<string, unknown>({ ttlMs: deps.ttlMs ?? MUSIC_CACHE_TTL_MS, max: CACHE_MAX, dropStale: true, now: deps.now });

  function call<T>(key: string, run: (p: JukeMusicPlugin) => Promise<T>): Promise<T> {
    const start = () => {
      const p = deps.plugin();
      if (!p) throw new MusicError('UNAVAILABLE', 'UNAVAILABLE: Global search needs the Android app');
      return Promise.resolve().then(() => run(p));
    };
    return cache.load(key, start, { mapError: toMusicError }) as Promise<T>;
  }

  const sKey = (query: string, filter: MusicFilter) => `s|${filter}|${query.trim().toLowerCase()}`;

  // Everything the plugin returns is checked at the bridge (core/guards).
  return {
    search: (query, filter) => call(sKey(query, filter), (p) => p.search({ query: query.trim(), filter }).then(parseMusicPage)),
    more: (next) => call(`m|${next}`, (p) => p.more({ next }).then(parseMusicPage)),
    playlist: (url) => call(`p|${url}`, (p) => p.playlist({ url }).then(parseAlbumPage)),
    artist: (name) => call(`a|${artistKey(name)}`, (p) => p.artist({ name: name.trim() }).then((r) => parseMusicItems((r as { items?: unknown } | null)?.items))),
    artistPage: (channelId, fresh) =>
      (fresh && cache.delete(`ap|${channelId}`), call(`ap|${channelId}`, (p) => p.artistPage({ channelId }).then(parseArtistPage))),
    artistReleases: (token) => call(`ar|${token}`, (p) => p.artistReleases({ token }).then((r) => parseReleases((r as { releases?: unknown } | null)?.releases))),
    radio: (ytId, next) => {
      const p = deps.plugin();
      if (!p) return Promise.reject(new MusicError('UNAVAILABLE', 'UNAVAILABLE: Global search needs the Android app'));
      return Promise.resolve()
        .then(() => p.radio(next ? { ytId, next } : { ytId }))
        .then(parseMusicPage)
        .catch((e) => {
          throw toMusicError(e);
        });
    },
    peekSearch: (query, filter) => cache.get(sKey(query, filter)) as MusicPage | undefined,
    clear: () => cache.clear(),
  };
}

const KINDS: readonly ReleaseKind[] = ['album', 'ep', 'single', 'live'];

/** Releases from the plugin: a kind, a title and a URL each, or dropped. */
function parseReleases(x: unknown): Release[] {
  if (!Array.isArray(x)) return [];
  const out: Release[] = [];
  for (const r of x) {
    if (!isObj(r) || typeof r.url !== 'string' || !r.url || typeof r.title !== 'string') continue;
    out.push({
      kind: KINDS.includes(r.kind as ReleaseKind) ? (r.kind as ReleaseKind) : 'album',
      title: r.title,
      url: r.url,
      ...(typeof r.year === 'string' && r.year && { year: r.year }),
      ...(typeof r.thumbnailUrl === 'string' && /^https:\/\//.test(r.thumbnailUrl) && { thumbnailUrl: r.thumbnailUrl }),
    });
  }
  return out;
}

function parseAlbumPage(x: unknown): AlbumPage {
  const o = isObj(x) ? x : {};
  return {
    ...parseMusicPage(o),
    title: typeof o.title === 'string' ? o.title : '',
    subtitle: typeof o.subtitle === 'string' ? o.subtitle : '',
    ...(typeof o.thumbnailUrl === 'string' && /^https:\/\//.test(o.thumbnailUrl) && { thumbnailUrl: o.thumbnailUrl }),
  };
}

function parseArtistPage(x: unknown): ArtistPageResult {
  const o = isObj(x) ? x : {};
  const more = isObj(o.more) ? o.more : {};
  return {
    name: typeof o.name === 'string' ? o.name : '',
    ...(typeof o.thumbnailUrl === 'string' && /^https:\/\//.test(o.thumbnailUrl) && { thumbnailUrl: o.thumbnailUrl }),
    topSongs: parseMusicItems(o.topSongs),
    ...(typeof o.topSongsPlaylistUrl === 'string' && o.topSongsPlaylistUrl && { topSongsPlaylistUrl: o.topSongsPlaylistUrl }),
    releases: parseReleases(o.releases),
    more: {
      ...(typeof more.albums === 'string' && more.albums && { albums: more.albums }),
      ...(typeof more.singles === 'string' && more.singles && { singles: more.singles }),
    },
  };
}

export function appPlugin(): JukeMusicPlugin | null {
  // e2e: the fake plugin (dev and test builds only).
  if (TEST_HOOKS && typeof window !== 'undefined' && window.__cyberjukeMusicStub) return window.__cyberjukeMusicStub;
  return Capacitor.isNativePlatform() ? JukeMusic : null;
}

/** The app's Global search client. */
export const music = createMusicClient({ plugin: appPlugin });
