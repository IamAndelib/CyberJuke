/**
 * Autoplay (AP4): keeps 20-25 similar tracks ahead of the end of the list.
 *
 * The player says when it runs low (5 autoplay tracks or fewer to go: native's `queueLow`
 * event, the web player inline) and this adds more once the app is idle, one refill at a time:
 *  - a Jukebox seed: similar Jukebox tracks from the cached catalog (data/similar);
 *  - a Global seed: YouTube Music's radio for it (web player only; natively the playback
 *    service runs Global radios itself, so they refill with the screen off);
 *  - a Signal Radio station playing: its next round (player/radio), all its tracks again;
 *  - Home's Shuffle (its label, shuffleLabel): more random songs from the same pool.
 * Nothing while autoplay is off (the setting, C3), but for a station, or while repeat is on.
 */
import { whenIdle } from '../core/idle';
import { audioKey, isGlobal, type Track } from '../data/model';
import { similarTracks } from '../data/similar';
import { shuffle, stationPlaying, stationQueue } from './radio';
import { AUTOPLAY_FIRST, AUTOPLAY_LOW, AUTOPLAY_MORE, type Player, type QueueLow } from './types';

/** How long a batch just added counts as ahead even before the player's state shows it (native's lags the call). */
const BATCH_LAG_MS = 5000;

const SHUFFLE = 'Jukebox shuffle';

/** The label Home's Shuffle starts its list with: "Jukebox shuffle", or "Jukebox shuffle · rock" for one genre. */
export const shuffleLabel = (genre: string | null): string => (genre ? `${SHUFFLE} · ${genre}` : SHUFFLE);

/** The songs a Jukebox shuffle draws from, by its label: the whole catalog or one genre's; null for any other list. */
function shufflePool(label: string | undefined, catalog: readonly Track[]): readonly Track[] | null {
  if (label === SHUFFLE) return catalog;
  const genre = label?.startsWith(`${SHUFFLE} · `) ? label.slice(SHUFFLE.length + 3) : null;
  return genre ? catalog.filter((t) => t.genre === genre) : null;
}

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
  now?: () => number;
}

export interface Autoplay {
  /** Add more after a low signal (also what the player's onQueueLow calls). */
  fill(e: QueueLow): Promise<void>;
  /** The catalog has loaded: answer a signal that came before it (the player won't send it again). */
  catalogReady(): void;
  stop(): void;
}

