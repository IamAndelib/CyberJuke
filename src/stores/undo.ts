/**
 * M1: actions that take something away come with an Undo toast, and Undo puts the item
 * back exactly where it was. Use these from the UI rather than the bare toggles.
 */
import type { Track } from '../data/model';
import {
  clearRecent,
  isFavoriteArtist,
  isFavoriteGenre,
  isLiked,
  removeFavoriteArtist,
  removeFavoriteGenre,
  restoreFavoriteArtist,
  restoreFavoriteGenre,
  restoreHistory,
  restoreLike,
  toggleFavoriteArtist,
  toggleFavoriteGenre,
  toggleLike,
  unlike,
} from './library';
import { toast } from './toast';

const UNDO = 'Undo';

/** How long an "added" confirmation shows (no Undo: adding is undone by tapping again). */
const ADDED_MS = 1800;

/** Like or unlike; an unlike can be undone. Returns the new liked state. */
export function toggleLikeWithUndo(track: Track): boolean {
  // A track not known yet (a placeholder while the player's list resolves) can't be saved.
  if (!track.ytId && !isLiked(track.id)) {
    toast('Still loading this track. Try again in a moment.', 1800);
    return false;
  }
  if (!isLiked(track.id)) {
    toggleLike(track);
    toast('Added to Liked songs', ADDED_MS);
    return true;
  }
  const r = unlike(track.id);
  if (r) toast('Removed from Liked', undefined, { label: UNDO, run: () => restoreLike(r), ...(r.item.membersOnly && { membersOnly: true }) });
  return false;
}

/** Favourite or unfavourite a genre; an unfavourite can be undone. Returns the new state. */
export function toggleFavoriteGenreWithUndo(name: string): boolean {
  if (!isFavoriteGenre(name)) {
    toggleFavoriteGenre(name);
    toast(`${name} added to Favourites`, ADDED_MS);
    return true;
  }
  const r = removeFavoriteGenre(name);
  if (r) toast(`${name} removed from Favourites`, undefined, { label: UNDO, run: () => restoreFavoriteGenre(r) });
  return false;
}

/** Favourite or unfavourite an artist; an unfavourite can be undone. Returns the new state. */
export function toggleFavoriteArtistWithUndo(name: string): boolean {
  if (!isFavoriteArtist(name)) {
    toggleFavoriteArtist(name);
    toast(`${name} added to Favourites`, ADDED_MS);
    return true;
  }
  const r = removeFavoriteArtist(name);
  if (r) toast(`${name} removed from Favourites`, undefined, { label: UNDO, run: () => restoreFavoriteArtist(r) });
  return false;
}

/** Clear listening history, with Undo. */
export function clearHistoryWithUndo(): void {
  const old = clearRecent();
  if (!old.length) return;
  toast(`Cleared ${old.length} play${old.length === 1 ? '' : 's'}`, undefined, {
    label: UNDO,
    run: () => restoreHistory(old),
    ...(old.some((e) => e.track.membersOnly) && { membersOnly: true }),
  });
}
