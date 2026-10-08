/**
 * Keep the fast-scroll thumb out of Android's back gesture (M4): while the thumb shows,
 * its rect is excluded from the system edge swipe, so dragging it near the right edge
 * scrolls the list instead of going back. Native only (MainActivity caps the area at
 * Android's 200dp per edge). Dev/test builds record the calls as
 * `window.__cyberjukeGestureExclusion` so e2e can check them on the web.
 */
import { Capacitor } from '@capacitor/core';
import { logError } from '../core/log';
import { TEST_HOOKS, exposeForTests } from '../core/testHooks';
import { JukePlayer } from '../player/native';

export interface ExclusionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const calls: (ExclusionRect | null)[] = [];
exposeForTests('__cyberjukeGestureExclusion', calls);

let last = 'null';

/** Exclude `rect` (CSS px, relative to the WebView), or clear the exclusion with null. Repeats are dropped. */
export function setGestureExclusion(rect: ExclusionRect | null): void {
  const r = rect && { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  const key = JSON.stringify(r);
  if (key === last) return;
  last = key;
  if (TEST_HOOKS) calls.push(r);
  if (!Capacitor.isNativePlatform()) return;
  // Plugin calls take an options object: an empty one (no rect fields) clears it natively.
  JukePlayer.setGestureExclusion(r ?? ({} as ExclusionRect)).catch((e: unknown) => logError('gestureExclusion', e));
}
