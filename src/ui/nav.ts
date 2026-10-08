/** App navigation state: which tab, sub-pages, and overlays are open. */
import { computed, signal, type ReadonlySignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { Track } from '../data/model';

export type Tab = 'home' | 'genres' | 'artists' | 'library' | 'settings';

export const tab = signal<Tab>('home');
/** Genre detail page open on top of the Genres tab, if any. */
export const openGenre = signal<string | null>(null);
/** Artist page open on top of the Artists tab, if any (a display name). */
export const openArtist = signal<string | null>(null);

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
/** Album/playlist page, shown over the current tab (and over search). */
export const openAlbum = signal<AlbumRef | null>(null);

/** "See all" of one discography shelf on an artist page. */
export interface ReleasesRef {
  artist: string;
  /** The artist's channel: a Retry reloads their page for fresh tokens. */
  channelId: string;
  kind: 'album' | 'ep' | 'single' | 'live';
  /** Opaque, and may expire native-side (then the grid offers Retry). */
  token: string;
}
/** The full-grid page of one shelf, over the artist page on the Artists tab. */
export const openReleases = signal<ReleasesRef | null>(null);

export const nowPlayingOpen = signal(false);
/** Search overlay (covers the tab content; mini player and tab bar stay visible). */
export const searchOpen = signal(false);
/** Track whose ⋯ menu is open. */
export const menuTrack = signal<Track | null>(null);
/** Artist chooser (a track credits several artists), opened from Now Playing. */
export const artistChoice = signal<string[] | null>(null);

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
}

/** Contexts of mounted screens, innermost (topmost) last. */
const contextStack = signal<SearchContext[]>([]);
/** Context of the topmost screen showing (set by `useSearchContext`), used by the search button. */
export const pageSearchContext = computed<SearchContext | null>(() => contextStack.value.at(-1) ?? null);
/** Context of the open Search (null: no Here scope). Set by `openSearch`. */
export const searchContext = signal<SearchContext | null>(null);
/** Search was opened over an album page, so it sits on top of it. */
export const searchOverAlbum = signal(false);
export type SearchMode = 'here' | 'jukebox' | 'global';
/** Search scope; set on every open (Here when there is a context, else Jukebox). */
export const searchMode = signal<SearchMode>('jukebox');

/**
 * Open Search. With a context, Search adds the Here scope and opens on it;
 * without one (Home, the Genres/Artists grids, Settings) it opens on Jukebox.
 */
export function openSearch(ctx: SearchContext | null = pageSearchContext.value): void {
  searchContext.value = ctx;
  searchMode.value = ctx ? 'here' : 'jukebox';
  searchOverAlbum.value = !!openAlbum.value;
  menuTrack.value = null;
  searchOpen.value = true;
}

/**
 * Register the screen's Here context while it is mounted: the search button then opens
 * Search scoped to it. Pass null when the screen has nothing to scope to (yet).
 * The latest `ctx` is used, so its getters may close over current render values, and
 * a signal or a getter reading signals keeps an open Search up to date as it grows.
 */
export function useSearchContext(ctx: SearchContext | null): void {
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
    };
    contextStack.value = [...contextStack.value, mine];
    return () => {
      contextStack.value = contextStack.value.filter((c) => c !== mine);
    };
  }, [label]);
}

function closeOverlays(): void {
  menuTrack.value = null;
  artistChoice.value = null;
  nowPlayingOpen.value = false;
  searchOpen.value = false;
  openAlbum.value = null;
}

/** Go to an artist page on the Artists tab, closing whatever is on top. */
export function openArtistPage(name: string): void {
  closeOverlays();
  tab.value = 'artists';
  openReleases.value = null;
  openArtist.value = name;
}

/** Go to a genre page on the Genres tab, closing whatever is on top. */
export function openGenrePage(name: string): void {
  closeOverlays();
  tab.value = 'genres';
  openGenre.value = name;
}

export function openAlbumPage(ref: AlbumRef): void {
  menuTrack.value = null;
  searchOverAlbum.value = false;
  nowPlayingOpen.value = false;
  openAlbum.value = ref;
}

/**
 * Close the topmost layer. With `switchTab` (Android back), a top-level tab other than
 * Home goes back to Home. Returns false when there is nothing left to close.
 */
export function goBack(switchTab = true): boolean {
  if (menuTrack.value) {
    menuTrack.value = null;
    return true;
  }
  if (artistChoice.value) {
    artistChoice.value = null;
    return true;
  }
  if (nowPlayingOpen.value) {
    nowPlayingOpen.value = false;
    return true;
  }
  if (searchOpen.value && searchOverAlbum.value) {
    searchOpen.value = false;
    searchOverAlbum.value = false;
    return true;
  }
  if (openAlbum.value) {
    openAlbum.value = null;
    return true;
  }
  if (searchOpen.value) {
    searchOpen.value = false;
    return true;
  }
  if (tab.value === 'genres' && openGenre.value) {
    openGenre.value = null;
    return true;
  }
  if (tab.value === 'artists' && openReleases.value) {
    openReleases.value = null;
    return true;
  }
  if (tab.value === 'artists' && openArtist.value) {
    openArtist.value = null;
    return true;
  }
  if (switchTab && tab.value !== 'home') {
    tab.value = 'home';
    return true;
  }
  return false;
}

export { openPost, openExternal } from './links';
