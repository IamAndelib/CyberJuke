/**
 * App navigation: which tab is showing, each tab's own stack of pages, and the overlays
 * (Now Playing, the ⋯ menu, the artist chooser, confirm sheets).
 *
 * Every tab has a root screen (Home, the Genres and Artists grids, Library, Settings)
 * and a stack of pages pushed on top of it: artist, genre, album, "See all" and Search.
 * A page opens in place on the current tab, from anywhere (Home, Search, Now Playing,
 * another artist), and Back pops it, returning exactly where you were. Visited tabs
 * stay mounted (App), so their scroll and artwork survive a tab switch.
 */
import { computed, effect, signal, untracked, useComputed, type ReadonlySignal } from '@preact/signals';
import { createContext } from 'preact';
import { useContext, useEffect, useRef } from 'preact/hooks';
import type { Track } from '../data/model';

export type Tab = 'home' | 'genres' | 'artists' | 'library' | 'settings';
const TABS: readonly Tab[] = ['home', 'genres', 'artists', 'library', 'settings'];

/** An album or playlist from Global search. What we know before it loads is shown at once. */
export interface AlbumRef {
  url: string;
  title: string;
  subtitle: string;
  thumbnailUrl?: string;
  kind: 'album' | 'playlist';
  /** What to call it instead of "Album" (Single, EP, Live album). */
  label?: string;
}

/** "See all" of one discography shelf on an artist page. */
export interface ReleasesRef {
  artist: string;
  /** The artist's channel: a Retry reloads their page for fresh tokens. */
  channelId: string;
  kind: 'album' | 'ep' | 'single' | 'live';
  /** Opaque, and may expire native-side (then the grid offers Retry). */
  token: string;
}

/** A page pushed onto a tab's stack. */
export type Page =
  | { kind: 'genre'; name: string }
  | { kind: 'artist'; name: string }
  | { kind: 'album'; album: AlbumRef }
  | { kind: 'releases'; release: ReleasesRef }
  | { kind: 'search' };

export interface StackEntry {
  /** Unique for the app session (the page's key). */
  id: number;
  page: Page;
  /** performance.now() when it was pushed. */
  openedAt: number;
  /** Where the tap that opened it went down (for the double-tap guard), if it was a tap. */
  tap: { x: number; y: number } | null;
}

const EMPTY_STACKS: Record<Tab, StackEntry[]> = { home: [], genres: [], artists: [], library: [], settings: [] };

export const tab = signal<Tab>('home');
/** Each tab's pages above its root, bottom first. */
export const stacks = signal<Record<Tab, StackEntry[]>>(EMPTY_STACKS);
/** The current tab's pages. */
export const stack = computed(() => stacks.value[tab.value]);
/** The page showing on the current tab (null: its root). */
export const topEntry = computed<StackEntry | null>(() => stack.value.at(-1) ?? null);

export const nowPlayingOpen = signal(false);
/** Lyrics shown instead of the art (kept across tracks and reopenings). */
export const lyricsOpen = signal(false);
/** Track whose ⋯ menu is open. */
export const menuTrack = signal<Track | null>(null);
/** Artist chooser (a track credits several artists), opened from Now Playing. */
export const artistChoice = signal<string[] | null>(null);

/** A question in a confirm sheet (M3): Clear history, Sign out. */
export interface ConfirmRequest {
  title: string;
  body?: string;
  /** The confirming button's label, e.g. "Clear 12 plays". */
  confirm: string;
  run: () => void | Promise<void>;
  testid?: string;
}
export const confirmRequest = signal<ConfirmRequest | null>(null);

/**
 * The media notification was tapped: Now Playing, over whatever was open (menus and sheets
 * close). At a cold start the player's state comes a moment after the page, so it opens once
 * there is a track, if one comes within [waitMs].
 */
export function openNowPlayingWhen(hasTrack: ReadonlySignal<boolean>, waitMs = 5000): void {
  const open = () => {
    menuTrack.value = null;
    artistChoice.value = null;
    confirmRequest.value = null;
    nowPlayingOpen.value = true;
  };
  if (hasTrack.peek()) {
    open();
    return;
  }
  let dispose = () => {};
  const timer = setTimeout(() => dispose(), waitMs);
  dispose = effect(() => {
    if (!hasTrack.value) return;
    clearTimeout(timer);
    untracked(open);
    queueMicrotask(() => dispose());
  });
}

/** Ask before doing something that can't easily be taken back. */
export function askConfirm(req: ConfirmRequest): void {
  menuTrack.value = null;
  confirmRequest.value = req;
}

// ---- Taps --------------------------------------------------------------------------

