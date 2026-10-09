import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real app (native): how it was installed decides whether GitHub is ever asked.
vi.mock('@capacitor/core', async (orig) => ({
  ...(await orig<object>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
}));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));

const RELEASE = { tag_name: 'v9.0.0', html_url: 'https://github.com/IamAndelib/CyberJuke/releases/tag/v9.0.0' };
let fetches = 0;
let fail = false;

beforeEach(() => {
  vi.resetModules();
  // The page coming back to the foreground (no DOM here: just the events).
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  fetches = 0;
  fail = false;
  vi.stubGlobal('fetch', async () => {
    fetches++;
    if (fail) throw new Error('offline');
    return { ok: true, status: 200, json: async () => RELEASE };
  });
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));
const visible = () => document.dispatchEvent(new Event('visibilitychange'));

describe('the update check in the app', () => {
  it('never asks GitHub when F-Droid installed it: not at startup, on return, or on Check now', async () => {
    const u = await import('./updates');
    await u.startUpdates(async () => ({ version: '1.1.0', installer: 'org.fdroid.fdroid' }));
    await flush();
    visible();
    await u.checkForUpdates();
    expect(fetches).toBe(0);
    expect(u.app.value.fdroid).toBe(true);
  });

  it('never asks GitHub before it knows how it was installed, nor when it cannot tell', async () => {
    const u = await import('./updates');
    let answer: (v: { version: string; installer?: string }) => void = () => {};
    const started = u.startUpdates(() => new Promise((r) => (answer = r)));
    // Settings' Check now, while Android hasn't answered yet.
    await u.checkForUpdates();
    expect(fetches).toBe(0);
    answer({ version: '1.1.0', installer: 'com.android.vending' });
    await started;
    await flush();
    expect(fetches).toBe(1);

    vi.resetModules();
    const v = await import('./updates');
    await v.startUpdates(() => Promise.reject(new Error('no plugin')));
    await flush();
    await v.checkForUpdates();
    expect(fetches).toBe(1);
    expect(v.app.value.fdroid).toBeNull();
  });

  it('after a failed check, returning to the app does not ask again within the hour', async () => {
    const u = await import('./updates');
    fail = true;
    await u.startUpdates(async () => ({ version: '1.1.0', installer: 'com.android.vending' }));
    await flush();
    expect(fetches).toBe(1);
    expect(u.checkFailed.value).toBe(true);
    visible();
    visible();
    await flush();
    expect(fetches).toBe(1);
    // Check now still asks.
    fail = false;
    await u.checkForUpdates();
    expect(fetches).toBe(2);
    expect(u.updateAvailable.value?.version).toBe('9.0.0');
  });
});
