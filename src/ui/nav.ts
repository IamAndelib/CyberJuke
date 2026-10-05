/** App navigation state: which tab, sub-pages, and overlays are open. */
import { signal } from '@preact/signals';
import type { Track } from '../data/model';

export type Tab = 'home' | 'genres' | 'library' | 'settings';

export const tab = signal<Tab>('home');
/** Genre detail page open on top of the Genres tab, if any. */
export const openGenre = signal<string | null>(null);
export const nowPlayingOpen = signal(false);
/** Track whose ⋯ menu is open. */
export const menuTrack = signal<Track | null>(null);

/** Handle a back gesture. Returns false when there is nothing left to close. */
export function goBack(): boolean {
  if (menuTrack.value) {
    menuTrack.value = null;
    return true;
  }
  if (nowPlayingOpen.value) {
    nowPlayingOpen.value = false;
    return true;
  }
  if (tab.value === 'genres' && openGenre.value) {
    openGenre.value = null;
    return true;
  }
  if (tab.value !== 'home') {
    tab.value = 'home';
    return true;
  }
  return false;
}

export function openPost(url: string): void {
  if (url) window.open(url, '_blank', 'noopener');
}
