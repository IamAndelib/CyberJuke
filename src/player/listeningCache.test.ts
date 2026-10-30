import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';

vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('@capacitor/core', async (orig) => ({ ...(await orig<object>()), Capacitor: { isNativePlatform: () => true } }));

/** The fake JukePlayer plugin: the cache calls it got (name, argument), and the listeners added. */
const fake = vi.hoisted(() => {
  const listeners = new Map<string, (e: unknown) => void>();
  let answerIds: (r: { ytIds: string[] }) => void = () => {};
  const idsAsked = new Promise<{ ytIds: string[] }>((r) => (answerIds = r));
  const calls: [string, any][] = [];
  const cmd = (name: string) => (o?: unknown) => {
    calls.push([name, o]);
    return Promise.resolve();
  };
  return {
    listeners,
    calls,
    answerIds: (ytIds: string[]) => answerIds({ ytIds }),
    of: (name: string) => calls.filter(([n]) => n === name).map(([, o]) => o),
    names: () => calls.map(([n]) => n),
    plugin: {
      addListener: (ev: string, cb: (e: unknown) => void) => {
        listeners.set(ev, cb);
        return Promise.resolve({ remove: () => Promise.resolve() });
      },
      setLikedIds: cmd('setLikedIds'),
      setCacheLimit: cmd('setCacheLimit'),
      setDownloadOnMobileData: cmd('setDownloadOnMobileData'),
      clearCache: cmd('clearCache'),
      signedOut: cmd('signedOut'),
      signedIn: cmd('signedIn'),
      cachedIds: () => idsAsked,
    },
  };
});

vi.mock('./native', async (orig) => ({ ...(await orig<object>()), JukePlayer: fake.plugin }));

const lib = await import('../stores/library');
const { savedOffline } = await import('../stores/savedOffline');
const { LIKED_SEND_DELAY_MS, audioIdsOf, clearListeningCache, likedPayload, startListeningCache } = await import('./listeningCache');

const t = (id: string, membersOnly = false): Track => ({ id, ytId: id.padEnd(11, 'x'), membersOnly }) as Track;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  lib.liked.value = [t('b'), t('a')];
  startListeningCache();
});
afterAll(() => {
  vi.useRealTimers();
});

