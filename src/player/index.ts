/**
 * Player facade. On Android the native JukePlayer plugin plays audio (and owns the
 * queue); in the browser a hidden YouTube IFrame player is used. Every command goes
 * through safePlayer (a failure is a toast, never an unhandled rejection).
 *
 * Components read the narrow computeds below rather than `player.state`, so a
 * position sample (every second while playing) re-renders nothing but what shows
 * the position.
 */
import { Capacitor } from '@capacitor/core';
import { computed, effect } from '@preact/signals';
import { addRecent, settings } from '../store/library';
import { block } from '../store/block';
import { toast } from '../store/toast';
import { NativePlayer } from './nativePlayer';
import { safePlayer } from './safePlayer';
import type { Player } from './types';
import { WebPlayer } from './webPlayer';

export * from './types';

/** A failed command's toast; during a block the banner says why, so the toast says so too. */
function commandFailed(message: string): void {
  toast(block.blocked.peek() ? 'Playback is paused while YouTube is limiting requests' : message);
}

export const player: Player = safePlayer(Capacitor.isNativePlatform() ? new NativePlayer() : new WebPlayer(), commandFailed);

const state = player.state;

/** The current track (same object until the track changes). */
export const currentTrack = computed(() => state.value.current);
export const currentId = computed(() => state.value.current?.id ?? null);
export const hasCurrent = computed(() => state.value.current != null);
export const isPlaying = computed(() => state.value.isPlaying);
export const isBuffering = computed(() => state.value.isBuffering);
/** Playing and not buffering: the position moves. */
export const isAdvancing = computed(() => state.value.isPlaying && !state.value.isBuffering);
/** "Next" does something: a track after this one, or repeat wraps around. */
export const canSkipNext = computed(() => state.value.upNext.length > 0 || state.value.repeat !== 'off');

export interface PositionSample {
  positionMs: number;
  durationMs: number;
  sampledAt: number;
  isPlaying: boolean;
  isBuffering: boolean;
}

/** The latest position sample (changes about once a second while playing). Read it in effects, not render. */
export const positionSample = computed<PositionSample>(() => {
  const s = state.value;
  return { positionMs: s.positionMs, durationMs: s.durationMs, sampledAt: s.sampledAt, isPlaying: s.isPlaying, isBuffering: s.isBuffering };
});

let lastRecentId: string | null = null;
effect(() => {
  const cur = currentTrack.value;
  if (cur && cur.ytId && cur.id !== lastRecentId) {
    lastRecentId = cur.id;
    addRecent(cur);
  }
});

/**
 * Send the player settings (audio quality, Y6 "Prefer IPv4") to the player now and on
 * every change. Called once the library has loaded, so native never gets the
 * defaults first.
 */
export function startPlayerPrefs(): void {
  let lastQuality: string | null = null;
  let lastIpv4: boolean | null = null;
  effect(() => {
    const { quality, preferIpv4 } = settings.value;
    if (quality !== lastQuality) {
      lastQuality = quality;
      void player.setQuality(quality);
    }
    if (preferIpv4 !== lastIpv4) {
      lastIpv4 = preferIpv4;
      void player.setNetworkPrefs({ preferIpv4 });
    }
  });
}
