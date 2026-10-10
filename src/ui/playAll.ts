/**
 * Every way the UI starts a list goes through here, with a play context (C2) saying
 * where it came from and how it continues:
 *  - 'radio' for feeds and results (Home, Most saved, Search, Global): the tapped track,
 *    then similar ones;
 *  - 'list' for lists (Album, Liked, History, a genre, an artist, Play/Shuffle): the
 *    list in order, then similar ones.
 */
import type { Track } from '../data/model';
import { player, type PlayContext } from '../player';

export const radio = (label: string): PlayContext => ({ label, mode: 'radio' });
export const list = (label: string): PlayContext => ({ label, mode: 'list' });

/** Start `tracks` at `i`. */
export function playFrom(tracks: Track[], i: number, ctx: PlayContext): Promise<void> {
  return player.playList(tracks, i, ctx);
}

/**
 * P3, the Play and Shuffle buttons: Play always plays in order with shuffle off;
 * Shuffle always turns shuffle on (from a random track).
 */
export async function playAll(tracks: Track[], { shuffle, ctx }: { shuffle: boolean; ctx: PlayContext }): Promise<void> {
  if (!tracks.length) return;
  if (!shuffle) {
    await player.setShuffle(false);
    await playFrom(tracks, 0, ctx);
    return;
  }
  await playFrom(tracks, Math.floor(Math.random() * tracks.length), ctx);
  await player.setShuffle(true);
}

/**
 * P2: a feed shows the first pages, but playing it uses the whole list: the loaded
 * rows (in their order, so the tapped index holds), then the rest of `all` after them.
 */
export function withRest(loaded: Track[], all: Track[]): Track[] {
  if (all.length <= loaded.length && loaded.every((t, i) => all[i] === t)) return loaded;
  const have = new Set(loaded.map((t) => t.id));
  const rest = all.filter((t) => !have.has(t.id));
  return rest.length ? [...loaded, ...rest] : loaded;
}
