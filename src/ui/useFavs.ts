import { computed, type ReadonlySignal } from '@preact/signals';
import { useMemo } from 'preact/hooks';
import { artistKey } from '../data/artists';
import { favArtistKeys, favGenreSet, likedIds } from '../stores/library';

// One item's star or heart. Each reads its own computed, so a change to the favourites or
// Liked re-renders only the stars and hearts it flips, never the grid or page around them.

/**
 * Whether `key` is in `set`, for this component. The computed is made again whenever `key`
 * changes: a component shown for another item (the ⋯ menu, Now Playing after a skip) must
 * not keep the answer for the last one (useComputed would, until the set itself changed).
 */
function useHas(set: ReadonlySignal<Set<string>>, key: string | undefined): boolean {
  return useMemo(() => computed(() => key != null && set.value.has(key)), [set, key]).value;
}

export function useFavGenre(name: string): boolean {
  return useHas(favGenreSet, name);
}

export function useFavArtist(name: string): boolean {
  return useHas(favArtistKeys, artistKey(name) || undefined);
}

export function useLiked(id: string | undefined): boolean {
  return useHas(likedIds, id);
}
