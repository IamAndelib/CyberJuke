/**
 * The one `online` signal the app reads (Capacitor Network: the OS's view on
 * Android, online/offline events in the browser). `onReconnect` runs callbacks on
 * every report that the connection is there.
 *
 * Handover grace: switching between Wi-Fi and mobile data, the OS briefly reports
 * "not connected". So a loss only counts once it has lasted OFFLINE_GRACE_MS (the usual
 * Android practice: debounce the loss, not the return). Coming back applies at once,
 * and an answer we asked for (the first status, Redial) applies as it is.
 */
import { signal } from '@preact/signals';
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
  if (connected) return reportedConnected();
  if (!online.peek()) return setOnline(false);
  lossTimer ??= setTimeout(() => setOnline(false), graceMs());
}

const reconnect = new Set<() => void>();

/**
 * Call `fn` on every report that the connection is there: back online, and "connected"
 * from the OS or Redial while the app already counted as online. A list that failed in a
 * handover's gap (inside the grace) or behind a Wi-Fi login page never saw `online` flip,
 * so a flip alone would leave it failed. The callbacks limit their own work.
 */
export function onReconnect(fn: () => void): () => void {
  reconnect.add(fn);
  return () => reconnect.delete(fn);
}

/** Online, and the reconnect callbacks run. */
function reportedConnected(): void {
  setOnline(true);
  for (const fn of [...reconnect]) {
    try {
      fn();
    } catch (e) {
      logError('onReconnect', e);
    }
  }
}

/** Ask the OS again (Redial: a change its listener missed). True when online. */
export async function recheckNetwork(): Promise<boolean> {
  try {
    if ((await Network.getStatus()).connected) reportedConnected();
    else setOnline(false);
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
}
