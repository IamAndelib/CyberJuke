import { useComputed } from '@preact/signals';
import { artistKey } from '../data/artists';
import { favArtistKeys, favGenreSet, likedIds } from '../stores/library';

// One item's star or heart. Each reads its own computed, so a change to the favourites or
// Liked re-renders only the stars and hearts it flips, never the grid or page around them.

export function useFavGenre(name: string): boolean {
  return useComputed(() => favGenreSet.value.has(name)).value;
}

export function useFavArtist(name: string): boolean {
  return useComputed(() => favArtistKeys.value.has(artistKey(name))).value;
}

export function useLiked(id: string | undefined): boolean {
  return useComputed(() => id != null && likedIds.value.has(id)).value;
}
