import type { ReadonlySignal } from '@preact/signals';
import type { Track } from '../data/model';
import type { RepeatMode } from './native';

export type { RepeatMode };

export interface UpNextItem {
  track: Track;
  /** Index in list order (what move/remove/skipTo take). */
  index: number;
  /** Added with "Add to queue" and not played yet (shown under "Queued by you"). */
  queued?: boolean;
}

export interface PlayerState {
  /** Full queue in list order. */
  queue: Track[];
  /** Index of the current track in `queue`, -1 if none. */
  index: number;
  current: Track | null;
  isPlaying: boolean;
  isBuffering: boolean;
  positionMs: number;
  durationMs: number;
  /** performance.now() when positionMs was sampled; the UI interpolates from it. */
  sampledAt: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Next tracks in actual play order (respects shuffle). */
  upNext: UpNextItem[];
}

export const EMPTY_STATE: PlayerState = {
  queue: [],
  index: -1,
  current: null,
  isPlaying: false,
  isBuffering: false,
  positionMs: 0,
  durationMs: 0,
  sampledAt: 0,
  shuffle: false,
  repeat: 'off',
  upNext: [],
};

/** Same interface for the native (Android) and web (YouTube IFrame) implementations. */
export interface Player {
  readonly kind: 'native' | 'web';
  readonly state: ReadonlySignal<PlayerState>;
  playList(tracks: Track[], startIndex: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  toggle(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  skipTo(index: number): Promise<void>;
  setShuffle(enabled: boolean): Promise<void>;
  setRepeat(mode: RepeatMode): Promise<void>;
  move(from: number, to: number): Promise<void>;
  remove(index: number): Promise<void>;
  /**
   * "Add to queue": play next, after the current track and anything queued before
   * (first in, first out), shuffle or not. With nothing playing, plays them.
   */
  addToQueue(tracks: Track[]): Promise<void>;
  setQuality(q: 'high' | 'low'): Promise<void>;
}

/** Estimated live position, interpolated between samples while playing. */
export function livePosition(s: PlayerState, now = performance.now()): number {
  if (!s.isPlaying || s.isBuffering) return s.positionMs;
  const p = s.positionMs + Math.max(0, now - s.sampledAt);
  return s.durationMs > 0 ? Math.min(p, s.durationMs) : p;
}
