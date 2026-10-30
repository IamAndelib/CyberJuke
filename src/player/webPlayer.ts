/**
 * Browser player for development and e2e tests: a hidden YouTube IFrame player
 * driven by the pure Queue model.
 */
import { signal } from '@preact/signals';
import type { Track } from '../data/model';
import { block } from '../stores/block';
import { toast } from '../stores/toast';
import { TEST_HOOKS, exposeForTests } from '../core/testHooks';
import { UNTITLED } from '../data/model';
import { trackErrorText, type TrackErrorFacts } from './errorText';
import { Queue } from './queue';
import { stationPlaying } from './radio';
import type { RepeatMode } from './native';
import type { CrossfadeMs, Ipv4Mode, Quality } from '../stores/library';
import { AUTOPLAY_LOW, EMPTY_STATE, mayAutoplay, LIST_CONTEXT, livePosition, wantsPlay, type NetStatus, type PlayContext, type Player, type PlayerState, type QueueLow, type UpNextKind } from './types';

/* Minimal typings for the parts of the IFrame API we use. */
interface YTPlayer {
  loadVideoById(id: string, startSeconds?: number): void;
  cueVideoById(id: string): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  /** How much of the video is loaded, 0 to 1. */
  getVideoLoadedFraction?(): number;
  setPlaybackQuality?(q: string): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      width: number;
      height: number;
      videoId?: string;
      playerVars?: Record<string, number | string>;
      events: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
    /** e2e only: native-equivalent player calls made by the web player. */
    __cyberjukePlayerCalls?: unknown[][];
    __cyberjukeNetStatus?: NetStatus;
  }
}

const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;
/** Codes where the video can never play here (removed, private, embedding disabled). */
const SKIP_ERROR_CODES = new Set([100, 101, 150]);

