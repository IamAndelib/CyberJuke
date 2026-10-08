/** App navigation state: which tab, sub-pages, and overlays are open. */
import { signal } from '@preact/signals';
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
}
/** Album/playlist page, shown over the current tab (and over search). */
export const openAlbum = signal<AlbumRef | null>(null);

export const nowPlayingOpen = signal(false);
/** Search overlay (covers the tab content; mini player and tab bar stay visible). */
export const searchOpen = signal(false);
/** Track whose ⋯ menu is open. */
export const menuTrack = signal<Track | null>(null);
/** Artist chooser (a track credits several artists), opened from Now Playing. */
export const artistChoice = signal<string[] | null>(null);

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

export function openPost(url: string): void {
  if (url) window.open(url, '_blank', 'noopener');
}
