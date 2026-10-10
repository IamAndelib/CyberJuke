/**
 * Genres for the grid and chips: every genre in the catalog, most-used first.
 * Until the catalog has loaded, falls back to genres seen in pages loaded so far.
 * Counts are only used for ordering; they are never shown.
 */
import { computed, signal } from '@preact/signals';
import type { Track } from '../data/model';
import { catalog, genreCounts } from './catalog';
import type { GenreCount } from '../data/search';
import { favoriteGenres } from './library';

const seen = new Map<string, Track>();
const seenVersion = signal(0);

export function recordTracks(tracks: Track[]): void {
  let changed = false;
  for (const t of tracks) {
    if (!t.genre || seen.has(t.id)) continue;
    seen.set(t.id, t);
    changed = true;
  }
  if (changed) seenVersion.value++;
}


/** True once the list comes from the full catalog rather than the seen-so-far pages. */
export const genresComplete = computed(() => catalog.tracks.value.length > 0);

export const genres = computed<GenreCount[]>(() => {
  const all = catalog.tracks.value;
  if (all.length) return genreCounts(all);
  void seenVersion.value;
  return genreCounts([...seen.values()]);
});

/** Genres for Home's chips: favorites first (in the order added), then the most used. */
export function chipGenres(max: number): string[] {
  const favs = favoriteGenres.value;
  const rest = genres.value.map((g) => g.name).filter((n) => !favs.includes(n));
  return [...favs, ...rest.slice(0, Math.max(0, max - favs.length))];
}

/** Catalog tracks of one genre (NSFW setting applied), recomputed only when the catalog changes. */
let genreMemo: { src: Track[]; genre: string; out: Track[] } | null = null;
export function catalogGenre(genre: string): Track[] {
  const src = catalog.tracks.value;
  if (genreMemo?.src !== src || genreMemo.genre !== genre) {
    genreMemo = { src, genre, out: src.filter((t) => t.genre === genre) };
  }
  return genreMemo.out;
}