/** M9: taps on a just-opened page are ignored this long when they land where the opening tap did. */
const OPEN_GUARD_MS = 300;
/** How close (px) a tap must be to the opening tap to count as its double. */
const OPEN_GUARD_PX = 48;

let lastDown: { x: number; y: number; t: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    },
    { capture: true, passive: true },
  );
}

/**
 * The second half of a double tap on a tile must not hit what the new page shows in
 * the same spot (Play). True for a click within OPEN_GUARD_MS of `entry` opening, near
 * the tap that opened it. Keyboard clicks (detail 0) always go through.
 */
export function isOpeningDoubleTap(entry: StackEntry, e: MouseEvent, now = performance.now()): boolean {
  if (!entry.tap || e.detail === 0 || now - entry.openedAt >= OPEN_GUARD_MS) return false;
  return Math.hypot(e.clientX - entry.tap.x, e.clientY - entry.tap.y) < OPEN_GUARD_PX;
}

// ---- Stacks ------------------------------------------------------------------------

let nextEntryId = 1;

function setStack(t: Tab, entries: StackEntry[]): void {
  stacks.value = { ...stacks.value, [t]: entries };
}

function samePage(a: Page, b: Page): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'genre':
    case 'artist':
      return a.name === (b as typeof a).name;
    case 'album':
      return a.album.url === (b as typeof a).album.url;
    case 'releases': {
      const r = (b as typeof a).release;
      return a.release.token === r.token && a.release.kind === r.kind;
    }
    case 'search':
      return true;
  }
}

function closeOverlays(): void {
  menuTrack.value = null;
  artistChoice.value = null;
  confirmRequest.value = null;
  nowPlayingOpen.value = false;
}

/** Open a page on top of the current tab (closing Now Playing and menus first). */
function pushPage(page: Page): void {
  closeOverlays();
  const t = tab.value;
  let cur = stacks.value[t];
  const top = cur.at(-1);
  if (top && samePage(top.page, page)) return;
  const now = performance.now();
  const tap = lastDown && now - lastDown.t < 1000 ? { x: lastDown.x, y: lastDown.y } : null;
  if (page.kind === 'search') {
    // One Search at a time: a Search lower down (or on another tab) gives way.
    let next = stacks.value;
    for (const k of TABS) {
      if (next[k].some((e) => e.page.kind === 'search')) next = { ...next, [k]: next[k].filter((e) => e.page.kind !== 'search') };
    }
    stacks.value = next;
    cur = next[t];
  }
  setStack(t, [...cur, { id: nextEntryId++, page, openedAt: now, tap }]);
}

/** Close the page on top of the current tab. Returns false at the tab's root. */
export function popPage(): boolean {
  const cur = stack.value;
  if (!cur.length) return false;
  setStack(tab.value, cur.slice(0, -1));
  return true;
}

/** Back to the tab's root screen. */
export function popToRoot(t: Tab = tab.value): void {
  if (stacks.value[t].length) setStack(t, []);
}

/** Switch tab; that tab's pages stay as they were. */
export function selectTab(t: Tab): void {
  tab.value = t;
}

/** Artist page on the current tab. */
export function openArtistPage(name: string): void {
  pushPage({ kind: 'artist', name });
}

/** Genre page on the current tab. */
export function openGenrePage(name: string): void {
  pushPage({ kind: 'genre', name });
}

/** Album or playlist page on the current tab. */
export function openAlbumPage(album: AlbumRef): void {
  pushPage({ kind: 'album', album });
}

/** "See all" grid of one shelf, over the artist page. */
export function openReleasesPage(release: ReleasesRef): void {
  pushPage({ kind: 'releases', release });
}

// ---- Search ------------------------------------------------------------------------

/** A value Search reads while it renders: a signal, or a getter (that may read signals). */
export type Source<T> = ReadonlySignal<T> | (() => T);

/** The current value of a Source; read during render, so the reader re-renders when it changes. */
export function read<T>(src: Source<T>): T {
  return typeof src === 'function' ? src() : src.value;
}

/**
 * "Here" scope for Search: the place Search was opened from (a genre, an artist, an
 * album, Liked, Recently played). `tracks` is read whenever Search renders, so it may
 * grow while Search is open (an artist's full song list arriving page by page).
 */
export interface SearchContext {
  /** Shown as "Search in <label>". */
  label: string;
  tracks: Source<Track[]>;
  /** Called when Search shows Here: start loading the rest (e.g. an artist's song list). */
  load?: () => void;
  /** More tracks are still on the way ("Searching all songs…"). */
  loading?: Source<boolean>;
  /** Releases whose titles Here also matches, shown as a cover row above the tracks. */
  albums?: Source<AlbumRef[]>;
  /**
   * Genres or artists to find by name (the Genres and Artists tabs): Here then lists
   * these instead of tracks, and a tap opens the genre or artist page.
   */
  places?: Source<Place[]>;
}

