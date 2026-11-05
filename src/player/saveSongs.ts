import type { Track } from '../data/model';
import { PLAYLIST_MAX_SONGS } from '../stores/playlists';
import type { PlayerState } from './types';

/** A song you queued that played, and the song that played before it (null: none). */
export interface HeardMine {
  track: Track;
  after: string | null;
}

/**
 * What [Save queue as playlist] saves (queue rules 3 and 8), each song once, at most
 * PLAYLIST_MAX_SONGS, in the order they played or will play: the songs you queued and heard in
 * earlier lists of the chain, the current list (not what's on the way), then the ones you queued
 * that left the queue since (`gone`), each right after the song it followed, else at the end.
 * Shuffled, play order is the rows as they show (`shown`), then the rest in list order.
 */
export function saveSongs({ queue, listStart, nextStart, shuffle, mine, shown, gone }: Pick<PlayerState, 'queue' | 'listStart' | 'nextStart' | 'shuffle' | 'mine'> & { shown: Track[]; gone: HeardMine[] }): Track[] {
  const inPlayOrder = (xs: Track[]) => {
    const ids = new Set(xs.map((t) => t.id));
    return shuffle ? [...shown.filter((t) => ids.has(t.id)), ...xs] : xs;
  };
  const before = mine.filter((i) => i < listStart).map((i) => queue[i]);
  const seen = new Set<string>();
  const songs = [...inPlayOrder(before), ...inPlayOrder(queue.slice(listStart, nextStart < 0 ? undefined : nextStart))].filter((t) => !seen.has(t.id) && (seen.add(t.id), true));
  const inQueue = new Set(queue.map((t) => t.id));
  const placed = new Set<string>();
  for (const { track, after } of gone) {
    if (inQueue.has(track.id) || seen.has(track.id)) continue;
    seen.add(track.id);
    // After the song it followed, and after the ones already placed there (they played first).
    let at = songs.findIndex((t) => t.id === after) + 1 || songs.length;
    while (at < songs.length && placed.has(songs[at].id)) at++;
    songs.splice(at, 0, track);
    placed.add(track.id);
  }
  return songs.slice(0, PLAYLIST_MAX_SONGS);
}
