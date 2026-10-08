/**
 * Autoplay (AP4): keeps 20-25 similar tracks ahead of the end of the list.
 *
 * The player says when it runs low (5 autoplay tracks or fewer to go: native's `queueLow`
 * event, the web player inline) and this adds more, one refill at a time:
 *  - a Jukebox seed: similar Jukebox tracks from the cached catalog (data/similar);
 *  - a Global seed: YouTube Music's radio for it (web player only; natively the playback
 *    service runs Global radios itself, so they refill with the screen off).
 * Nothing while autoplay is off (the setting, C3) or repeat is on.
 */
import { isGlobal, type Track } from '../data/model';
import { similarTracks } from '../data/similar';
import { AUTOPLAY_FIRST, AUTOPLAY_MORE, type Player, type QueueLow } from './types';

export interface AutoplayDeps {
  player: Player;
  /** The cached Jukebox catalog (NSFW setting applied). */
  catalog: () => readonly Track[];
  /** Recently played, newest first. */
  history: () => readonly Track[];
  showNsfw: () => boolean;
  signedIn: () => boolean;
  /** YouTube is backing us off (Y1): no Global requests. */
  blocked: () => boolean;
  /** One page of a song's radio (Music.radio). */
  radio: (ytId: string, next?: string) => Promise<{ tracks: Track[]; next?: string }>;
  rng?: () => number;
  log?: (where: string, e: unknown) => void;
}

export interface Autoplay {
  /** Add more after a low signal (also what the player's onQueueLow calls). */
  fill(e: QueueLow): Promise<void>;
  stop(): void;
}

export function createAutoplay(deps: AutoplayDeps): Autoplay {
  const { player } = deps;
  let inflight: Promise<void> | null = null;
  /** The web player's Global radio: where the next page starts. */
  let radio: { seedId: string; ytId: string; next?: string } | null = null;

  async function run(e: QueueLow): Promise<void> {
    const s = player.state.peek();
    const seed = s.seed ?? s.current;
    if (!seed || !s.current || s.repeat !== 'off') return;
    if (e.seedId && e.seedId !== seed.id) return; // a signal for an older seed
    const count = e.left <= 0 ? AUTOPLAY_FIRST : AUTOPLAY_MORE;
    const inQueue = new Set(s.queue.flatMap((t) => [t.id, t.ytId]));

    if (isGlobal(seed)) {
      if (player.kind === 'native' || deps.blocked()) return;
      const from = radio?.seedId === seed.id ? radio : { seedId: seed.id, ytId: seed.ytId };
      const page = await deps.radio(from.ytId, from.next);
      const tracks = page.tracks.filter((t) => !inQueue.has(t.ytId) && !inQueue.has(t.id));
      // At the end of a radio, the next one starts from its last song.
      radio = page.next ? { ...from, next: page.next } : { seedId: seed.id, ytId: tracks.at(-1)?.ytId ?? from.ytId };
      if (tracks.length) await player.addAutoplay(tracks, seed.id);
      return;
    }

    const picks = similarTracks(deps.catalog(), {
      seed,
      recent: deps.history(),
      exclude: inQueue,
      before: [s.current, ...s.upNext.map((u) => u.track)],
      count,
      showNsfw: deps.showNsfw(),
      signedIn: deps.signedIn(),
      rng: deps.rng,
    });
    if (picks.length) await player.addAutoplay(picks, seed.id);
  }

  /** A signal that came in during a refill: handled right after it (the latest only). */
  let again: QueueLow | null = null;

  function fill(e: QueueLow): Promise<void> {
    // One refill at a time.
    if (inflight) {
      again = e;
      return inflight;
    }
    const p = run(e)
      .catch((err) => deps.log?.('autoplay', err))
      .finally(() => {
        if (inflight === p) inflight = null;
        const next = again;
        again = null;
        if (next) void fill(next);
      });
    inflight = p;
    return p;
  }

  const off = player.onQueueLow((e) => void fill(e));
  return { fill, stop: off };
}