/** A genre or an artist that Here can find by name. */
export interface Place {
  name: string;
  kind: 'genre' | 'artist';
  /** Tracks in it, shown for genres. */
  count?: number;
}

/** Which mounted page a component belongs to (`<tab>:root` or `<tab>:<entry id>`); set by App. */
export const PageKey = createContext<string>('');

export function pageKey(t: Tab, entry: StackEntry | null): string {
  return `${t}:${entry ? entry.id : 'root'}`;
}

/** Key of the page showing now. */
const activePageKey = computed(() => pageKey(tab.value, topEntry.value));

/** Whether the page this component sits in is the one showing (re-renders only when that flips). */
export function usePageActive(): boolean {
  const key = useContext(PageKey);
  return useComputed(() => !key || activePageKey.value === key).value;
}

/** Here contexts of mounted pages, by page key. */
const contexts = signal<Record<string, SearchContext>>({});
/** Context of the page showing (set by `useSearchContext`), used by the search button. */
export const pageSearchContext = computed<SearchContext | null>(() => contexts.value[activePageKey.value] ?? null);
/** Context of the open Search (null: no Here scope). Set by `openSearch`. */
export const searchContext = signal<SearchContext | null>(null);
export type SearchMode = 'here' | 'jukebox' | 'global';
/** Search scope; set on every open (Here when there is a context, else Jukebox). */
export const searchMode = signal<SearchMode>('jukebox');

/** What's typed in Search; kept so reopening Search shows (and selects) the last query. */
export const searchQuery = signal('');
/** The last Here scope Search was opened on. */
let lastHereLabel: string | null = null;

/**
 * Open Search on top of the current page. With a context, Search adds the Here scope
 * and opens on it; without one (Home, the Genres/Artists grids, Settings) it opens on
 * Jukebox. P9: the last query comes back (selected, so typing replaces it), except
 * that a Here scope other than the last one starts empty.
 */
export function openSearch(ctx: SearchContext | null = pageSearchContext.value): void {
  if (ctx && ctx.label !== lastHereLabel) searchQuery.value = '';
  if (ctx) lastHereLabel = ctx.label;
  searchContext.value = ctx;
  searchMode.value = ctx ? 'here' : 'jukebox';
  pushPage({ kind: 'search' });
}

/**
 * Register the screen's Here context while it is mounted: the search button then opens
 * Search scoped to it. Pass null when the screen has nothing to scope to (yet).
 * The latest `ctx` is used, so its getters may close over current render values, and
 * a signal or a getter reading signals keeps an open Search up to date as it grows.
 */
export function useSearchContext(ctx: SearchContext | null): void {
  const key = useContext(PageKey);
  const latest = useRef(ctx);
  latest.current = ctx;
  const label = ctx?.label ?? null;
  useEffect(() => {
    if (label == null) return;
    const mine: SearchContext = {
      label,
      tracks: () => (latest.current ? read(latest.current.tracks) : []),
      load: () => latest.current?.load?.(),
      loading: () => (latest.current?.loading ? read(latest.current.loading) : false),
      albums: () => (latest.current?.albums ? read(latest.current.albums) : []),
      ...(latest.current?.places ? { places: () => (latest.current?.places ? read(latest.current.places) : []) } : {}),
    };
    contexts.value = { ...contexts.value, [key]: mine };
    return () => {
      if (contexts.value[key] !== mine) return;
      const next = { ...contexts.value };
      delete next[key];
      contexts.value = next;
    };
  }, [label, key]);
}

// ---- Back --------------------------------------------------------------------------

/**
 * Close the topmost thing: a sheet, then lyrics, then Now Playing, then the page on top
 * of the current tab. With `switchTab` (Android back), a tab's root other than Home
 * goes back to Home. Returns false when there is nothing left to close.
 */
export function goBack(switchTab = true): boolean {
  if (confirmRequest.value) {
    confirmRequest.value = null;
    return true;
  }
  if (menuTrack.value) {
    menuTrack.value = null;
    return true;
  }
  if (artistChoice.value) {
    artistChoice.value = null;
    return true;
  }
  if (nowPlayingOpen.value) {
    if (lyricsOpen.value) lyricsOpen.value = false;
    else nowPlayingOpen.value = false;
    return true;
  }
  if (popPage()) return true;
  if (switchTab && tab.value !== 'home') {
    tab.value = 'home';
    return true;
  }
  return false;
}
