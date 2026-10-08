/**
 * Player backed by the native JukePlayer plugin. The native side owns the queue;
 * this class only forwards commands and mirrors native state from events.
 */
import { signal } from '@preact/signals';
import { artworkUrl, type Track } from '../data/model';
import { knownTrack } from '../store/library';
import { toast } from '../store/toast';
import { YT_ID_RE, parseNativeState } from '../core/guards';
import { logError } from '../core/log';
import { JukePlayer, type NativeState, type NativeTrack, type RepeatMode } from './native';
import { EMPTY_STATE, LIST_CONTEXT, type PlayContext, type Player, type PlayerState, type QueueLow } from './types';

export function toNative(t: Track): NativeTrack {
  return { id: t.id, ytId: t.ytId, title: t.title, artist: t.artist, artworkUrl: t.artworkUrl, by: t.by, postUrl: t.postUrl };
}

/** A track native added itself (Global radio), from its `tracks` event. */
export function fromNative(t: NativeTrack): Track | null {
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.ytId !== 'string' || !YT_ID_RE.test(t.ytId)) return null;
  return {
    id: t.id,
    ytId: t.ytId,
    title: typeof t.title === 'string' && t.title ? t.title : 'Untitled',
    artist: typeof t.artist === 'string' && t.artist ? t.artist : 'Unknown artist',
    genre: '',
    by: '',
    postTitle: '',
    postUrl: '',
    createdAt: '',
    nsfw: false,
    artworkUrl: artworkUrl(t.ytId),
    ...(t.id.startsWith('ytm:') && { source: 'ytmusic' as const }),
  };
}

function placeholder(id: string): Track {
  return {
    id,
    ytId: '',
    title: 'Unknown track',
    artist: '',
    genre: '',
    by: '',
    postTitle: '',
    postUrl: '',
    createdAt: '',
    nsfw: false,
    artworkUrl: '',
  };
}

export class NativePlayer implements Player {
  readonly kind = 'native' as const;
  private readonly s = signal<PlayerState>({ ...EMPTY_STATE });
  readonly state = this.s;
  /** Every Track we've handed to native, so ids in native state resolve to full Tracks. */
  private known = new Map<string, Track>();
  /** The last full list native sent (events with queueIdsUnchanged omit it). */
  private lastQueueIds: string[] = [];
  /** The last state applied, re-applied when native describes new tracks. */
  private last: NativeState | null = null;
  /** Up next as last built, and what it was built from: reused while nothing changed (ticks). */
  private builtFrom = '';
  private lowListeners = new Set<(e: QueueLow) => void>();
  /**
   * After playList: the track native should report next. Events still describing the
   * old queue (sent before setQueue landed) are ignored until then, so the optimistic
   * state doesn't flicker back to the previous track.
   */
  private expect: { id: string; until: number } | null = null;

  constructor() {
    const fail = (e: unknown) => logError('player.listen', e);
    JukePlayer.addListener('state', (st) => this.onState(st)).catch(fail);
    JukePlayer.addListener('trackError', (e) => {
      const t = this.resolve(String(e?.trackId ?? ''));
      if (e?.skipped) toast(`Skipped "${t.title}": unavailable`);
      else toast(`Can't play "${t.title}"`);
    }).catch(fail);
    JukePlayer.addListener('queueLow', (e) => {
      const ev: QueueLow = { left: Math.max(0, Number(e?.left) || 0), seedId: typeof e?.seedId === 'string' ? e.seedId : null };
      for (const cb of this.lowListeners) cb(ev);
    }).catch(fail);
    JukePlayer.addListener('tracks', (e) => {
      let added = false;
      for (const raw of Array.isArray(e?.tracks) ? e.tracks : []) {
        const t = fromNative(raw);
        if (t && !this.known.has(t.id)) {
          this.known.set(t.id, t);
          added = true;
        }
      }
      if (added && this.last) {
        this.builtFrom = '';
        this.apply(this.last);
      }
    }).catch(fail);
    JukePlayer.getState()
      .then((st) => this.onState(st))
      .catch((e) => logError('player.getState', e));
  }

  private onState(raw: unknown): void {
    const st = parseNativeState(raw, this.lastQueueIds);
    if (!st) return;
    this.lastQueueIds = st.queueIds;
    if (this.expect) {
      if (st.trackId !== this.expect.id && performance.now() < this.expect.until) return;
      this.expect = null;
    }
    this.apply(st);
  }

  private remember(tracks: Track[]): void {
    for (const t of tracks) this.known.set(t.id, t);
  }

  private resolve(id: string): Track {
    return this.known.get(id) ?? knownTrack(id) ?? placeholder(id);
  }

