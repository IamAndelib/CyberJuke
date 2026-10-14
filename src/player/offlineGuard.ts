/**
 * Offline the only music that plays is liked songs saved on the phone (the listening cache),
 * and whatever the current track still has buffered. A command that would start something new
 * is checked up front; a refused one never reaches native or the web player (its state stays as
 * it was), and `refuse` says why:
 *  - a list, from wherever it was started, plays its saved songs, from the tapped one; when that
 *    one isn't saved, 'unsaved' for a liked song, 'offline' for anything else;
 *  - Next, Previous and a tap in Up next only onto a saved song ('offline');
 *  - resuming the current track (Play, or the play/pause button while paused) only when it plays
 *    offline ([playsOffline]): saved, or with audio loaded ahead (native plays from its buffer
 *    and says "Signal lost…" if that runs out). The track the app reopens on has none loaded:
 *    unsaved, it is refused like its row ('unsaved' for a liked song, 'offline' for the rest).
 * Pausing, seeking, queue edits and settings always go through.
 */
import type { Track } from '../data/model';
import { isSaved, savedQueue } from '../stores/savedOffline';
import type { Player, PlayerState } from './types';

/**
 * Offline, the current track plays: it is saved on the phone, has audio loaded past where it is,
 * or is playing. Its row is dimmed otherwise, and Play refused.
 */
export function playsOffline(s: Pick<PlayerState, 'current' | 'isPlaying' | 'bufferedAheadMs'>, saved: ReadonlySet<string>): boolean {
  return s.isPlaying || s.bufferedAheadMs > 0 || isSaved(s.current, saved);
}

export type OfflineRefusal = 'unsaved' | 'offline';

export interface OfflinePolicy {
  online(): boolean;
  /** ytIds of the liked songs saved whole on the phone. */
  saved(): ReadonlySet<string>;
  /** Whether `t` is liked (a liked song not saved yet says so). */
  liked(t: Track): boolean;
  /** Show why a command was refused. */
  refuse(why: OfflineRefusal): void;
}

export function offlineGuard(p: Player, o: OfflinePolicy): Player {
  const done = Promise.resolve();
  const refused = (why: OfflineRefusal) => {
    o.refuse(why);
    return done;
  };
  /** Online, or `t` saved: run it; else refused. */
  const onto = (t: Track | null | undefined, run: () => Promise<void>) => (o.online() || isSaved(t, o.saved()) ? run() : refused('offline'));
  const current = () => p.state.peek().current;
  /** Online, or the current track plays offline: run it; else refused as its row would be. */
  const resume = (run: () => Promise<void>) => {
    const s = p.state.peek();
    if (o.online() || playsOffline(s, o.saved())) return run();
    return refused(s.current && o.liked(s.current) ? 'unsaved' : 'offline');
  };
  return {
    ...p,
    play: () => resume(() => p.play()),
    // Playing, it pauses: always.
    toggle: () => (p.state.peek().isPlaying ? p.toggle() : resume(() => p.toggle())),
    playList: (tracks, start, ctx) => {
      if (o.online()) return p.playList(tracks, start, ctx);
      const q = savedQueue(tracks, start, o.saved());
      if (q) return p.playList(q.tracks, q.start, ctx);
      const tapped = tracks[start];
      return refused(tapped && o.liked(tapped) ? 'unsaved' : 'offline');
    },
    next: () => onto(p.state.peek().upNext[0]?.track, () => p.next()),
    prev: () => onto(current(), () => p.prev()),
    skipTo: (index, expectId) => onto(p.state.peek().queue[index], () => p.skipTo(index, expectId)),
  };
}
