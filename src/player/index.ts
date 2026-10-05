/**
 * Player facade. On Android the native JukePlayer plugin plays audio (and owns the
 * queue); in the browser a hidden YouTube IFrame player is used.
 */
import { Capacitor } from '@capacitor/core';
import { effect } from '@preact/signals';
import { addRecent, settings } from '../store/library';
import { NativePlayer } from './nativePlayer';
import type { Player } from './types';
import { WebPlayer } from './webPlayer';

export * from './types';

export const player: Player = Capacitor.isNativePlatform() ? new NativePlayer() : new WebPlayer();

let lastRecentId: string | null = null;
effect(() => {
  const cur = player.state.value.current;
  if (cur && cur.ytId && cur.id !== lastRecentId) {
    lastRecentId = cur.id;
    addRecent(cur);
  }
});

let lastQuality: string | null = null;
effect(() => {
  const q = settings.value.quality;
  if (q !== lastQuality) {
    lastQuality = q;
    player.setQuality(q).catch(() => {});
  }
});
