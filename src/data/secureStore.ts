/**
 * Small encrypted key/value store for secrets (the Cyberspace login token).
 *
 * On Android it is the native `SecureStore` plugin: values are encrypted with an
 * Android Keystore AES-GCM key before they are written. In the browser build (dev,
 * e2e) there is no plugin, so values live only in memory and vanish on reload.
 * The plugin interface is a contract with the native side; don't change it.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface SecureStorePlugin {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
}

const SecureStore = registerPlugin<SecureStorePlugin>('SecureStore');

/** In-memory stand-in for the browser build. */
export function memorySecureStore(): SecureStorePlugin {
  const map = new Map<string, string>();
  return {
    get: async ({ key }) => ({ value: map.get(key) ?? null }),
    set: async ({ key, value }) => void map.set(key, value),
    remove: async ({ key }) => void map.delete(key),
  };
}

/** The app's secure store: native on Android, memory elsewhere. */
export const secureStore: SecureStorePlugin = Capacitor.isNativePlatform() ? SecureStore : memorySecureStore();