export function createAutoplay(deps: AutoplayDeps): Autoplay {
  const { player } = deps;
  let inflight: Promise<void> | null = null;
  const now = deps.now ?? (() => Date.now());
  /** The web player's Global radio: where the next page starts. */
  let radio: { seedId: string; ytId: string; next?: string } | null = null;
  /**
   * The last batch added, until the player's state shows it: `queue` is the list the
   * state had when the call returned; once that changes, the batch is in it (or was
   * dropped: repeat, a new list).
   */
  let batch: { seedId: string; ids: string[]; at: number; queue?: readonly Track[]; round?: boolean } | null = null;
  /**
   * A Jukebox signal that came while the catalog was still loading (first launch, sign-in,
   * a reloaded WebView): nothing to pick from yet, so it waits for `catalogReady`.
   */
  let starved: QueueLow | null = null;

  async function run(e: QueueLow): Promise<void> {
    const s = player.state.peek();
    const seed = s.seed ?? s.current;
    if (!seed || !s.current || s.repeat !== 'off') return;
    if (e.seedId && e.seedId !== seed.id) return; // a signal for an older seed
    const inQueue = new Set(s.queue.flatMap((t) => [t.id, audioKey(t)]));
    // The signal may be older than the last refill (one that came in during it): count
    // again. A batch the state doesn't show yet is ahead too, and not picked again. (A
    // station's round holds tracks already in the queue: its ids say nothing about that.)
    if (batch && (batch.seedId !== seed.id || now() - batch.at > BATCH_LAG_MS || (batch.queue && batch.queue !== s.queue) || (!batch.round && batch.ids.some((id) => inQueue.has(id))))) batch = null;
    const lagging = batch?.ids ?? [];
    for (const id of lagging) inQueue.add(id);
    const left = Math.max(e.left, s.upNext.filter((u) => u.auto).length) + lagging.length;
    if (left > AUTOPLAY_LOW) return;
    const count = left <= 0 ? AUTOPLAY_FIRST : AUTOPLAY_MORE;
    const add = async (tracks: Track[], round = false) => {
      const b: NonNullable<typeof batch> = { seedId: seed.id, ids: tracks.map((t) => t.id), at: now(), ...(round && { round }) };
      batch = b;
      await player.addAutoplay(tracks, seed.id);
      b.queue = player.state.peek().queue;
    };

    // A station plays on: its next round, which doesn't start with the last track queued. (A
    // station's track in another list, Liked say, gets similar picks like any other.)
    const station = stationPlaying(s.context, seed.id);
    if (station) {
      await add(stationQueue(station, s.queue.at(-1)?.ytId, deps.rng), true);
      return;
    }

    if (isGlobal(seed)) {
      if (player.kind === 'native' || deps.blocked()) return;
      const from = radio?.seedId === seed.id ? radio : { seedId: seed.id, ytId: seed.ytId };
      const page = await deps.radio(from.ytId, from.next);
      const tracks = page.tracks.filter((t) => !inQueue.has(t.ytId) && !inQueue.has(t.id));
      // At the end of a radio, the next one starts from its last song.
      radio = page.next ? { ...from, next: page.next } : { seedId: seed.id, ytId: tracks.at(-1)?.ytId ?? from.ytId };
      if (tracks.length) await add(tracks);
      return;
    }

    const catalog = deps.catalog();
    if (!catalog.length) {
      starved = e;
      return;
    }
    starved = null;
    // A Jukebox shuffle plays on like a station: random songs from its pool not yet queued,
    // then, once every one is, another round of it (but the song just queued).
    const pool = shufflePool(s.context?.label, catalog)?.filter((t) => !t.membersOnly || deps.signedIn());
    if (pool) {
      const fresh = pool.filter((t) => !inQueue.has(t.id));
      const from = fresh.length ? fresh : pool.filter((t) => t.id !== s.queue.at(-1)?.id);
      if (from.length) await add(shuffle(from, deps.rng).slice(0, count), !fresh.length);
      return;
    }
    // What played since this seed started steers it (Jukebox tracks only: similarTracks skips Global ones).
    const played = s.index >= 0 ? s.queue.slice(0, s.index + 1) : [];
    const from = played.map((t) => t.id).lastIndexOf(seed.id);
    const picks = similarTracks(catalog, {
      seed,
      played: from < 0 ? [] : played.slice(from + 1).reverse(),
      recent: deps.history(),
      exclude: inQueue,
      before: [s.current, ...s.upNext.map((u) => u.track)],
      count,
      showNsfw: deps.showNsfw(),
      signedIn: deps.signedIn(),
      rng: deps.rng,
    });
    if (picks.length) await add(picks);
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

  function catalogReady(): void {
    const e = starved;
    starved = null;
    if (e) void fill(e);
  }

  // Once the app is idle: a new list sends this on the tap that starts it, and the
  // pick (data/similar) would hold that tap's first frame. The list itself plays meanwhile.
  // A newer signal replaces one still waiting (the latest only, as in fill). With the
  // screen off there is no frame to keep, and a hidden page's idle time may be throttled.
  let idle = () => {};
  const off = player.onQueueLow((e) => {
    idle();
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') void fill(e);
    else idle = whenIdle(() => void fill(e), 1000, 50);
  });
  return {
    fill,
    catalogReady,
    stop: () => {
      idle();
      off();
    },
  };
}
