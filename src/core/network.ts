/**
 * The one `online` signal the app reads (Capacitor Network: the OS's view on
 * Android, online/offline events in the browser). `onReconnect` runs callbacks when
 * the connection comes back.
 *
 * Handover grace: switching between Wi-Fi and mobile data, the OS briefly reports
 * "not connected". So a loss only counts once it has lasted OFFLINE_GRACE_MS (the usual
 * Android practice: debounce the loss, not the return). Coming back applies at once,
 * and an answer we asked for (the first status, Redial) applies as it is.
 */
import { effect, signal, untracked } from '@preact/signals';
import { Network } from '@capacitor/network';
import { logError } from './log';
import { TEST_HOOKS } from './testHooks';

export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);

/** How long "not connected" has to last before the app counts as offline. */
export const OFFLINE_GRACE_MS = 3000;

declare global {
  interface Window {
    /** Test builds: the grace in ms instead of OFFLINE_GRACE_MS (e2e sets 0). */
    __cyberjukeOfflineGraceMs?: number;
  }
}

function graceMs(): number {
  const t = TEST_HOOKS && typeof window !== 'undefined' ? window.__cyberjukeOfflineGraceMs : undefined;
  return typeof t === 'number' ? t : OFFLINE_GRACE_MS;
}

let lossTimer: ReturnType<typeof setTimeout> | undefined;

/** The OS's answer, applied as it is (and any pending loss forgotten). */
function setOnline(connected: boolean): void {
  clearTimeout(lossTimer);
  lossTimer = undefined;
  online.value = connected;
}

/** A change the OS reported by itself: a loss waits out the grace, a return applies at once. */
export function networkChanged(connected: boolean): void {
  if (connected || !online.peek()) return setOnline(connected);
  lossTimer ??= setTimeout(() => setOnline(false), graceMs());
}

const reconnect = new Set<() => void>();

/** Call `fn` every time the app goes from offline to online. */
export function onReconnect(fn: () => void): () => void {
  reconnect.add(fn);
  return () => reconnect.delete(fn);
}

/** Ask the OS again (Redial: a change its listener missed). True when online. */
export async function recheckNetwork(): Promise<boolean> {
  try {
    setOnline((await Network.getStatus()).connected);
  } catch {
    // Keep what we had.
  }
  return online.peek();
}

let watching = false;

export function watchNetwork(): void {
  if (watching) return;
  watching = true;
  Network.getStatus()
    .then((s) => setOnline(s.connected))
    .catch(() => {});
  Network.addListener('networkStatusChange', (s) => networkChanged(s.connected)).catch(() => {});
  let was = online.peek();
  effect(() => {
    const now = online.value;
    if (now && !was) {
      // Only `online` is followed, not whatever the callbacks read.
      untracked(() => {
        for (const fn of [...reconnect]) {
          try {
            fn();
          } catch (e) {
            logError('onReconnect', e);
          }
        }
      });
    }
    was = now;
  });
}
