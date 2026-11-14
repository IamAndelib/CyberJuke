/**
 * Autoplay (AP4): a list leads on to the next, a batch of VIBE_BATCH (25) tracks on the way (rule 2).
 *
 * The player says when nothing is on the way (as the current list starts: an album, a batch moved on
 * to, Repeat all or Vibe turned off and on again; native's `queueLow` event, the web player inline), so
 * the next list is there in full long before it plays, also with the screen locked, as Metrolist fetches
 * at album start. This adds it once the app is idle, one at a time:
 *  - a Jukebox seed: similar Jukebox tracks from the cached catalog (data/similar);
 *  - a Global seed: YouTube Music's radio for it (web player only; natively the playback
 *    service runs Global radios itself, so they refill with the screen off);
 *  - a Signal Radio station playing: the next station (player/radio nextStation), all of it;
 *  - Home's Shuffle (its label, shuffleLabel): more random songs from the same pool.
 * Offline, only songs saved on the phone (playable); a station whole, if it has one (Next skips the
 * others). Nothing while autoplay is off (the setting, C3), but for a station or a Jukebox shuffle
 * (chainsOn), or with repeat all but for a radio's first batch (mayAutoplay).
 */
import { whenIdle } from '../core/idle';
import { shuffled } from '../core/shuffle';
import { readJson, type KV } from '../core/storage';
import { audioKey, isGlobal, isLocal, type Track } from '../data/model';
import { similarTracks } from '../data/similar';
import { STATIONS, listStation, nextStation, stationPlaying, stationTracks, type Station } from './radio';
import { VIBE_BATCH, firstBatchOfRadio, mayAutoplay, type Player, type QueueLow } from './types';

/** How long a signal waits for the player's state to show the batch just added (native's lags the call). */
const BATCH_LAG_MS = 5000;

const SHUFFLE = 'Jukebox shuffle';

/** The stations heard in this chain, in Preferences (store). */
const HEARD_KEY = 'radio.heard';

/** The label Home's Shuffle starts its list with: "Jukebox shuffle", or "Jukebox shuffle · rock" for one genre. */
export const shuffleLabel = (genre: string | null): string => (genre ? `${SHUFFLE} · ${genre}` : SHUFFLE);

/** A Jukebox shuffle's genre, by its label: null for the whole Jukebox, undefined for any other list. */
export function shuffleGenre(label: string | undefined): string | null | undefined {
  if (label === SHUFFLE) return null;
  return label?.startsWith(`${SHUFFLE} · `) ? label.slice(SHUFFLE.length + 3) : undefined;
}

/** The genre a Home list was picked in, by its label ("Home · rock", "Most saved · rock"); null for any other list (Latest, Most saved with no chip). */
export function pickedGenre(label: string | undefined): string | null {
  const m = label === 'Home · Latest' ? null : label?.match(/^(?:Home|Most saved) · (.+)$/);
  return m?.[1] ?? null;
}

/**
 * The list playing leads on to the next whatever the Vibe setting: a Signal Radio station, or
 * Home's Jukebox shuffle (natively Stations.keepsGoing, the same rule).
 */
export const chainsOn = (context: { label: string } | null | undefined, seedId: string | null | undefined): boolean =>
  !!stationPlaying(context, seedId) || shuffleGenre(context?.label) !== undefined;

/** The songs a Jukebox shuffle draws from: the whole catalog or one genre's; null for any other list. */
function shufflePool(label: string | undefined, catalog: readonly Track[]): readonly Track[] | null {
  const genre = shuffleGenre(label);
  return genre === undefined ? null : genre === null ? catalog : catalog.filter((t) => t.genre === genre);
}