let apiPromise: Promise<YTNamespace> | null = null;
function loadApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT!);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('Player failed to load'));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export class WebPlayer implements Player {
  readonly kind = 'web' as const;
  private readonly s = signal<PlayerState>({ ...EMPTY_STATE });
  readonly state = this.s;
  private q = new Queue<Track>();
  private yt: YTPlayer | null = null;
  private ytReady: Promise<YTPlayer> | null = null;
  /** Jukebox MP3s play in an audio element (the IFrame player plays only YouTube). */
  private audio: HTMLAudioElement | null = null;
  /** What's loaded: a video id or an MP3 link. */
  private loadedId: string | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** The current list's context (one object per playList). */
  private context: PlayContext | null = null;
  /** The track autoplay follows. */
  private seed: Track | null = null;
  private autoplayOn = true;
  private lowListeners = new Set<(e: QueueLow) => void>();
  /** The low state last announced, so each one is announced once. */
  private lowKey: string | null = null;

  constructor() {
    // The browser player never waits for the network (waitingForNetwork stays false); e2e
    // drives native's "waiting for carrier" state through this.
    exposeForTests('__cyberjukeWaitingForNetwork', (on: boolean) => this.publish({ waitingForNetwork: on }));
    // Nor does it send `trackError`; e2e injects what native would say about the current track.
    exposeForTests('__cyberjukeTrackError', (e: TrackErrorFacts) => toast(trackErrorText(e, this.q.current?.title ?? UNTITLED)));
    // e2e: how much audio native would report loaded ahead (0: the track the app reopens on).
    exposeForTests('__cyberjukeBufferedAhead', (ms: number) => this.publish({ bufferedAheadMs: ms }));
  }

  /** How much of the loaded video is past the playhead, in ms (native's bufferedAheadMs). */
  private loadedAhead(yt: YTPlayer): number {
    const loadedTo = (yt.getVideoLoadedFraction?.() ?? 0) * (yt.getDuration() || 0);
    return Math.max(0, Math.round((loadedTo - yt.getCurrentTime()) * 1000));
  }

  /** The current track is a Jukebox MP3, loaded in the audio element. */
  private onMp3(): boolean {
    const t = this.q.current;
    return !!t?.mp3 && !!this.audio && this.loadedId === t.mp3;
  }

  /** Position and buffer of the audio element, as the IFrame player's are sampled. */
  private audioSample(a: HTMLAudioElement): Pick<PlayerState, 'positionMs' | 'sampledAt' | 'bufferedAheadMs'> {
    const pos = a.currentTime;
    let loadedTo = pos;
    for (let i = 0; i < a.buffered.length; i++) if (a.buffered.start(i) <= pos + 0.5) loadedTo = Math.max(loadedTo, a.buffered.end(i));
    return { positionMs: Math.round(pos * 1000), sampledAt: performance.now(), bufferedAheadMs: Math.max(0, Math.round((loadedTo - pos) * 1000)) };
  }

  private audioEl(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const a = new Audio();
    a.preload = 'auto';
    const duration = () => (Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
    // Events of a track that's no longer current (a skip mid-load) are ignored.
    const on = (type: string, fn: () => void) => a.addEventListener(type, () => this.onMp3() && fn());
    on('playing', () => {
      this.publish({ isPlaying: true, isBuffering: false, durationMs: duration(), ...this.audioSample(a) });
      this.startPoll();
    });
    on('pause', () => {
      if (a.ended) return;
      this.stopPoll();
      this.publish({ isPlaying: false, isBuffering: false, ...this.audioSample(a) });
    });
    on('waiting', () => this.publish({ isBuffering: true, ...this.audioSample(a) }));
    on('durationchange', () => this.publish({ durationMs: duration() }));
    on('ended', () => {
      this.stopPoll();
      this.advance(true);
    });
    on('error', () => {
      toast(`Skipped "${this.q.current?.title ?? UNTITLED}": unavailable`);
      this.advance(false, true);
    });
    this.audio = a;
    return a;
  }

  private playAudio(a: HTMLAudioElement): void {
    // A new src rejects the previous play() (AbortError) after the next one was asked for: that
    // one is not about the track now loading. Only a refusal of this track's play shows paused.
    const src = this.loadedId;
    a.play().catch((e: unknown) => {
      if ((e as { name?: unknown } | null)?.name === 'AbortError' || !this.onMp3() || this.loadedId !== src) return;
      this.publish({ isPlaying: false, isBuffering: false });
    });
  }

  private publish(patch: Partial<PlayerState> = {}): void {
    const prev = this.s.value;
    const index = this.q.index;
    const upIdx = this.q.upNextIndices();
    const items = this.q.items;
    const queued = this.q.queuedCount;
    this.s.value = {
      ...prev,
      queue: items,
      index,
      current: this.q.current,
      shuffle: this.q.shuffle,
      repeat: this.q.repeat,
      upNext: upIdx.map((i, k) =>
        k < queued ? { track: items[i], index: i, queued: true } : this.q.isAuto(i) ? { track: items[i], index: i, auto: true } : { track: items[i], index: i },
      ),
      context: this.context,
      seed: this.seed,
      ...patch,
    };
    this.checkLow();
  }

  /** More follows the list for [seedId]: Autoplay on, or a Signal Radio station playing (always). */
  private keepsGoing(seedId: string | undefined): boolean {
    return this.autoplayOn || !!stationPlaying(this.context, seedId);
  }

  /** AP4, inline: with 5 tracks or fewer to go, ask for more (once per state). */
  private checkLow(): void {
    const seed = this.seed;
    if (!seed || !this.keepsGoing(seed.id) || !mayAutoplay(this.q.repeat, this.q.length) || !this.q.current) {
      this.lowKey = null;
      return;
    }
    const left = this.q.ahead;
    if (left > AUTOPLAY_LOW) {
      this.lowKey = null;
      return;
    }
    const key = `${seed.id}|${left}|${this.q.index}|${this.q.length}`;
    if (key === this.lowKey) return;
    this.lowKey = key;
    const ev: QueueLow = { left, seedId: seed.id };
    queueMicrotask(() => {
      for (const cb of this.lowListeners) cb(ev);
    });
  }

  private host(): HTMLElement {
    let el = document.getElementById('yt-host');
    if (!el) {
      const wrap = document.createElement('div');
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none;overflow:hidden;z-index:-1';
      el = document.createElement('div');
      el.id = 'yt-host';
      wrap.appendChild(el);
      document.body.appendChild(wrap);
    }
    return el;
  }

  private ensurePlayer(): Promise<YTPlayer> {
    if (this.ytReady) return this.ytReady;
    this.ytReady = loadApi().then(
      (YT) =>
        new Promise<YTPlayer>((resolve) => {
          const p = new YT.Player(this.host(), {
            width: 2,
            height: 2,
            playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0 },
            events: {
              onReady: () => {
                this.yt = p;
                resolve(p);
              },
              onStateChange: (e) => this.onYtState(e.data),
              onError: (e) => this.onYtError(e.data),
            },
          });
        }),
    );
    this.ytReady.catch(() => {
      this.ytReady = null;
      this.publish({ isPlaying: false, isBuffering: false });
      toast('Player unavailable');
    });
    return this.ytReady;
  }

  private onYtState(code: number): void {
    const yt = this.yt;
    if (!yt) return;
    // An MP3 is playing: the paused video's events aren't about it, but a video still loading
    // when it took over must not start under it.
    if (this.q.current?.mp3) {
      if (code === YT_PLAYING) yt.pauseVideo();
      return;
    }
    const now = performance.now();
    if (code === YT_PLAYING) {
      this.publish({
        isPlaying: true,
        isBuffering: false,
        durationMs: Math.round((yt.getDuration() || 0) * 1000),
        positionMs: Math.round(yt.getCurrentTime() * 1000),
        sampledAt: now,
        bufferedAheadMs: this.loadedAhead(yt),
      });
      this.startPoll();
    } else if (code === YT_PAUSED) {
      this.stopPoll();
      this.publish({ isPlaying: false, isBuffering: false, positionMs: Math.round(yt.getCurrentTime() * 1000), sampledAt: now, bufferedAheadMs: this.loadedAhead(yt) });
    } else if (code === YT_BUFFERING) {
      this.publish({ isBuffering: true, positionMs: Math.round(yt.getCurrentTime() * 1000), sampledAt: now, bufferedAheadMs: this.loadedAhead(yt) });
    } else if (code === YT_ENDED) {
      this.stopPoll();
      this.advance(true);
    }
  }

  private onYtError(code: number): void {
    const t = this.q.current;
    if (t?.mp3) return;
    const name = t ? `"${t.title}"` : 'track';
    if (SKIP_ERROR_CODES.has(code) || code === 2 || code === 5) {
      toast(`Skipped ${name}: unavailable`);
      this.advance(false, true);
    }
  }

  private startPoll(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      // Positions are interpolated between samples; no need to sample a hidden page.
      if (document.hidden) return;
      if (this.onMp3()) this.s.value = { ...this.s.value, ...this.audioSample(this.audio!) };
      else if (this.yt) this.s.value = { ...this.s.value, positionMs: Math.round(this.yt.getCurrentTime() * 1000), sampledAt: performance.now(), bufferedAheadMs: this.loadedAhead(this.yt) };
    }, 1000);
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** Load the queue's current track into the IFrame player (an MP3 into the audio element). */
  private async loadCurrent(autoplay: boolean, force = false): Promise<void> {
    const t = this.q.current;
    if (!t) {
      this.stopPoll();
      this.yt?.pauseVideo();
      this.audio?.pause();
      this.loadedId = null;
      this.publish({ isPlaying: false, isBuffering: false, positionMs: 0, durationMs: 0, bufferedAheadMs: 0 });
      return;
    }
    this.publish({ isPlaying: autoplay, isBuffering: autoplay, positionMs: 0, durationMs: 0, sampledAt: performance.now(), bufferedAheadMs: 0 });
    if (t.mp3) {
      this.yt?.pauseVideo();
      const a = this.audioEl();
      if (this.loadedId !== t.mp3 || force) {
        this.loadedId = t.mp3;
        a.src = t.mp3;
      }
      if (autoplay) this.playAudio(a);
      return;
    }
    this.audio?.pause();
    let yt: YTPlayer;
    try {
      yt = await this.ensurePlayer();
    } catch {
      return;
    }
    if (this.q.current !== t) return; // superseded while loading
    // Paused while the player was loading: respect it (the pause already published).
    const play = autoplay && this.s.value.isPlaying;
    if (this.loadedId === t.ytId && !force) {
      if (play) yt.playVideo();
      return;
    }
    this.loadedId = t.ytId;
    if (play) yt.loadVideoById(t.ytId);
    else yt.cueVideoById(t.ytId);
  }

  private advance(auto: boolean, afterError = false): void {
    const before = this.q.current;
    const n = this.q.next(auto);
    if (!n) {
      this.publish({ isPlaying: false, isBuffering: false });
      return;
    }
    if (afterError && n === before) {
      // Repeat-one on a broken track: stop instead of looping on the error.
      this.publish({ isPlaying: false, isBuffering: false });
      return;
    }
    void this.loadCurrent(true, n === before);
  }

  async playList(tracks: Track[], startIndex: number, ctx: PlayContext = LIST_CONTEXT): Promise<void> {
    if (!tracks.length) return;
    const i = Math.max(0, Math.min(startIndex, tracks.length - 1));
    // A radio plays the tapped track, then autoplay: the rest of the list isn't queued.
    if (ctx.mode === 'radio') this.q.setList([tracks[i]], 0);
    else this.q.setList(tracks, i);
    this.context = { label: ctx.label, mode: ctx.mode };
    this.seed = this.q.current;
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['setQueue', { n: this.q.length, context: this.context }]);
    await this.loadCurrent(true, true);
  }

  async play(): Promise<void> {
    if (!this.q.current) return;
    if (this.onMp3()) {
      this.publish({ isPlaying: true });
      this.playAudio(this.audio!);
    } else if (this.yt && this.loadedId === this.q.current.ytId) {
      this.publish({ isPlaying: true });
      this.yt.playVideo();
    } else await this.loadCurrent(true);
  }

  async pause(): Promise<void> {
    this.yt?.pauseVideo();
    this.audio?.pause();
    this.publish({ isPlaying: false, isBuffering: false, waitingForNetwork: false, positionMs: livePosition(this.s.value), sampledAt: performance.now() });
  }

  toggle(): Promise<void> {
    return wantsPlay(this.s.value) ? this.pause() : this.play();
  }

  async next(): Promise<void> {
    if (!this.q.current) return;
    const n = this.q.next(false);
    if (n) await this.loadCurrent(true, true);
  }

  async prev(): Promise<void> {
    const r = this.q.prev(livePosition(this.s.value));
    if (r === 'restart') await this.seek(0);
    else await this.loadCurrent(true, true);
  }

  async seek(positionMs: number): Promise<void> {
    if (this.onMp3()) this.audio!.currentTime = positionMs / 1000;
    else this.yt?.seekTo(positionMs / 1000, true);
    this.publish({ positionMs, sampledAt: performance.now() });
  }

  /** K2: the item at `index` is still the one the caller saw. */
  private holds(index: number, expectId?: string): boolean {
    return expectId == null || this.q.items[index]?.id === expectId;
  }

  async skipTo(index: number, expectId?: string): Promise<void> {
    if (!this.holds(index, expectId)) return this.publish();
    const auto = this.q.isAuto(index);
    if (!this.q.skipTo(index)) return;
    // A tapped autoplay track: the radio continues from it.
    if (auto) this.seed = this.q.current;
    await this.loadCurrent(true, true);
  }

  async setShuffle(enabled: boolean): Promise<void> {
    this.q.setShuffle(enabled);
    this.publish();
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    this.q.setRepeat(mode);
    this.publish();
  }

  async move(from: number, to: number, expectId?: string): Promise<void> {
    if (this.holds(from, expectId)) this.q.move(from, to);
    this.publish();
  }

  async remove(index: number, expectId?: string): Promise<void> {
    if (!this.holds(index, expectId)) return this.publish();
    const changed = this.q.remove(index);
    this.publish();
    if (changed) await this.loadCurrent(this.s.value.isPlaying, true);
  }

  async removeIds(ids: string[]): Promise<void> {
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['removeIds', ids]);
    const changed = this.q.removeIds(ids);
    this.publish();
    if (changed) await this.loadCurrent(this.s.value.isPlaying, true);
  }

  async addToQueue(tracks: Track[]): Promise<void> {
    if (!tracks.length) return;
    // e2e: record what the native plugin would receive.
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['queueNext', tracks.map((t) => t.id)]);
    const wasEmpty = !this.q.current;
    this.q.queueNext(tracks);
    this.publish();
    if (wasEmpty) await this.loadCurrent(true, true);
  }

  async restore(track: Track, kind: UpNextKind, beforeId: string | null): Promise<void> {
    if (!this.q.current) return this.playList([track], 0);
    // Autoplay rows don't come back while autoplay is off (they'd be dropped).
    if (kind === 'autoplay' && !this.keepsGoing(this.seed?.id)) return;
    this.q.restore(track, kind, beforeId);
    this.publish();
  }

  async addAutoplay(tracks: Track[], seedId: string): Promise<void> {
    if (!tracks.length || !this.keepsGoing(seedId) || !mayAutoplay(this.q.repeat, this.q.length) || this.seed?.id !== seedId) return;
    const wasEmpty = !this.q.current;
    this.q.addAuto(tracks);
    this.publish();
    if (wasEmpty) await this.loadCurrent(true, true);
  }

  async setAutoplay(enabled: boolean): Promise<void> {
    this.autoplayOn = enabled;
    // A station's next rounds stay: it plays on whatever the setting.
    if (!enabled && !stationPlaying(this.context, this.seed?.id)) this.q.dropAuto();
    this.publish();
  }

  onQueueLow(cb: (e: QueueLow) => void): () => void {
    this.lowListeners.add(cb);
    return () => this.lowListeners.delete(cb);
  }

  async setQuality(q: Quality): Promise<void> {
    // e2e checks the call the native plugin would get.
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['setQuality', { quality: q }]);
    // The IFrame API ignores quality requests nowadays; kept for interface parity.
    this.yt?.setPlaybackQuality?.(q === 'low' ? 'small' : 'default');
  }

  async setCrossfade(ms: CrossfadeMs): Promise<void> {
    // The IFrame player has no crossfade; e2e checks the call the native plugin would get.
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['setCrossfade', { ms }]);
  }

  async setGapless(enabled: boolean): Promise<void> {
    // The IFrame player loads one video at a time; e2e checks the call the native plugin would get.
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['setGapless', { enabled }]);
  }

  async setNetworkPrefs(prefs: { ipv4: Ipv4Mode }): Promise<void> {
    // Nothing to do in a browser; e2e checks the call the native plugin would get.
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['setNetworkPrefs', { ipv4: prefs.ipv4 }]);
  }

  async retryNow(): Promise<void> {
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['retryNow']);
    // Native would answer with `unblocked`.
    block.onUnblocked();
  }

  async netStatus(): Promise<NetStatus | null> {
    // e2e sets what native would report.
    return (TEST_HOOKS && window.__cyberjukeNetStatus) || null;
  }
}
