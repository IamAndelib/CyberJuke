import type { ReadonlySignal } from '@preact/signals';
import type { Track } from '../data/model';
import type { Ipv4Mode } from '../stores/library';
import type { RepeatMode } from './native';

export type { RepeatMode };

/** Up next's sections, which is also what Undo of a remove puts a track back into. */
export type UpNextKind = 'queued' | 'list' | 'autoplay';

export interface UpNextItem {
  track: Track;
  /** Index in list order (what move/remove/skipTo take). */
  index: number;
  /** Added with "Add to queue" and not played yet (shown under "Queued by you"). */
  queued?: boolean;
  /** Added by autoplay (shown under "Autoplay"). */
  auto?: boolean;
}

/**
 * Where playback comes from (C2). `radio` (feeds and results): the tapped track, then
 * similar tracks; the rest of the list is not queued. `list` (an album, Liked, a genre,
 * Play/Shuffle): the list in order, then similar tracks. `label` is the source shown in
 * Now Playing ("Home · Latest", "Liked", ...).
 */
export interface PlayContext {
  label: string;
  mode: 'radio' | 'list';
}

/** What playList uses when no context is given. */
export const LIST_CONTEXT: PlayContext = { label: '', mode: 'list' };

export interface UpItem {
  track: Track;
  index: number;
}

/** Up next as its three sections, in play order (C2), and the track autoplay follows. */
export interface UpNextSections {
  queued: UpItem[];
  list: UpItem[];
  autoplay: UpItem[];
  seed: Track | null;
}

/** Autoplay is running low: `left` tracks to go after the current one. */
export interface QueueLow {
  left: number;
  seedId: string | null;
}

/** Autoplay tracks left when more are added (AP4). */
export const AUTOPLAY_LOW = 5;
/** Autoplay tracks added at the start of a list or radio, and on each refill. */
export const AUTOPLAY_FIRST = 25;
export const AUTOPLAY_MORE = 20;

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
  /** The context of the current list (same object until it changes); null before the first. */
  context: PlayContext | null;
  /** The track autoplay follows: the started track, or the autoplay track tapped. */
  seed: Track | null;
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
  context: null,
  seed: null,
};

/** Same interface for the native (Android) and web (YouTube IFrame) implementations. */
export interface Player {
  readonly kind: 'native' | 'web';
  readonly state: ReadonlySignal<PlayerState>;
  /**
   * Start a list (C2). `radio` plays only `tracks[startIndex]`, then autoplay; `list` plays
   * the list from there, then autoplay. Tracks added with "Add to queue" stay next (P1).
   */
  playList(tracks: Track[], startIndex: number, ctx?: PlayContext): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  toggle(): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  /**
   * Index commands (K2) take the id the caller sees at that index (for move, at `from`):
   * when the list changed meanwhile and it is something else, nothing happens (the
   * state is refreshed, no error).
   */
  skipTo(index: number, expectId?: string): Promise<void>;
  setShuffle(enabled: boolean): Promise<void>;
  setRepeat(mode: RepeatMode): Promise<void>;
  move(from: number, to: number, expectId?: string): Promise<void>;
  remove(index: number, expectId?: string): Promise<void>;
  /** Remove every item with one of these ids (signing out: members-only tracks, K5). */
  removeIds(ids: string[]): Promise<void>;
  /**
   * "Add to queue": play next, after the current track and anything queued before
   * (first in, first out), shuffle or not. With nothing playing, plays them.
   */
  addToQueue(tracks: Track[]): Promise<void>;
  /**
   * Undo a remove (K3): put `track` back in its section, right before `beforeId` (the
   * track that followed it there) if that is still ahead in the section, else at the
   * end of the section. Never at or before the current track.
   */
  restore(track: Track, kind: UpNextKind, beforeId: string | null): Promise<void>;
  /** Autoplay tracks computed for `seedId`; ignored if the seed changed meanwhile. */
  addAutoplay(tracks: Track[], seedId: string): Promise<void>;
  /** The Autoplay setting (C3). Off drops the autoplay tracks still to come. */
  setAutoplay(enabled: boolean): Promise<void>;
  /** Called when autoplay needs more tracks (native: the `queueLow` event). Returns an unsubscribe. */
  onQueueLow(cb: (e: QueueLow) => void): () => void;
  setQuality(q: 'high' | 'low'): Promise<void>;
  /** Y6: the IPv4 setting for YouTube requests (native only; the web player ignores it). */
  setNetworkPrefs(prefs: { ipv4: Ipv4Mode }): Promise<void>;
  /** The block banner's "Try now": lift YouTube's back-off now (playback it stopped resumes). */
  retryNow(): Promise<void>;
  /** For the Settings diagnostics line; null where there is none (the web player). */
  netStatus(): Promise<NetStatus | null>;
}

/** How CyberJuke reaches YouTube right now (native `getNetStatus`). */
export interface NetStatus {
  /** The address family of the latest YouTube request, if any yet. */
  family?: 'IPv4' | 'IPv6';
  ipv4: Ipv4Mode;
  /** 'auto' has switched this network to IPv4. */
  autoIpv4: boolean;
  /** The last time YouTube limited us. */
  lastLimit?: { at: number; reason: string; surface: 'playback' | 'music' };
}

/** Estimated live position, interpolated between samples while playing. */
export function livePosition(s: PlayerState, now = performance.now()): number {
  if (!s.isPlaying || s.isBuffering) return s.positionMs;
  const p = s.positionMs + Math.max(0, now - s.sampledAt);
  return s.durationMs > 0 ? Math.min(p, s.durationMs) : p;
}