export interface AutoplayDeps {
  player: Player;
  /** The cached Jukebox catalog (NSFW setting applied). */
  catalog: () => readonly Track[];
  /** Recently played, newest first. */
  history: () => readonly Track[];
  /** The songs heard since you last started something yourself (D9, player/session): Jukebox picks skip them while others are left. */
  heard?: () => Promise<readonly Track[]>;
  showNsfw: () => boolean;
  signedIn: () => boolean;
  /** YouTube is backing us off (Y1): no Global requests. */
  blocked: () => boolean;
  /** Track ids removed from Up next this session: never picked again. */
  removed?: () => ReadonlySet<string>;
  /** Where the stations heard in a chain are kept (Preferences), so a restart goes on with them; none, memory only. */
  store?: KV;
  /** Whether a track can play now (offline: only saved ones); only those are picked. */
  playable?: (t: Track) => boolean;
  /** One page of a song's radio (Music.radio). */
  radio: (ytId: string, next?: string) => Promise<{ tracks: Track[]; next?: string }>;
  rng?: () => number;
  log?: (where: string, e: unknown) => void;
  now?: () => number;
}

export interface Autoplay {
  /** Add the next list after the player's signal (also what its onQueueLow calls), unless one is on the way. */
  fill(e: QueueLow): Promise<void>;
  /** The catalog has loaded and the player has its state: answer a signal that came before (the player won't send it again). */
  ready(): void;
  /** A station was tuned in on the Radio tab: a new chain, where no station has been heard yet. */
  newStationChain(): void;
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
   * dropped: a new list). `repeats`: it holds songs already in the queue (Home's Shuffle's next
   * round, a station coming round again after the chain wraps), so its ids say nothing about whether it is in.
   */
  let batch: { seedId: string; ids: string[]; at: number; queue?: readonly Track[]; repeats?: boolean } | null = null;
  /**
   * A signal that came before the player's state or, for a Jukebox seed, while the catalog
   * was still loading (first launch, sign-in, a reloaded WebView, which native hands the
   * signal it missed): nothing to pick from yet, so it waits for `ready`.
   */
  let starved: QueueLow | null = null;
  /** A signal from before the state showed the last batch: looked at again once the state changes. */
  let lagged: QueueLow | null = null;
  /** The stations heard in this chain (null: not read from the store yet); with shuffle, the next is one not heard yet. */
  let heard: string[] | null = null;
  /** The next station picked, for the station playing: the same comes again if it was dropped (Repeat all on, then off). */
  let ahead: { from: Station; to: Station } | null = null;

  /** `st` is heard: the stations heard so far in this chain, with it; once all are, it alone (a new round of them). */
  async function hear(st: Station): Promise<string[]> {
    if (!heard) {
      const was = deps.store ? await readJson<unknown>(deps.store, HEARD_KEY, []) : [];
      heard ??= Array.isArray(was) ? was.filter((id): id is string => typeof id === 'string') : [];
    }
    if (!heard.includes(st.id)) {
      heard = heard.length + 1 >= STATIONS.length ? [st.id] : [...heard, st.id];
      void deps.store?.set(HEARD_KEY, JSON.stringify(heard)).catch(() => {});
    }
    return heard;
  }

  async function run(e: QueueLow): Promise<void> {
    const s = player.state.peek();
    const seed = s.seed ?? s.current;
    if (!seed || !s.current) {
      starved = e;
      return;
    }
    const first = firstBatchOfRadio(s.context, s.queue.length, s.upNext.filter((u) => u.queued).length);
    if (!mayAutoplay(s.repeat) && !first) return;
    // A local list ends like an album: nothing from the Jukebox or Global after a song of the phone's own.
    if (isLocal(seed)) return;
    if (e.seedId && e.seedId !== seed.id) return; // a signal for an older seed
    // A batch never repeats a song already in the queue (D8), nor one removed from Up next.
    const inQueue = new Set([...s.queue.flatMap((t) => [t.id, audioKey(t)]), ...(deps.removed?.() ?? [])]);
    // The signal may be older than the state with the last batch (native's lags the call): wait
    // for it, or a radio's first batch would come twice.
    if (batch && (batch.seedId !== seed.id || now() - batch.at > BATCH_LAG_MS || (batch.queue && batch.queue !== s.queue) || (!batch.repeats && batch.ids.some((id) => inQueue.has(id))))) batch = null;
    if (batch) {
      lagged = e;
      return;
    }
    // One list on the way at a time: the next is fetched when it starts.
    if (s.nextStart >= 0) return;
    const count = first ? VIBE_BATCH - 1 : VIBE_BATCH;
    const add = async (tracks: Track[]) => {
      const b: NonNullable<typeof batch> = { seedId: seed.id, ids: tracks.map((t) => t.id), at: now(), ...(tracks.some((t) => inQueue.has(t.id)) && { repeats: true }) };
      batch = b;
      await player.addAutoplay(tracks, seed.id);
      b.queue = player.state.peek().queue;
    };

    // Stations lead on: the next after the current list's station (listStation; nothing is on the
    // way here), whole, with a song that can play now: not the label's (the one tuned in), nor the
    // playing song's (the station before, after Previous, or one you queued). (A station's track in
    // another list, Liked say, gets similar picks like any other.)
    const playable = deps.playable ?? (() => true);
    const station = stationPlaying(s.context, seed.id);
    if (station) {
      const from = listStation(s.queue, s.mine) ?? station;
      const ok = (st: Station) => stationTracks(st).some(playable);
      const played = await hear(from);
      const to = ahead?.from === from && ok(ahead.to) ? ahead.to : nextStation(from, s.shuffle, played, ok, deps.rng);
      ahead = to && { from, to };
      if (to) await add([...stationTracks(to)]);
      return;
    }

    if (isGlobal(seed)) {
      if (player.kind === 'native' || deps.blocked()) return;
      const from = radio?.seedId === seed.id ? radio : { seedId: seed.id, ytId: seed.ytId };
      const page = await deps.radio(from.ytId, from.next);
      const tracks = page.tracks.filter((t) => !inQueue.has(t.ytId) && !inQueue.has(t.id) && playable(t));
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
    // The catalog itself while every song plays (online): similarTracks keeps its index per array.
    const usable = catalog.every(playable) ? catalog : catalog.filter(playable);
    const heard = new Set(((await deps.heard?.()) ?? []).map(audioKey));
    // A Jukebox shuffle plays on like a station: random songs from its pool not yet queued (those heard
    // since you last started something last), then, once every one is, another round of it (but the song just queued).
    const pool = shufflePool(s.context?.label, usable)?.filter((t) => !t.membersOnly || deps.signedIn());
    if (pool) {
      const fresh = pool.filter((t) => !inQueue.has(t.id));
      const from = fresh.length ? fresh : pool.filter((t) => t.id !== s.queue.at(-1)?.id);
      if (from.length) await add(shuffled(from, deps.rng).sort((a, b) => +heard.has(audioKey(a)) - +heard.has(audioKey(b))).slice(0, count));
      return;
    }
    // What played since this seed started steers it (Jukebox tracks only: similarTracks skips Global ones).
    const played = s.index >= 0 ? s.queue.slice(0, s.index + 1) : [];
    const from = played.map((t) => t.id).lastIndexOf(seed.id);
    const picks = similarTracks(usable, {
      seed,
      played: from < 0 ? [] : played.slice(from + 1).reverse(),
      recent: deps.history(),
      exclude: inQueue,
      heard,
      genre: pickedGenre(s.context?.label) ?? undefined,
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

  function ready(): void {
    const e = starved;
    starved = null;
    if (e) void fill(e);
  }

  // Once the app is idle: a new list sends this on the tap that starts it, and the
  // pick (data/similar) would hold that tap's first frame. The list itself plays meanwhile.
  // A newer signal replaces one still waiting (the latest only, as in fill). With the
  // screen off there is no frame to keep, and a hidden page's idle time may be throttled.
  let idle = () => {};
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const off = player.onQueueLow((e) => {
    idle();
    if (hidden()) void fill(e);
    else idle = whenIdle(() => void fill(e), 1000, 50);
  });
  // The state caught up with the last batch: a signal that waited for it goes ahead. (No reserve
  // in the background: the player holds the current list and the one on the way, and asks again
  // as that one starts; Global radios refill natively, with the page asleep or gone.)
  const unwatch = player.state.subscribe(() => {
    const e = lagged;
    lagged = null;
    if (e) void fill(e);
  });
  return {
    fill,
    ready,
    newStationChain: () => {
      heard = [];
      ahead = null;
      void deps.store?.remove(HEARD_KEY).catch(() => {});
    },
    stop: () => {
      idle();
      off();
      unwatch();
    },
  };
}
