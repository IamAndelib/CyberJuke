/**
 * Player backed by the native JukePlayer plugin. The native side owns the queue;
 * this class only forwards commands and mirrors native state from events.
 */
import { computed, effect, signal, untracked } from '@preact/signals';
import { UNKNOWN_ARTIST, UNTITLED, artworkUrl, type Track } from '../data/model';
import { history, knownTrack, liked, IPV4_MODES, type Ipv4Mode } from '../stores/library';
import { catalog } from '../stores/catalog';
import { toast } from '../stores/toast';
import { YT_ID_RE, parseNativeState } from '../core/guards';
import { logError } from '../core/log';
import { BRIDGE_MAX_ITEMS, BRIDGE_MAX_STRING, JukePlayer, STALE_INDEX, type NativeState, type NativeTrack, type RepeatMode } from './native';
import { EMPTY_STATE, LIST_CONTEXT, livePosition, type NetStatus, type PlayContext, type Player, type PlayerState, type QueueLow, type UpNextItem, type UpNextKind } from './types';

/** K6: text native would refuse as too long is cut (a link that long is dropped). */
const clip = (s: string) => (s.length > BRIDGE_MAX_STRING ? s.slice(0, BRIDGE_MAX_STRING) : s);
const link = (s: string) => (s.length > BRIDGE_MAX_STRING ? '' : s);

export function toNative(t: Track): NativeTrack {
  return {
    id: t.id,
    ytId: t.ytId,
    title: clip(t.title),
    artist: clip(t.artist),
    artworkUrl: link(t.artworkUrl),
    by: clip(t.by),
    postUrl: link(t.postUrl),
    ...(t.membersOnly && { membersOnly: true }),
  };
}

/** K6: at most BRIDGE_MAX_ITEMS tracks, a window around `start`; returns them and where `start` is in it. */
export function bridgeWindow<T>(items: T[], start: number): { items: T[]; start: number } {
  if (items.length <= BRIDGE_MAX_ITEMS) return { items, start };
  const lo = Math.max(0, Math.min(start - Math.floor(BRIDGE_MAX_ITEMS / 2), items.length - BRIDGE_MAX_ITEMS));
  return { items: items.slice(lo, lo + BRIDGE_MAX_ITEMS), start: start - lo };
}

/** Native refused an index command: the list changed under it (K2). */
function isStale(e: unknown): boolean {
  const o = (e ?? {}) as { code?: unknown; message?: unknown };
  return o.code === STALE_INDEX || (typeof o.message === 'string' && o.message.includes(STALE_INDEX));
}

/** Catalog tracks by id: native state after the WebView was recreated carries only ids. */
const catalogById = computed(() => new Map(catalog.all.value.map((t) => [t.id, t])));

/**
 * A track native describes in its `tracks` event: one it added itself (Global radio), or one
 * of the last session it restored after a restart (the app may know it no more).
 */