  private apply(st: NativeState): void {
    this.last = st;
    const prev = this.s.value;
    // Position ticks change nothing below: keep the same arrays and objects, so the
    // computeds built on them (upNextSections, playContext) don't change either.
    const from = `${st.index}|${st.queueIds.join(',')}|${st.upNextIds.join(',')}|${st.upNextKinds}|${st.seedId}`;
    let { queue, upNext, seed } = prev;
    if (from !== this.builtFrom) {
      this.builtFrom = from;
      queue = st.queueIds.map((id) => this.resolve(id));
      const index = st.index >= 0 && st.index < queue.length ? st.index : -1;
      // Map upNext ids back to list indices; with duplicate ids, use each list slot once.
      const used = new Set<number>([index]);
      upNext = [];
      st.upNextIds.forEach((id, k) => {
        let i = -1;
        for (let j = 0; j < st.queueIds.length; j++) {
          if (st.queueIds[j] === id && !used.has(j)) {
            i = j;
            break;
          }
        }
        if (i < 0) return;
        used.add(i);
        const kind = st.upNextKinds[k];
        upNext.push({ track: queue[i], index: i, ...(kind === 'q' && { queued: true }), ...(kind === 'a' && { auto: true }) });
      });
      seed = st.seedId ? (prev.seed?.id === st.seedId ? prev.seed : this.resolve(st.seedId)) : null;
    }
    const index = st.index >= 0 && st.index < queue.length ? st.index : -1;
    const c = st.context;
    const context = !c ? null : prev.context && prev.context.label === c.label && prev.context.mode === c.mode ? prev.context : c;
    this.s.value = {
      queue,
      index,
      current: index >= 0 ? queue[index] : null,
      isPlaying: st.isPlaying,
      isBuffering: st.isBuffering,
      positionMs: st.positionMs,
      durationMs: st.durationMs,
      sampledAt: performance.now(),
      shuffle: st.shuffle,
      repeat: st.repeat,
      upNext,
      context,
      seed,
    };
  }

  async playList(all: Track[], startIndex: number, ctx: PlayContext = LIST_CONTEXT): Promise<void> {
    // Native refuses the whole list over one bad id: drop those, keeping the start track's place.
    const start = all[Math.max(0, Math.min(startIndex, all.length - 1))];
    // A radio plays the tapped track, then autoplay: the rest of the list isn't queued.
    const tracks = playable(ctx.mode === 'radio' && start ? [start] : all);
    if (!tracks.length) {
      if (all.length) toast("Can't play this track");
      return;
    }
    startIndex = Math.max(0, start ? tracks.indexOf(start) : 0);
    this.remember(tracks);
    const i = Math.max(0, Math.min(startIndex, tracks.length - 1));
    // Optimistic: show the mini player immediately; native state events follow. Queued
    // tracks stay next (P1).
    const queued = this.s.value.upNext.filter((u) => u.queued).map((u) => u.track);
    const queue = [...tracks.slice(0, i + 1), ...queued, ...tracks.slice(i + 1)];
    const context: PlayContext = { label: ctx.label, mode: ctx.mode };
    this.builtFrom = '';
    this.s.value = {
      ...this.s.value,
      queue,
      index: i,
      current: tracks[i],
      isPlaying: true,
      isBuffering: true,
      positionMs: 0,
      durationMs: 0,
      sampledAt: performance.now(),
      upNext: queue.slice(i + 1, i + 51).map((track, k) => ({ track, index: i + 1 + k, ...(k < queued.length && { queued: true }) })),
      context,
      seed: tracks[i],
    };
    this.expect = { id: tracks[i].id, until: performance.now() + EXPECT_MS };
    try {
      await JukePlayer.setQueue({ tracks: tracks.map(toNative), startIndex: i, playWhenReady: true, context });
    } catch (e) {
      // Native never took the list: show what it actually has again.
      this.expect = null;
      JukePlayer.getState()
        .then((st) => this.onState(st))
        .catch(() => {});
      throw e;
    }
  }

  play = () => JukePlayer.play();
  pause = () => JukePlayer.pause();
  toggle = () => (this.s.value.isPlaying ? JukePlayer.pause() : JukePlayer.play());
  next = () => JukePlayer.skipToNext();
  prev = () => JukePlayer.skipToPrevious();

  async seek(positionMs: number): Promise<void> {
    this.s.value = { ...this.s.value, positionMs, sampledAt: performance.now() };
    await JukePlayer.seekTo({ positionMs: Math.round(positionMs) });
  }

  skipTo = (index: number) => JukePlayer.skipToIndex({ index });
  setShuffle = (enabled: boolean) => JukePlayer.setShuffle({ enabled });
  setRepeat = (mode: RepeatMode) => JukePlayer.setRepeat({ mode });
  move = (from: number, to: number) => JukePlayer.moveItem({ from, to });
  remove = (index: number) => JukePlayer.removeItem({ index });

  async addToQueue(all: Track[]): Promise<void> {
    const tracks = playable(all);
    if (!tracks.length) {
      if (all.length) toast("Can't play this track");
      return;
    }
    if (this.s.value.index < 0) return this.playList(tracks, 0);
    this.remember(tracks);
    await JukePlayer.queueNext({ tracks: tracks.map(toNative) });
  }

  async addAutoplay(all: Track[], seedId: string): Promise<void> {
    const tracks = playable(all);
    if (!tracks.length) return;
    this.remember(tracks);
    await JukePlayer.addAutoplay({ tracks: tracks.map(toNative), seedId });
  }

  setAutoplay = (enabled: boolean) => JukePlayer.setAutoplay({ enabled });

  onQueueLow(cb: (e: QueueLow) => void): () => void {
    this.lowListeners.add(cb);
    return () => this.lowListeners.delete(cb);
  }

  setQuality = (quality: 'high' | 'low') => JukePlayer.setQuality({ quality });
  setNetworkPrefs = (prefs: { preferIpv4: boolean }) => JukePlayer.setNetworkPrefs({ preferIpv4: prefs.preferIpv4 === true });
}

/** Tracks native accepts (a valid 11-character video id). */
function playable(tracks: Track[]): Track[] {
  return tracks.filter((t) => YT_ID_RE.test(t.ytId));
}

/** How long playList waits for native to report the new track before trusting events again. */
const EXPECT_MS = 4000;
