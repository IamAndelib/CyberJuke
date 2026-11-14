/**
 * The session (D9): since you last started something yourself, a tap on a list or a song (the same
 * boundary as Save's memory, rule 8). Vibe skips every song heard since. Every list the app starts
 * goes through playList, once the offline guard lets it (the app wires this under it); nothing else
 * does: a batch arriving or a station moving on (addAutoplay), Repeat, a tap in Up next, or a
 * reloaded page taking up the phone's session. A list started has a new context (both players give
 * each list its own); one that doesn't start (nothing in it plays, the player refused it) keeps the old.
 * Kept in Preferences, so a restart goes on with it.
 */
import { readJson, type KV } from '../core/storage';
import type { Player } from './types';

const KEY = 'vibe.since';

export interface Session {
  /** The player, its playList watched. */
  player: Player;
  /** When you last started something (epoch ms); null before the first list. */
  since(): Promise<number | null>;
}

export function sessionStarts(p: Player, store: KV, now = () => Date.now()): Session {
  /** undefined: not read from the store yet. */
  let at: number | null | undefined;
  return {
    player: {
      ...p,
      // Both players show the new list before they wait for anything (native's optimistic state, the
      // web player's first publish), so it counts at once: a refill asked meanwhile is already this list's.
      playList: (tracks, start, ctx) => {
        const was = p.state.peek().context;
        // Taken first: the list's first song, recorded as it starts playing, is heard since.
        const t = now();
        const done = p.playList(tracks, start, ctx);
        if (p.state.peek().context !== was) {
          at = t;
          void store.set(KEY, String(t)).catch(() => {});
        }
        return done;
      },
    },
    since: async () => {
      if (at === undefined) {
        const was = await readJson<unknown>(store, KEY, null);
        at ??= typeof was === 'number' && Number.isFinite(was) ? was : null;
      }
      return at;
    },
  };
}
