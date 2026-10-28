/**
 * Haptic ticks through Android's own touch feedback (the native side's
 * View.performHapticFeedback on the WebView): it needs no permission and follows the system's
 * Touch feedback setting. navigator.vibrate did nothing in the app (it needs the VIBRATE
 * permission, which the app doesn't ask for). Fire and forget, and nothing off Android.
 * Dev/test builds record the kinds as `window.__cyberjukeHaptics` so e2e can check them.
 */
import { Capacitor } from '@capacitor/core';
import { logError } from '../core/log';
import { TEST_HOOKS, exposeForTests } from '../core/testHooks';
import { JukePlayer, type HapticKind } from '../player/native';

const calls: HapticKind[] = [];
exposeForTests('__cyberjukeHaptics', calls);

export function haptic(kind: HapticKind): void {
  if (TEST_HOOKS) calls.push(kind);
  if (!Capacitor.isNativePlatform()) return;
  JukePlayer.haptic({ kind }).catch((e: unknown) => logError('haptic', e));
}
