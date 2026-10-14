/**
 * Offline the only music that plays is liked songs saved on the phone (the listening cache),
 * and whatever the current track still has buffered. A command that would start something new
 * is checked up front; a refused one never reaches native or the web player (its state stays as
 * it was), and `refuse` says why:
 *  - a list started from Liked plays its saved songs, from the tapped one ('unsaved' when that
 *    one isn't saved);
 *  - Next, Previous and a tap in Up next only onto a saved song;
 *  - anything else is refused ('offline').
 * Resuming the current track (Play, or the play/pause button while paused) always goes
 * through: native plays from its buffer and says "Signal lost…" if that runs out. Pausing,
 * seeking, queue edits and settings always go through too.
 */
import type { Track } from '../data/model';
import { LIKED_LABEL, isSaved, savedQueue } from '../stores/savedOffline';
import type { Player } from './types';

export type OfflineRefusal = 'unsaved' | 'offline';

export interface OfflinePolicy {
  online(): boolean;
  /** ytIds of the liked songs saved whole on the phone. */
  saved(): ReadonlySet<string>;
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
  return {
    ...p,
    playList: (tracks, start, ctx) => {
      if (o.online()) return p.playList(tracks, start, ctx);
      if (ctx?.label !== LIKED_LABEL) return refused('offline');
      const q = savedQueue(tracks, start, o.saved());
      return q ? p.playList(q.tracks, q.start, ctx) : refused('unsaved');
    },
    next: () => onto(p.state.peek().upNext[0]?.track, () => p.next()),
    prev: () => onto(current(), () => p.prev()),
    skipTo: (index, expectId) => onto(p.state.peek().queue[index], () => p.skipTo(index, expectId)),
  };
}