function fromNative(t: NativeTrack): Track | null {
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.ytId !== 'string' || !YT_ID_RE.test(t.ytId)) return null;
  return {
    id: t.id,
    ytId: t.ytId,
    title: typeof t.title === 'string' && t.title ? t.title : UNTITLED,
    artist: typeof t.artist === 'string' && t.artist ? t.artist : UNKNOWN_ARTIST,
    genre: '',
    by: typeof t.by === 'string' ? t.by : '',
    postTitle: '',
    postUrl: typeof t.postUrl === 'string' ? t.postUrl : '',
    createdAt: '',
    nsfw: false,
    artworkUrl: artworkUrl(t.ytId),
    ...(t.membersOnly === true && { membersOnly: true }),
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
  /** Tracks native described itself (`tracks`): used when nothing better knows the id. */
  private described = new Map<string, Track>();
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
  /** Edits (move, remove, ...) sent and not answered yet: state events from before them are held back. */
  private edits = 0;
  /** Some track in the last state resolved to a placeholder. */
  private unresolved = false;

  constructor() {
    const fail = (e: unknown) => logError('player.listen', e);
    // `tracks` first (K4): native re-announces the tracks it added when a listener comes.
    JukePlayer.addListener('tracks', (e) => {
      let added = false;
      for (const raw of Array.isArray(e?.tracks) ? e.tracks : []) {
        const t = fromNative(raw);
        if (t && !this.described.has(t.id)) {
          this.described.set(t.id, t);
          added = true;
        }
      }
      if (added && this.last) {
        this.builtFrom = '';
        this.apply(this.last);
      }
    }).catch(fail);
    JukePlayer.addListener('state', (st) => this.onState(st)).catch(fail);
    JukePlayer.addListener('trackError', (e) => {
      const id = String(e?.trackId ?? '');
      const t = this.resolve(id);
      if (e?.skipped) toast(`Skipped "${t.title}": unavailable`);
      else toast(`Can't play "${t.title}"`);
      // The track playList started was skipped: native won't report it, so stop waiting.
      if (this.expect?.id === id) {
        this.expect = null;
        this.resync();
      }
    }).catch(fail);
    JukePlayer.addListener('queueLow', (e) => {
      const ev: QueueLow = { left: Math.max(0, Number(e?.left) || 0), seedId: typeof e?.seedId === 'string' ? e.seedId : null };
      for (const cb of this.lowListeners) cb(ev);
    }).catch(fail);
    // Liked, history or the catalog loading can name tracks shown as "Unknown track".
    effect(() => {
      void liked.value;
      void history.value;
      void catalogById.value;
      untracked(() => {
        if (!this.unresolved || !this.last) return;
        this.builtFrom = '';
        this.apply(this.last);
      });
    });
    JukePlayer.getState()
      .then((st) => this.onState(st))
      .catch((e) => logError('player.getState', e));
  }

  private onState(raw: unknown): void {
    const st = parseNativeState(raw, this.lastQueueIds);
    if (!st) return;
    this.lastQueueIds = st.queueIds;
    // May describe the list from before an edit in flight; resynced once they're answered.
    if (this.edits > 0) return;
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
    return this.known.get(id) ?? knownTrack(id) ?? catalogById.peek().get(id) ?? this.described.get(id) ?? placeholder(id);
  }

  private resync(): void {
    JukePlayer.getState()
      .then((st) => this.onState(st))
      .catch((e) => logError('player.getState', e));
  }

  /**
   * An index command: `local` applies it to the state shown at once (the next tap
   * sees the new indices), and native events are held back until it's answered. A
   * stale index (K2) changes nothing and isn't an error.
   */
  private async edit(send: () => Promise<void>, local?: () => void): Promise<void> {
    this.edits++;
    try {
      local?.();
      await send();
    } catch (e) {
      if (!isStale(e)) throw e;
    } finally {
      if (--this.edits === 0) this.resync();
    }
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
      // A placeholder, or a track only native described (no genre, no post): named again
      // once Liked, history or the catalog know it.
      this.unresolved = queue.some((t) => !t.ytId || this.described.get(t.id) === t);
      const index = st.index >= 0 && st.index < queue.length ? st.index : -1;
      // Up next rows by the list index native gives (K1). Without one (an older native),
      // the id's next unused slot after the current track, then from the top.
      const used = new Set<number>([index]);
      const n = st.queueIds.length;
      upNext = [];
      st.upNextIds.forEach((id, k) => {
        let i = st.upNextIndex[k] ?? -1;
        if (i < 0 || used.has(i)) {
          i = -1;
          for (let step = 1; step <= n; step++) {
            const j = (index + step + n) % n;
            if (st.queueIds[j] === id && !used.has(j)) {
              i = j;
              break;
            }
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
    const at = Math.max(0, Math.min(startIndex, all.length - 1));
    // A list starts at the tapped track, or the next one that plays.
    const start = ctx.mode === 'radio' ? all[at] : all.find((t, j) => j >= at && isPlayable(t));
    // A radio plays the tapped track, then autoplay: the rest of the list isn't queued.
    const ok = start && isPlayable(start) ? playable(ctx.mode === 'radio' ? [start] : all) : [];
    if (!ok.length) {
      if (all.length) toast("Can't play this track");
      return;
    }
    // K6: at most BRIDGE_MAX_ITEMS, around the start track.
    const win = bridgeWindow(ok, Math.max(0, ok.indexOf(start!)));
    const tracks = win.items;
    const i = win.start;
    this.remember(tracks);
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
  /**
   * Shown at once (the position held where it is), so a quick second tap undoes the first
   * instead of repeating it before native's state comes back. Native's state is read back
   * after it (a play refused during a back-off changes nothing there, so sends no event).
   */
  toggle = () => {
    const s = this.s.value;
    const now = performance.now();
    this.s.value = { ...s, isPlaying: !s.isPlaying, isBuffering: false, positionMs: livePosition(s, now), sampledAt: now };
    return (s.isPlaying ? JukePlayer.pause() : JukePlayer.play()).finally(() => this.resync());
  };
  next = () => JukePlayer.skipToNext();
  prev = () => JukePlayer.skipToPrevious();

  async seek(positionMs: number): Promise<void> {
    this.s.value = { ...this.s.value, positionMs, sampledAt: performance.now() };
    await JukePlayer.seekTo({ positionMs: Math.round(positionMs) });
  }

  skipTo = (index: number, expectId?: string) => this.edit(() => JukePlayer.skipToIndex({ index, ...(expectId != null && { expectId }) }));
  setShuffle = (enabled: boolean) => JukePlayer.setShuffle({ enabled });
  setRepeat = (mode: RepeatMode) => JukePlayer.setRepeat({ mode });

  move(from: number, to: number, expectId?: string): Promise<void> {
    return this.edit(
      () => JukePlayer.moveItem({ from, to, ...(expectId != null && { expectId }) }),
      () => this.showMoved(from, to, expectId),
    );
  }

  remove(index: number, expectId?: string): Promise<void> {
    return this.edit(
      () => JukePlayer.removeItem({ index, ...(expectId != null && { expectId }) }),
      () => this.showRemoved(index, expectId),
    );
  }

  /** The move as native will make it, shown now (unshuffled: play order is list order). */
  private showMoved(from: number, to: number, expectId?: string): void {
    const s = this.s.value;
    const n = s.queue.length;
    if (s.shuffle || from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    if (expectId != null && s.queue[from].id !== expectId) return;
    const queue = s.queue.slice();
    queue.splice(to, 0, ...queue.splice(from, 1));
    const map = (j: number) => (j === from ? to : from < to ? (j > from && j <= to ? j - 1 : j) : j >= to && j < from ? j + 1 : j);
    const upNext = s.upNext.slice();
    const kf = upNext.findIndex((u) => u.index === from);
    const kt = upNext.findIndex((u) => u.index === to);
    if (kf >= 0 && kt >= 0) upNext.splice(kt, 0, ...upNext.splice(kf, 1));
    this.show(queue, map(s.index), upNext.map((u) => ({ ...u, index: map(u.index) })));
  }

  /** A remove of an Up next row, shown now. */
  private showRemoved(index: number, expectId?: string): void {
    const s = this.s.value;
    if (index < 0 || index >= s.queue.length || index === s.index) return;
    if (expectId != null && s.queue[index].id !== expectId) return;
    const queue = s.queue.filter((_, j) => j !== index);
    const map = (j: number) => (j > index ? j - 1 : j);
    this.show(
      queue,
      map(s.index),
      s.upNext.filter((u) => u.index !== index).map((u) => ({ ...u, index: map(u.index) })),
    );
  }

  private show(queue: Track[], index: number, upNext: UpNextItem[]): void {
    this.builtFrom = '';
    this.s.value = { ...this.s.value, queue, index, current: queue[index] ?? null, upNext };
  }

  async removeIds(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    for (let k = 0; k < unique.length; k += BRIDGE_MAX_ITEMS) await JukePlayer.removeIds({ ids: unique.slice(k, k + BRIDGE_MAX_ITEMS) });
  }

  async addToQueue(all: Track[]): Promise<void> {
    const tracks = playable(all).slice(0, BRIDGE_MAX_ITEMS);
    if (!tracks.length) {
      if (all.length) toast("Can't play this track");
      return;
    }
    if (this.s.value.index < 0) return this.playList(tracks, 0);
    this.remember(tracks);
    await JukePlayer.queueNext({ tracks: tracks.map(toNative) });
  }

  async restore(track: Track, kind: UpNextKind, beforeId: string | null): Promise<void> {
    if (!isPlayable(track)) return;
    if (this.s.value.index < 0) return this.playList([track], 0);
    this.remember([track]);
    await JukePlayer.restore({ track: toNative(track), kind, beforeId });
  }

  async addAutoplay(all: Track[], seedId: string): Promise<void> {
    const tracks = playable(all).slice(0, BRIDGE_MAX_ITEMS);
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
  setNetworkPrefs = (prefs: { ipv4: Ipv4Mode }) => JukePlayer.setNetworkPrefs({ ipv4: prefs.ipv4 });
  retryNow = () => JukePlayer.retryNow();

  async netStatus(): Promise<NetStatus | null> {
    const s = await JukePlayer.getNetStatus();
    if (!s || typeof s !== 'object') return null;
    const l = s.lastLimit;
    return {
      family: s.family === 'IPv4' || s.family === 'IPv6' ? s.family : undefined,
      ipv4: IPV4_MODES.includes(s.ipv4 as Ipv4Mode) ? (s.ipv4 as Ipv4Mode) : 'auto',
      autoIpv4: s.autoIpv4 === true,
      lastLimit:
        l && Number.isFinite(Number(l.at)) && typeof l.reason === 'string'
          ? { at: Number(l.at), reason: l.reason, surface: l.surface === 'music' ? 'music' : 'playback' }
          : undefined,
    };
  }
}

/** A track native accepts (a valid 11-character video id, an id it takes). */
function isPlayable(t: Track): boolean {
  return YT_ID_RE.test(t.ytId) && !!t.id && t.id.length <= BRIDGE_MAX_STRING;
}

function playable(tracks: Track[]): Track[] {
  return tracks.filter(isPlayable);
}

/** How long playList waits for native to report the new track before trusting events again. */
const EXPECT_MS = 4000;