describe('the listening cache wiring', () => {
  it('at start sends Liked (newest first) and the size, and asks what is saved: a change reported before the answer wins', async () => {
    expect(fake.of('setLikedIds')).toEqual([{ ytIds: ['bxxxxxxxxxx', 'axxxxxxxxxx'], membersOnly: [] }]);
    expect(fake.of('setCacheLimit')).toEqual([{ mb: 256 }]);
    expect(fake.of('setDownloadOnMobileData')).toEqual([{ enabled: false }]);
    // The answer, read before the change, comes in after it: it is older, and is dropped.
    fake.listeners.get('cacheChanged')!({ ytIds: ['aaaaaaaaaaa', 'bxxxxxxxxxx'] });
    fake.answerIds(['aaaaaaaaaaa']);
    await Promise.resolve();
    await Promise.resolve();
    expect([...savedOffline.value]).toEqual(['aaaaaaaaaaa', 'bxxxxxxxxxx']);
  });

  it('sends a burst of likes once, a moment after the last', () => {
    fake.calls.length = 0;
    lib.liked.value = [t('c'), t('b'), t('a')];
    lib.liked.value = [t('d'), t('c'), t('b'), t('a')];
    vi.advanceTimersByTime(LIKED_SEND_DELAY_MS - 1);
    expect(fake.of('setLikedIds')).toEqual([]);
    lib.liked.value = [t('e'), t('d'), t('c'), t('b'), t('a')];
    vi.advanceTimersByTime(LIKED_SEND_DELAY_MS);
    expect(fake.of('setLikedIds')).toHaveLength(1);
    expect(fake.of('setLikedIds')[0].ytIds).toHaveLength(5);
    // The same list again: nothing new to send.
    lib.liked.value = [...lib.liked.value];
    vi.advanceTimersByTime(LIKED_SEND_DELAY_MS);
    expect(fake.of('setLikedIds')).toHaveLength(1);
  });

  it('follows the size setting', () => {
    fake.calls.length = 0;
    lib.updateSettings({ cacheMb: 128 });
    expect(fake.of('setCacheLimit')).toEqual([{ mb: 128 }]);
    lib.updateSettings({ theme: 'c64' });
    expect(fake.of('setCacheLimit')).toHaveLength(1);
  });

  it('follows Download using mobile data', () => {
    fake.calls.length = 0;
    lib.updateSettings({ downloadOnMobileData: true });
    expect(fake.of('setDownloadOnMobileData')).toEqual([{ enabled: true }]);
    lib.updateSettings({ theme: 'vt320' });
    expect(fake.of('setDownloadOnMobileData')).toHaveLength(1);
    lib.updateSettings({ downloadOnMobileData: false });
    expect(fake.of('setDownloadOnMobileData')).toEqual([{ enabled: true }, { enabled: false }]);
  });

  it('takes the saved set native reports when it changes', () => {
    fake.listeners.get('cacheChanged')!({ ytIds: ['bxxxxxxxxxx', 'cxxxxxxxxxx'] });
    expect([...savedOffline.value]).toEqual(['bxxxxxxxxxx', 'cxxxxxxxxxx']);
    fake.listeners.get('cacheChanged')!({});
    expect(savedOffline.value.size).toBe(0);
  });

  it('says which liked songs are members-only', () => {
    expect(likedPayload([t('m1', true), t('pub'), t('m1', true)])).toEqual({ ytIds: ['m1xxxxxxxxx', 'pubxxxxxxxx'], membersOnly: ['m1xxxxxxxxx'] });
  });

  it('sends a liked Jukebox MP3 by its audio id, so native keeps it, saves it and drops it at sign-out if members-only', () => {
    const mp3 = (id: string, file: string, membersOnly = false): Track => ({ id, ytId: '', mp3: `https://latex.gg/share/${file}.mp3`, membersOnly }) as Track;
    expect(likedPayload([mp3('p1', 'IZq8cMcx'), t('pub'), mp3('p2', 'FEHdI7AK', true), mp3('p1', 'IZq8cMcx')])).toEqual({
      ytIds: ['mp3:IZq8cMcx.mp3', 'pubxxxxxxxx', 'mp3:FEHdI7AK.mp3'],
      membersOnly: ['mp3:FEHdI7AK.mp3'],
    });
    // Saved whole, native says so by the same id: it plays offline.
    fake.listeners.get('cacheChanged')!({ ytIds: ['mp3:IZq8cMcx.mp3'] });
    expect([...savedOffline.value]).toEqual(['mp3:IZq8cMcx.mp3']);
    fake.listeners.get('cacheChanged')!({ ytIds: [] });
  });

  it('signing out sends the new Liked at once, then signedOut, so native drops members-only audio', () => {
    lib.liked.value = [t('m1', true), t('pub')];
    vi.advanceTimersByTime(LIKED_SEND_DELAY_MS);
    fake.calls.length = 0;
    lib.dropMembersOnly();
    // No debounce: native has the Liked without m1 before it drops members-only audio.
    expect(fake.names()).toEqual(['setLikedIds', 'signedOut']);
    expect(fake.of('setLikedIds')).toEqual([{ ytIds: ['pubxxxxxxxx'], membersOnly: [] }]);
    // And nothing more after the delay.
    vi.advanceTimersByTime(LIKED_SEND_DELAY_MS);
    expect(fake.names()).toEqual(['setLikedIds', 'signedOut']);
  });

  it('while Liked could not be read, sends none of it (native keeps the Liked it has), then all of it once read', async () => {
    vi.advanceTimersByTime(LIKED_SEND_DELAY_MS);
    let failing = true;
    const file = {
      path: 'l',
      get unreadable() {
        return failing;
      },
      load: async () => (failing ? null : [{ ...t('old'), title: 'Old' }]),
      save: async () => {},
      remove: async () => {},
    };
    const noHistory = { path: 'h', unreadable: false, load: async () => null, save: async () => {}, remove: async () => {} };
    lib.setLibraryStorage({ get: async () => null, set: async () => {}, remove: async () => {} }, noHistory, file);
    fake.calls.length = 0;
    await lib.loadLists();
    lib.liked.value = [t('new')];
    vi.advanceTimersByTime(LIKED_SEND_DELAY_MS);
    lib.dropMembersOnly();
    expect(fake.names()).toEqual(['signedOut']);
    failing = false;
    await vi.advanceTimersByTimeAsync(lib.LIST_RETRY_MS[0]);
    vi.advanceTimersByTime(LIKED_SEND_DELAY_MS);
    expect(fake.of('setLikedIds')).toEqual([{ ytIds: ['newxxxxxxxx', 'oldxxxxxxxx'], membersOnly: [] }]);
  });

  it('Clear cache asks native', async () => {
    fake.calls.length = 0;
    await clearListeningCache();
    expect(fake.of('clearCache')).toHaveLength(1);
  });

  it('sends valid ids only, each once, at most what the bridge takes', () => {
    expect(audioIdsOf([t('a'), { id: 'x', ytId: 'bad' } as Track, { id: 'y', ytId: '', mp3: 'https://evil.example/x.mp3' } as Track, t('a'), t('b')])).toEqual(['axxxxxxxxxx', 'bxxxxxxxxxx']);
    const many = Array.from({ length: 2100 }, (_, i) => ({ id: `${i}`, ytId: `${i}`.padStart(11, 'v') }) as Track);
    expect(audioIdsOf(many)).toHaveLength(2000);
  });
});
