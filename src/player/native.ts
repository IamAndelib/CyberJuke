/**
 * Contract with the native Kotlin `JukePlayer` Capacitor plugin.
 * The native engineer implements exactly this; do not change it unilaterally.
 */
import { registerPlugin } from '@capacitor/core';

export interface NativeTrack { id: string; ytId: string; title: string; artist: string; artworkUrl: string; by?: string; postUrl?: string }
export type RepeatMode = 'off' | 'all' | 'one';
export interface NativeState {
  isPlaying: boolean; isBuffering: boolean;
  index: number;            // index into the list last passed to setQueue/addItems (current list order), -1 if empty
  trackId: string | null;
  positionMs: number; durationMs: number;   // durationMs 0 if unknown
  shuffle: boolean; repeat: RepeatMode;
  queueIds: string[];       // the full current list, in list order (omitted with queueIdsUnchanged)
  /** True when the list didn't change since the last event: queueIds is then omitted, keep the previous one. */
  queueIdsUnchanged?: boolean;
  upNextIds: string[];      // the next tracks in actual play order (respects shuffle), max 50
}
/** Why YouTube is refusing requests from this network (Y1). */
export type BlockReason = 'BOT_CHECK' | 'RATE_LIMIT' | 'STREAM_FORBIDDEN';
export interface BlockedEvent { until: number /* epoch ms */; reason: BlockReason }
/**
 * setQueue, addItems and queueNext reject the whole call ("Invalid tracks: track.ytId
 * invalid") when any ytId isn't 11 characters of [A-Za-z0-9_-]: filter before calling.
 * While blocked, setQueue replaces the queue without preparing it (and resolves), and
 * play() is refused when nothing is loaded. trackError is never sent for blocks.
 */
export interface JukePlayerPlugin {
  setQueue(o: { tracks: NativeTrack[]; startIndex: number; positionMs?: number; playWhenReady: boolean }): Promise<void>;
  addItems(o: { tracks: NativeTrack[]; index?: number }): Promise<void>;   // index omitted = append
  /** Insert after the current track + tracks already user-queued; respects shuffle; upNextIds reflects it. */
  queueNext(o: { tracks: NativeTrack[] }): Promise<void>;
  removeItem(o: { index: number }): Promise<void>;
  moveItem(o: { from: number; to: number }): Promise<void>;
  play(): Promise<void>; pause(): Promise<void>;
  seekTo(o: { positionMs: number }): Promise<void>;
  skipToNext(): Promise<void>; skipToPrevious(): Promise<void>;
  skipToIndex(o: { index: number }): Promise<void>;
  setShuffle(o: { enabled: boolean }): Promise<void>;
  setRepeat(o: { mode: RepeatMode }): Promise<void>;
  setQuality(o: { quality: 'high' | 'low' }): Promise<void>;
  getState(): Promise<NativeState>;
  getLaunchOptions(): Promise<{ autoplay?: 'latest' }>;   // from Android intent extra, used by the CI smoke test
  /** The network-wide back-off in force, if any (until 0 = none). */
  getBlockState(): Promise<{ until: number; reason?: string }>;
  /** Y6: resolve hostnames to IPv4 only, for extraction and streaming alike (saved natively, applied at service start). */
  setNetworkPrefs(o: { preferIpv4: boolean }): Promise<void>;
  /** Keep a screen area (CSS px relative to the WebView) out of the system back gesture; null clears it. */
  setGestureExclusion(rect: { left: number; top: number; width: number; height: number } | null): Promise<void>;
  addListener(event: 'state', cb: (s: NativeState) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(event: 'trackError', cb: (e: { trackId: string; message: string; skipped: boolean }) => void): Promise<{ remove: () => Promise<void> }>;
  /** YouTube is refusing this network: playback paused, nothing is requested until `until`. */
  addListener(event: 'blocked', cb: (e: BlockedEvent) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(event: 'unblocked', cb: (e: Record<string, never>) => void): Promise<{ remove: () => Promise<void> }>;
  /** Parsing failed in a way that means YouTube changed something (an app update is needed). */
  addListener(event: 'extractorBroken', cb: (e: { message: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

export const JukePlayer = registerPlugin<JukePlayerPlugin>('JukePlayer');
