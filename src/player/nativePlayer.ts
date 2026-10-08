/**
 * Player backed by the native JukePlayer plugin. The native side owns the queue;
 * this class only forwards commands and mirrors native state from events.
 */
import { signal } from '@preact/signals';
import type { Track } from '../data/model';
import { knownTrack } from '../store/library';
import { toast } from '../store/toast';
import { parseNativeState } from '../core/guards';
import { logError } from '../core/log';
import { JukePlayer, type NativeState, type NativeTrack, type RepeatMode } from './native';
import { EMPTY_STATE, type Player, type PlayerState, type UpNextItem } from './types';

export function toNative(t: Track): NativeTrack {
  return { id: t.id, ytId: t.ytId, title: t.title, artist: t.artist, artworkUrl: t.artworkUrl, by: t.by, postUrl: t.postUrl };
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
  /** Ids added with queueNext that haven't played yet, oldest first. */
  private queuedIds: string[] = [];
  /** The last full list native sent (events with queueIdsUnchanged omit it). */
  private lastQueueIds: string[] = [];
  /**
   * After playList: the track native should report next. Events still describing the
   * old queue (sent before setQueue landed) are ignored until then, so the optimistic
   * state doesn't flicker back to the previous track.
   */
  private expect: { id: string; until: number } | null = null;

  constructor() {
    JukePlayer.addListener('state', (st) => this.onState(st)).catch((e) => logError('player.listen', e));
    JukePlayer.addListener('trackError', (e) => {
      const t = this.resolve(String(e?.trackId ?? ''));
      if (e?.skipped) toast(`Skipped "${t.title}": unavailable`);
      else toast(`Can't play "${t.title}"`);
    }).catch((e) => logError('player.listen', e));
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
    const queue = st.queueIds.map((id) => this.resolve(id));
    const index = st.index >= 0 && st.index < queue.length ? st.index : -1;
    // A queued track that started playing, or left the list, is no longer "queued".
    // Skipping past queued tracks keeps them queued (they stay next: see queue.ts).
    if (this.queuedIds.length) {
      const inList = new Set(st.queueIds);
      const cur = this.queuedIds.indexOf(st.trackId ?? '');
      if (cur >= 0) this.queuedIds.splice(cur, 1);
      this.queuedIds = this.queuedIds.filter((id) => inList.has(id));
    }
    const pending = this.queuedIds.slice();
    // Map upNext ids back to list indices; with duplicate ids, use each list slot once.
    const used = new Set<number>([index]);
    const upNext: UpNextItem[] = [];
    for (const id of st.upNextIds) {
      let i = -1;
      for (let k = 0; k < st.queueIds.length; k++) {
        if (st.queueIds[k] === id && !used.has(k)) {
          i = k;
          break;
        }
      }
      if (i < 0) continue;
      used.add(i);
      // The leading run of user-queued tracks, in the order they were added.
      const queued = pending.length > 0 && pending[0] === id && upNext.every((u) => u.queued);
      if (queued) pending.shift();
      upNext.push({ track: queue[i], index: i, ...(queued && { queued: true }) });
    }
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
    };
  }

  async playList(tracks: Track[], startIndex: number): Promise<void> {
    if (!tracks.length) return;
    this.remember(tracks);
    this.queuedIds = [];
    const i = Math.max(0, Math.min(startIndex, tracks.length - 1));
    // Optimistic: show the mini player immediately; native state events follow.
    this.s.value = {
      ...this.s.value,
      queue: tracks,
      index: i,
      current: tracks[i],
      isPlaying: true,
      isBuffering: true,
      positionMs: 0,
      durationMs: 0,
      sampledAt: performance.now(),
      upNext: tracks.slice(i + 1, i + 51).map((track, k) => ({ track, index: i + 1 + k })),
    };
    this.expect = { id: tracks[i].id, until: performance.now() + EXPECT_MS };
    try {
      await JukePlayer.setQueue({ tracks: tracks.map(toNative), startIndex: i, playWhenReady: true });
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

  async addToQueue(tracks: Track[]): Promise<void> {
    if (!tracks.length) return;
    if (this.s.value.index < 0) return this.playList(tracks, 0);
    this.remember(tracks);
    this.queuedIds.push(...tracks.map((t) => t.id));
    await JukePlayer.queueNext({ tracks: tracks.map(toNative) });
  }

  setQuality = (quality: 'high' | 'low') => JukePlayer.setQuality({ quality });
  setNetworkPrefs = (prefs: { preferIpv4: boolean }) => JukePlayer.setNetworkPrefs({ preferIpv4: prefs.preferIpv4 === true });
}

/** How long playList waits for native to report the new track before trusting events again. */
const EXPECT_MS = 4000;
