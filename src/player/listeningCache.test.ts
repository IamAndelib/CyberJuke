import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Signal } from '@preact/signals';
import type { Track } from '../data/model';

vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('@capacitor/core', async (orig) => ({ ...(await orig<object>()), Capacitor: { isNativePlatform: () => true } }));

/** The fake JukePlayer plugin: the cache calls it got (name, argument), and the listeners added. */
const fake = vi.hoisted(() => {
  const listeners = new Map<string, (e: unknown) => void>();
  const calls: [string, any][] = [];
  const cmd = (name: string) => (o?: unknown) => {
    calls.push([name, o]);
    return Promise.resolve();
  };
  return {
    listeners,
    calls,
    of: (name: string) => calls.filter(([n]) => n === name).map(([, o]) => o),
    plugin: {
      addListener: (ev: string, cb: (e: unknown) => void) => {
        listeners.set(ev, cb);
        return Promise.resolve({ remove: () => Promise.resolve() });
      },
      setLikedIds: cmd('setLikedIds'),
      setCacheLimit: cmd('setCacheLimit'),
      clearCache: cmd('clearCache'),
      dropCached: cmd('dropCached'),
      cachedIds: () => Promise.resolve({ ytIds: ['aaaaaaaaaaa'] }),
    },
  };
});
const queue = vi.hoisted(() => ({ tracks: [] as Track[] }));

vi.mock('./native', async (orig) => ({ ...(await orig<object>()), JukePlayer: fake.plugin }));
vi.mock('./index', () => ({ player: { state: { peek: () => ({ queue: queue.tracks }) } } }));
vi.mock('../stores/catalog', async () => {
  const { signal } = await import('@preact/signals');
  return { catalog: { all: signal<Track[]>([]) } };
});

const { catalog } = await import('../stores/catalog');
const lib = await import('../stores/library');
const { savedOffline } = await import('../stores/savedOffline');
const { LIKED_SEND_DELAY_MS, clearListeningCache, startListeningCache, ytIdsOf } = await import('./listeningCache');

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
  it('at start sends Liked (newest first) and the size, and asks what is saved', async () => {
    expect(fake.of('setLikedIds')).toEqual([{ ytIds: ['bxxxxxxxxxx', 'axxxxxxxxxx'] }]);
    expect(fake.of('setCacheLimit')).toEqual([{ mb: 256 }]);
    await vi.waitFor(() => expect([...savedOffline.value]).toEqual(['aaaaaaaaaaa']));
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

  it('takes the saved set native reports when it changes', () => {
    fake.listeners.get('cacheChanged')!({ ytIds: ['bxxxxxxxxxx', 'cxxxxxxxxxx'] });
    expect([...savedOffline.value]).toEqual(['bxxxxxxxxxx', 'cxxxxxxxxxx']);
    fake.listeners.get('cacheChanged')!({});
    expect(savedOffline.value.size).toBe(0);
  });

  it('signing out drops the cached audio of members-only tracks: liked, played, queued or in the catalog', () => {
    fake.calls.length = 0;
    lib.liked.value = [t('m1', true), t('pub')];
    lib.addRecent(t('m2', true));
    queue.tracks = [t('m3', true), t('pub2')];
    (catalog.all as Signal<Track[]>).value = [t('m4', true), t('m1', true), t('pub3')];
    lib.dropMembersOnly();
    expect(fake.of('dropCached')).toHaveLength(1);
    expect(fake.of('dropCached')[0].ytIds.sort()).toEqual(['m1xxxxxxxxx', 'm2xxxxxxxxx', 'm3xxxxxxxxx', 'm4xxxxxxxxx']);
    expect(lib.liked.value.map((x) => x.id)).toEqual(['pub']);
  });

  it('Clear cache asks native', async () => {
    fake.calls.length = 0;
    await clearListeningCache();
    expect(fake.of('clearCache')).toHaveLength(1);
  });

  it('sends valid ids only, each once, at most what the bridge takes', () => {
    expect(ytIdsOf([t('a'), { id: 'x', ytId: 'bad' } as Track, t('a'), t('b')])).toEqual(['axxxxxxxxxx', 'bxxxxxxxxxx']);
    const many = Array.from({ length: 2100 }, (_, i) => ({ id: `${i}`, ytId: `${i}`.padStart(11, 'v') }) as Track);
    expect(ytIdsOf(many)).toHaveLength(2000);
  });
});
