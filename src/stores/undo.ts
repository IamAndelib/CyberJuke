/**
 * M1: actions that take something away come with an Undo toast, and Undo puts the item
 * back exactly where it was. Use these from the UI rather than the bare toggles.
 */
import type { Track } from '../data/model';
import { hasAudio } from '../core/guards';
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
import { PLAYLISTS_MAX, PLAYLIST_MAX_SONGS, addToPlaylist, createPlaylist, playlists, removeFromPlaylist, restoreToPlaylist } from './playlists';

const UNDO = 'Undo';

/** How long a short note shows: an "added" (undone by tapping again) or "still loading". */
const BRIEF_MS = 1800;

/** Like or unlike; an unlike can be undone. Returns the new liked state. */
export function toggleLikeWithUndo(track: Track): boolean {
  // A track not known yet (a placeholder while the player's list resolves) can't be saved.
  if (!hasAudio(track) && !isLiked(track.id)) {
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
  toast('Listening history cleared', undefined, {
    label: UNDO,
    run: () => restoreHistory(old),
    ...(old.some((e) => e.track.membersOnly) && { membersOnly: true }),
  });
}

const playlistName = (id: string) => playlists.peek().find((p) => p.id === id)?.name ?? 'the playlist';

/** Adds [track] to playlist [id]: "Added to Night drive", and Undo takes it out again. */
export function addToPlaylistWithUndo(id: string, track: Track): void {
  const name = playlistName(id);
  const r = addToPlaylist(id, track);
  if (r === 'already') toast(`Already in ${name}`, BRIEF_MS);
  else if (r === 'full') toast(`${name} is full: ${PLAYLIST_MAX_SONGS.toLocaleString('en')} songs at most`);
  else if (r === 'added') toast(`Added to ${name}`, undefined, { label: UNDO, run: () => void removeFromPlaylist(id, track.id), ...(track.membersOnly && { membersOnly: true }) });
}

/**
 * A new playlist made from [track] (Add to playlist's New playlist): "Added to Road trip", and
 * Undo takes the song out but keeps the playlist. Returns its id, or null when none was made.
 */
export function createWithSongWithUndo(name: string, track: Track): string | null {
  const r = createPlaylist(name, [track]);
  if (r.result === 'full') {
    toast(`You have ${PLAYLISTS_MAX} playlists, the most there can be`);
    return null;
  }
  if (r.result !== 'created') return null;
  toast(`Added to ${playlistName(r.id)}`, undefined, { label: UNDO, run: () => void removeFromPlaylist(r.id, track.id), ...(track.membersOnly && { membersOnly: true }) });
  return r.id;
}

/** Takes song [trackId] out of playlist [id] (Edit songs' ✕): "Removed from Night drive", and Undo puts it back. */
export function removeFromPlaylistWithUndo(id: string, trackId: string): void {
  const name = playlistName(id);
  const r = removeFromPlaylist(id, trackId);
  if (r) toast(`Removed from ${name}`, undefined, { label: UNDO, run: () => restoreToPlaylist(id, r), ...(r.item.membersOnly && { membersOnly: true }) });
}
