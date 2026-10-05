import { signal } from '@preact/signals';
import { Network } from '@capacitor/network';

export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);

export function watchNetwork(): void {
  Network.getStatus()
    .then((s) => (online.value = s.connected))
    .catch(() => {});
  Network.addListener('networkStatusChange', (s) => (online.value = s.connected)).catch(() => {});
}
