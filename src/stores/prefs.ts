/** Small UI preferences (sort orders), persisted with Capacitor Preferences. */
import { signal, type Signal } from '@preact/signals';
import { Preferences } from '@capacitor/preferences';

export type GridSort = 'popular' | 'az';
export const GRID_SORTS: readonly GridSort[] = ['popular', 'az'];

const K_GENRES_SORT = 'prefs.genresSort';
const K_ARTISTS_SORT = 'prefs.artistsSort';

/** Genres grid order. */
export const genresSort = signal<GridSort>('popular');
/** Artists grid order. */
export const artistsSort = signal<GridSort>('popular');

function bind<T extends string>(sig: Signal<T>, key: string, allowed: readonly T[]): void {
  let first = true;
  let applying = false;
  sig.subscribe((v) => {
    if (first || applying) {
      first = false;
      return;
    }
    Preferences.set({ key, value: v }).catch(() => {});
  });
  // A choice made before loading finished wins over the stored one.
  const before = sig.value;
  Preferences.get({ key })
    .then(({ value }) => {
      if (sig.value !== before || !value || !(allowed as readonly string[]).includes(value)) return;
      applying = true;
      sig.value = value as T;
      applying = false;
    })
    .catch(() => {});
}

bind(genresSort, K_GENRES_SORT, GRID_SORTS);
bind(artistsSort, K_ARTISTS_SORT, GRID_SORTS);
