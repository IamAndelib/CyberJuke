/**
 * Browser player for development and e2e tests: a hidden YouTube IFrame player
 * driven by the pure Queue model.
 */
import { signal } from '@preact/signals';
import type { Track } from '../data/model';
import { toast } from '../store/toast';
import { TEST_HOOKS } from '../core/testHooks';
import { Queue } from './queue';
import type { RepeatMode } from './native';
import { AUTOPLAY_LOW, EMPTY_STATE, LIST_CONTEXT, livePosition, type PlayContext, type Player, type PlayerState, type QueueLow } from './types';

/* Minimal typings for the parts of the IFrame API we use. */
interface YTPlayer {
  loadVideoById(id: string, startSeconds?: number): void;
  cueVideoById(id: string): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
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
  }
}

const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;
/** Codes where the video can never play here (removed, private, embedding disabled). */
export const SKIP_ERROR_CODES = new Set([100, 101, 150]);

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

  /** AP4, inline: with 5 autoplay tracks or fewer to go, ask for more (once per state). */
  private checkLow(): void {
    const seed = this.seed;
    if (!this.autoplayOn || this.q.repeat !== 'off' || !this.q.current || !seed) {
      this.lowKey = null;
      return;
    }
    const left = this.q.autoAhead;
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
    const now = performance.now();
    if (code === YT_PLAYING) {
      this.publish({
        isPlaying: true,
        isBuffering: false,
        durationMs: Math.round((yt.getDuration() || 0) * 1000),
        positionMs: Math.round(yt.getCurrentTime() * 1000),
        sampledAt: now,
      });
      this.startPoll();
    } else if (code === YT_PAUSED) {
      this.stopPoll();
      this.publish({ isPlaying: false, isBuffering: false, positionMs: Math.round(yt.getCurrentTime() * 1000), sampledAt: now });
    } else if (code === YT_BUFFERING) {
      this.publish({ isBuffering: true, positionMs: Math.round(yt.getCurrentTime() * 1000), sampledAt: now });
    } else if (code === YT_ENDED) {
      this.stopPoll();
      this.advance(true);
    }
  }

  private onYtError(code: number): void {
    const t = this.q.current;
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
      if (!this.yt || document.hidden) return;
      this.s.value = { ...this.s.value, positionMs: Math.round(this.yt.getCurrentTime() * 1000), sampledAt: performance.now() };
    }, 1000);
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** Load the queue's current track into the IFrame player. */
  private async loadCurrent(autoplay: boolean, force = false): Promise<void> {
    const t = this.q.current;
    if (!t) {
      this.stopPoll();
      this.yt?.pauseVideo();
      this.loadedId = null;
      this.publish({ isPlaying: false, isBuffering: false, positionMs: 0, durationMs: 0 });
      return;
    }
    this.publish({ isPlaying: autoplay, isBuffering: autoplay, positionMs: 0, durationMs: 0, sampledAt: performance.now() });
    let yt: YTPlayer;
    try {
      yt = await this.ensurePlayer();
    } catch {
      return;
    }
    if (this.q.current !== t) return; // superseded while loading
    if (this.loadedId === t.ytId && !force) {
      if (autoplay) yt.playVideo();
      return;
    }
    this.loadedId = t.ytId;
    if (autoplay) yt.loadVideoById(t.ytId);
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
    if (this.yt && this.loadedId === this.q.current.ytId) {
      this.publish({ isPlaying: true });
      this.yt.playVideo();
    } else await this.loadCurrent(true);
  }

  async pause(): Promise<void> {
    this.yt?.pauseVideo();
    this.publish({ isPlaying: false, isBuffering: false, positionMs: livePosition(this.s.value), sampledAt: performance.now() });
  }

  toggle(): Promise<void> {
    return this.s.value.isPlaying ? this.pause() : this.play();
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
    this.yt?.seekTo(positionMs / 1000, true);
    this.publish({ positionMs, sampledAt: performance.now() });
  }

  async skipTo(index: number): Promise<void> {
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

  async move(from: number, to: number): Promise<void> {
    this.q.move(from, to);
    this.publish();
  }

  async remove(index: number): Promise<void> {
    const changed = this.q.remove(index);
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

  async addAutoplay(tracks: Track[], seedId: string): Promise<void> {
    if (!tracks.length || !this.autoplayOn || this.q.repeat !== 'off' || this.seed?.id !== seedId) return;
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['addAutoplay', tracks.map((t) => t.id)]);
    const wasEmpty = !this.q.current;
    this.q.addAuto(tracks);
    this.publish();
    if (wasEmpty) await this.loadCurrent(true, true);
  }

  async setAutoplay(enabled: boolean): Promise<void> {
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['setAutoplay', enabled]);
    this.autoplayOn = enabled;
    if (!enabled) this.q.dropAuto();
    this.publish();
  }

  onQueueLow(cb: (e: QueueLow) => void): () => void {
    this.lowListeners.add(cb);
    return () => this.lowListeners.delete(cb);
  }

  async setQuality(q: 'high' | 'low'): Promise<void> {
    // The IFrame API ignores quality requests nowadays; kept for interface parity.
    this.yt?.setPlaybackQuality?.(q === 'low' ? 'small' : 'default');
  }

  async setNetworkPrefs(prefs: { preferIpv4: boolean }): Promise<void> {
    // Nothing to do in a browser; e2e checks the call the native plugin would get.
    if (TEST_HOOKS) window.__cyberjukePlayerCalls?.push(['setNetworkPrefs', { preferIpv4: prefs.preferIpv4 }]);
  }
}
