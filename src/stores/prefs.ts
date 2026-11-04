/** Small UI preferences (sort orders, Library's layout), persisted in Preferences (core/storage kv). */
import { signal, type Signal } from '@preact/signals';
import { kv } from '../core/storage';

export type GridSort = 'popular' | 'az';
const GRID_SORTS: readonly GridSort[] = ['popular', 'az'];

const K_GENRES_SORT = 'prefs.genresSort';
const K_ARTISTS_SORT = 'prefs.artistsSort';

/** Genres grid order. */
export const genresSort = signal<GridSort>('popular');
/** Artists grid order. */
export const artistsSort = signal<GridSort>('popular');

/** Library → Local's order in each view: A–Z, the newest files, or the most songs. */
export type LocalSongsOrder = 'az' | 'newest';
export type LocalGroupsOrder = 'az' | 'songs';
export const localSongsOrder = signal<LocalSongsOrder>('az');
export const localAlbumsOrder = signal<LocalGroupsOrder>('az');
export const localArtistsOrder = signal<LocalGroupsOrder>('az');
/** Liked's order: the newest likes first (as kept) or A–Z. */
export const likedOrder = signal<LocalSongsOrder>('newest');

export type LibraryLayout = 'list' | 'grid';
/** Library's lists and playlists as rows or as tiles. */
export const libraryLayout = signal<LibraryLayout>('list');

function bind<T extends string>(sig: Signal<T>, key: string, allowed: readonly T[]): void {
  let first = true;
  let applying = false;
  sig.subscribe((v) => {
    if (first || applying) {
      first = false;
      return;
    }
    kv.set(key, v).catch(() => {});
  });
  // A choice made before loading finished wins over the stored one.
  const before = sig.value;
  kv.get(key)
    .then((value) => {
      if (sig.value !== before || !value || !(allowed as readonly string[]).includes(value)) return;
      applying = true;
      sig.value = value as T;
      applying = false;
    })
    .catch(() => {});
}

bind(genresSort, K_GENRES_SORT, GRID_SORTS);
bind(artistsSort, K_ARTISTS_SORT, GRID_SORTS);
bind(libraryLayout, 'prefs.libraryLayout', ['list', 'grid']);
bind(localSongsOrder, 'prefs.localSongsOrder', ['az', 'newest']);
bind(localAlbumsOrder, 'prefs.localAlbumsOrder', ['az', 'songs']);
bind(localArtistsOrder, 'prefs.localArtistsOrder', ['az', 'songs']);
bind(likedOrder, 'prefs.likedOrder', ['newest', 'az']);
