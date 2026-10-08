/**
 * The one `online` signal the app reads (Capacitor Network: the OS's view on
 * Android, online/offline events in the browser). `onReconnect` runs callbacks when
 * the connection comes back.
 */
import { effect, signal } from '@preact/signals';
import { Network } from '@capacitor/network';
import { logError } from './log';

export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);

const reconnect = new Set<() => void>();

/** Call `fn` every time the app goes from offline to online. */
export function onReconnect(fn: () => void): () => void {
  reconnect.add(fn);
  return () => reconnect.delete(fn);
}

let watching = false;

export function watchNetwork(): void {
  if (watching) return;
  watching = true;
  Network.getStatus()
    .then((s) => (online.value = s.connected))
    .catch(() => {});
  Network.addListener('networkStatusChange', (s) => (online.value = s.connected)).catch(() => {});
  let was = online.peek();
  effect(() => {
    const now = online.value;
    if (now && !was) {
      for (const fn of [...reconnect]) {
        try {
          fn();
        } catch (e) {
          logError('onReconnect', e);
        }
      }
    }
    was = now;
  });
}
