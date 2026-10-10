/**
 * M1: actions that take something away come with an Undo toast, and Undo puts the item
 * back exactly where it was. Use these from the UI rather than the bare toggles.
 */
import type { Track } from '../data/model';
import {
  type Removed,
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
import { plural } from '../core/text';

const UNDO = 'Undo';

/** How long a short note shows: an "added" (undone by tapping again) or "still loading". */
const BRIEF_MS = 1800;

/** Like or unlike; an unlike can be undone. Returns the new liked state. */
export function toggleLikeWithUndo(track: Track): boolean {
  // A track not known yet (a placeholder while the player's list resolves) can't be saved.
  if (!track.ytId && !isLiked(track.id)) {
    toast('Still loading this track. Try again in a moment.', BRIEF_MS);
    return false;
  }
  if (!isLiked(track.id)) {
    toggleLike(track);
    toast('Added to Liked songs', BRIEF_MS);
    return true;
  }
  const r = unlike(track.id);
  if (r) toast('Removed from Liked songs', undefined, { label: UNDO, run: () => restoreLike(r), ...(r.item.membersOnly && { membersOnly: true }) });
  return false;
}

/** Favourite or unfavourite [name] through [f]; an unfavourite can be undone. Returns the new state. */
function toggleFavoriteWithUndo(
  name: string,
  f: { is: (name: string) => boolean; add: (name: string) => unknown; remove: (name: string) => Removed<string> | null; restore: (r: Removed<string>) => void },
): boolean {
  if (!f.is(name)) {
    f.add(name);
    toast(`${name} added to Favourites`, BRIEF_MS);
    return true;
  }
  const r = f.remove(name);
  if (r) toast(`${name} removed from Favourites`, undefined, { label: UNDO, run: () => f.restore(r) });
  return false;
}

const GENRE = { is: isFavoriteGenre, add: toggleFavoriteGenre, remove: removeFavoriteGenre, restore: restoreFavoriteGenre };
const ARTIST = { is: isFavoriteArtist, add: toggleFavoriteArtist, remove: removeFavoriteArtist, restore: restoreFavoriteArtist };

export const toggleFavoriteGenreWithUndo = (name: string): boolean => toggleFavoriteWithUndo(name, GENRE);
export const toggleFavoriteArtistWithUndo = (name: string): boolean => toggleFavoriteWithUndo(name, ARTIST);

/** Clear listening history, with Undo. */
export function clearHistoryWithUndo(): void {
  const old = clearRecent();
  if (!old.length) return;
  toast(`Cleared ${plural(old.length, 'play')}`, undefined, {
    label: UNDO,
    run: () => restoreHistory(old),
    ...(old.some((e) => e.track.membersOnly) && { membersOnly: true }),
  });
}
