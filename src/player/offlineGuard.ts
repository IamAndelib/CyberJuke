/**
 * Offline the only music that plays is liked songs saved on the phone (the listening cache),
 * and whatever the current track still has buffered. A command that would start something new
 * is checked up front; a refused one never reaches native or the web player (its state stays as
 * it was), and `refuse` says why:
 *  - a list, from wherever it was started, plays its saved songs, from the tapped one; when that
 *    one isn't saved, 'unsaved' for a liked song, 'offline' for anything else;
 *  - Next while a saved song is ahead (native goes to it, past the unsaved ones: OfflineNext.kt),
 *    Previous and a tap in Up next only onto a saved song ('unsaved' for a liked one);
 *  - with nothing loaded, Add to queue and Undo start a list (the players do), so the list rule;
 *  - resuming the current track (Play, or the play/pause button while paused) only when it plays
 *    offline ([playsOffline]): saved, or with audio loaded ahead (native plays from its buffer
 *    and says "Signal lost…" if that runs out). The track the app reopens on has none loaded:
 *    unsaved, it is refused like its row ('unsaved' for a liked song, 'offline' for the rest).
 * Pausing (also during the wait for the network), seeking, queue edits and settings always go through.
 */
import { UP_NEXT_MAX } from '../core/guards';
import type { Track } from '../data/model';
import { isSaved, savedQueue } from '../stores/savedOffline';
import { livePosition, wantsPlay, type Player, type PlayerState } from './types';

/** Previous in the first 3 s goes to the song before, later it starts this one again (Media3's default). */
const PREV_RESTARTS_MS = 3000;

/** Offline, Next has somewhere to go: a saved song ahead (with Repeat all, anywhere in the list but here). */
function savedAhead(s: Pick<PlayerState, 'upNext' | 'queue' | 'index' | 'repeat'>, saved: ReadonlySet<string>): boolean {
  if (s.upNext.some((u) => isSaved(u.track, saved))) return true;
  return s.repeat === 'all' && s.queue.some((t, i) => i !== s.index && isSaved(t, saved));
}

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
  /** Audio ids (audioIdOf) of the liked songs saved whole on the phone. */
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
  /** Why `t` doesn't play offline: a liked song isn't saved yet, anything else needs a connection. */
  const why = (t: Track | null | undefined): OfflineRefusal => (t && o.liked(t) ? 'unsaved' : 'offline');
  /** Online, or `t` saved: run it; else refused. */
  const onto = (t: Track | null | undefined, run: () => Promise<void>) => (o.online() || isSaved(t, o.saved()) ? run() : refused(why(t)));
  /**
   * The song Previous lands on: in its first seconds the one before in play order, heard or not
   * (the list's, or with shuffle the last one heard), going round to the last with Repeat all
   * (the list's; with shuffle the end of Up next, when it shows all of it); else this one from
   * its start. As the player's Previous does (Repeat one counts as off).
   */
  const behind = () => {
    const s = p.state.peek();
    if (livePosition(s) >= PREV_RESTARTS_MS) return s.current;
    const before = s.shuffle ? s.previous.at(-1)?.track : s.index > 0 ? s.queue[s.index - 1] : undefined;
    const last = !s.shuffle ? s.queue.at(-1) : s.upNext.length < UP_NEXT_MAX ? s.upNext.at(-1)?.track : undefined;
    return before ?? (s.repeat === 'all' ? last : undefined) ?? s.current;
  };
  /** Online, or the current track plays offline: run it; else refused as its row would be. */
  const resume = (run: () => Promise<void>) => {
    const s = p.state.peek();
    if (o.online() || playsOffline(s, o.saved())) return run();
    return refused(why(s.current));
  };
  const playList: Player['playList'] = (tracks, start, ctx) => {
    if (o.online()) return p.playList(tracks, start, ctx);
    const q = savedQueue(tracks, start, o.saved());
    if (q) return p.playList(q.tracks, q.start, ctx);
    return refused(why(tracks[start]));
  };
  const empty = () => p.state.peek().index < 0;
  return {
    ...p,
    play: () => resume(() => p.play()),
    // Playing (or waiting for the network to resume), it pauses: always.
    toggle: () => (wantsPlay(p.state.peek()) ? p.toggle() : resume(() => p.toggle())),
    playList,
    addToQueue: (tracks) => (empty() ? playList(tracks, 0) : p.addToQueue(tracks)),
    restore: (track, kind, beforeId) => (empty() ? playList([track], 0) : p.restore(track, kind, beforeId)),
    next: () => {
      const s = p.state.peek();
      return o.online() || savedAhead(s, o.saved()) ? p.next() : refused(why(s.upNext[0]?.track));
    },
    prev: () => onto(behind(), () => p.prev()),
    skipTo: (index, expectId) => onto(p.state.peek().queue[index], () => p.skipTo(index, expectId)),
  };
}
