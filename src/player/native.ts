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
  queueIds: string[];       // the full current list, in list order
  upNextIds: string[];      // the next tracks in actual play order (respects shuffle), max 50
}
export interface JukePlayerPlugin {
  setQueue(o: { tracks: NativeTrack[]; startIndex: number; positionMs?: number; playWhenReady: boolean }): Promise<void>;
  addItems(o: { tracks: NativeTrack[]; index?: number }): Promise<void>;   // index omitted = append
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
  addListener(event: 'state', cb: (s: NativeState) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(event: 'trackError', cb: (e: { trackId: string; message: string; skipped: boolean }) => void): Promise<{ remove: () => Promise<void> }>;
}

export const JukePlayer = registerPlugin<JukePlayerPlugin>('JukePlayer');
