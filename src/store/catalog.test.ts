import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: async () => ({ value: null }), set: async () => {} },
}));

const { CATALOG_KEY, CATALOG_MEMBERS_KEY, FULL_AFTER_MS, INCREMENTAL_AFTER_MS, catalogKey, createCatalog, genreCounts, mergeTracks, mostSaved } =
  await import('./catalog');

function t(id: string, createdAt: string, p: Partial<Track> = {}): Track {
  return {
    id,
    ytId: 'abcdefghijk',
    title: id,
    artist: 'A',
    genre: 'rock',
    by: 'u',
    postTitle: '',
    postUrl: '',
    createdAt,
    nsfw: false,
    artworkUrl: '',
    ...p,
  };
}

const D = (day: number) => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;

function memStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void data.set(k, v)),
  };
}

function setup(opts: { tracks?: Track[]; stored?: object; nsfw?: boolean; start?: number } = {}) {
  let clock = opts.start ?? Date.UTC(2026, 9, 8);
  let server = opts.tracks ?? [t('a', D(1)), t('b', D(2)), t('c', D(3))];
  const calls: (Date | undefined)[] = [];
  let fail: Error | null = null;
  const source = {
    catalog: vi.fn(async (since?: Date) => {
      calls.push(since);
      await Promise.resolve();
      if (fail) throw fail;
      return server.filter((x) => !since || new Date(x.createdAt) > since);
    }),
  };
  const storage = memStorage(opts.stored ? { [CATALOG_KEY]: JSON.stringify(opts.stored) } : {});
  const nsfw = signal(opts.nsfw ?? false);
  const cat = createCatalog({ source, storage, showNsfw: () => nsfw.value, now: () => clock });
  return {
    cat,
    source,
    storage,
    calls,
    tick: (ms: number) => (clock += ms),
    setServer: (x: Track[]) => (server = x),
    setFail: (e: Error | null) => (fail = e),
    setNsfw: (v: boolean) => (nsfw.value = v),
  };
}

describe('mergeTracks', () => {
  it('dedupes by id, newer data wins, newest first', () => {
    const old = [t('a', D(1), { saves: 1 }), t('b', D(2))];
    const merged = mergeTracks(old, [t('a', D(1), { saves: 5 }), t('c', D(3))]);
    expect(merged.map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(merged.find((x) => x.id === 'a')!.saves).toBe(5);
  });

  it('orders same-timestamp tracks deterministically', () => {
    expect(mergeTracks([t('x', D(1)), t('y', D(1))], []).map((x) => x.id)).toEqual(['y', 'x']);
  });
});

describe('createCatalog', () => {
  it('first launch does one full fetch and persists it', async () => {
    const s = setup();
    expect(s.cat.status.value).toBe('idle');
    const p = s.cat.refresh();
    expect(s.cat.status.value).toBe('loading');
    await p;
    expect(s.calls).toEqual([undefined]);
    expect(s.cat.status.value).toBe('ready');
    expect(s.cat.tracks.value.map((x) => x.id)).toEqual(['c', 'b', 'a']);
    const saved = JSON.parse(s.storage.data.get(CATALOG_KEY)!);
    expect(saved.v).toBe(1);
    expect(saved.tracks).toHaveLength(3);
    expect(saved.fullAt).toBe(saved.checkedAt);
  });

  it('dedupes concurrent refreshes into one request', async () => {
    const s = setup();
    await Promise.all([s.cat.refresh(), s.cat.refresh(), s.cat.refresh({ force: true })]);
    expect(s.source.catalog).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the cache is younger than an hour (unless forced)', async () => {
    const s = setup();
    await s.cat.refresh();
    s.tick(INCREMENTAL_AFTER_MS - 1);
    await s.cat.refresh();
    expect(s.source.catalog).toHaveBeenCalledTimes(1);
    await s.cat.refresh({ force: true });
    expect(s.source.catalog).toHaveBeenCalledTimes(2);
    expect(s.calls[1]).toEqual(new Date(D(3)));
  });

  it('after an hour fetches only newer posts and merges them', async () => {
    const s = setup();
    await s.cat.refresh();
    s.setServer([t('a', D(1)), t('b', D(2)), t('c', D(3)), t('d', D(4)), t('e', D(5))]);
    s.tick(INCREMENTAL_AFTER_MS);
    await s.cat.refresh();
    expect(s.calls[1]).toEqual(new Date(D(3)));
    expect(s.cat.tracks.value.map((x) => x.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('incremental overlap is deduped', async () => {
    const s = setup();
    await s.cat.refresh();
    // A source that ignores `since` must not create duplicates.
    s.source.catalog.mockImplementationOnce(async () => [t('c', D(3), { saves: 2 }), t('d', D(4))]);
    s.tick(INCREMENTAL_AFTER_MS);
    await s.cat.refresh();
    expect(s.cat.tracks.value.map((x) => x.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(s.cat.tracks.value[1].saves).toBe(2);
  });

  it('after 24 hours does a full refetch that drops deleted posts', async () => {
    const s = setup();
    await s.cat.refresh();
    s.setServer([t('a', D(1), { saves: 9 }), t('c', D(3)), t('d', D(4))]); // b deleted
    s.tick(FULL_AFTER_MS);
    await s.cat.refresh();
    expect(s.calls[1]).toBeUndefined();
    expect(s.cat.tracks.value.map((x) => x.id)).toEqual(['d', 'c', 'a']);
    expect(s.cat.tracks.value[2].saves).toBe(9);
  });

  it('restores from storage and only tops up what is stale', async () => {
    const now = Date.UTC(2026, 9, 8);
    const stored = { v: 1, fullAt: now - 2 * INCREMENTAL_AFTER_MS, checkedAt: now - 2 * INCREMENTAL_AFTER_MS, tracks: [t('a', D(1)), t('b', D(2))] };
    const s = setup({ stored, start: now });
    await s.cat.refresh();
    expect(s.calls).toEqual([new Date(D(2))]);
    expect(s.cat.tracks.value.map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('a fresh cache is used as-is without any request', async () => {
    const now = Date.UTC(2026, 9, 8);
    const s = setup({ stored: { v: 1, fullAt: now - 1000, checkedAt: now - 1000, tracks: [t('a', D(1))] }, start: now });
    await s.cat.refresh();
    expect(s.source.catalog).not.toHaveBeenCalled();
    expect(s.cat.status.value).toBe('ready');
    expect(s.cat.tracks.value).toHaveLength(1);
  });

  it('ignores a corrupt or wrong-version cache', async () => {
    const s = setup({ stored: { v: 2, tracks: [t('zz', D(1))] } });
    await s.cat.refresh();
    expect(s.calls).toEqual([undefined]);
    expect(s.cat.tracks.value.map((x) => x.id)).not.toContain('zz');
  });

  it('offline with no cache is an error state, and recovers on retry', async () => {
    const s = setup();
    s.setFail(Object.assign(new Error('Network unavailable'), { offline: true }));
    await s.cat.refresh();
    expect(s.cat.status.value).toBe('error');
    expect(s.cat.error.value).toEqual({ message: 'Network unavailable', offline: true });
    s.setFail(null);
    await s.cat.refresh();
    expect(s.cat.status.value).toBe('ready');
    expect(s.cat.error.value).toBeNull();
  });

  it('offline with a cache keeps showing the cache', async () => {
    const now = Date.UTC(2026, 9, 8);
    const s = setup({ stored: { v: 1, fullAt: now - FULL_AFTER_MS - 1, checkedAt: 0, tracks: [t('a', D(1))] }, start: now });
    s.setFail(Object.assign(new Error('Network unavailable'), { offline: true }));
    await s.cat.refresh();
    expect(s.cat.status.value).toBe('ready');
    expect(s.cat.tracks.value.map((x) => x.id)).toEqual(['a']);
    expect(s.cat.error.value?.offline).toBe(true);
  });

  it('applies the NSFW setting without refetching', async () => {
    const s = setup({ tracks: [t('a', D(1)), t('n', D(2), { nsfw: true })] });
    await s.cat.refresh();
    expect(s.cat.tracks.value.map((x) => x.id)).toEqual(['a']);
    expect(s.cat.all.value).toHaveLength(2);
    s.setNsfw(true);
    expect(s.cat.tracks.value.map((x) => x.id)).toEqual(['n', 'a']);
    s.setNsfw(false);
    expect(s.cat.tracks.value.map((x) => x.id)).toEqual(['a']);
    expect(s.source.catalog).toHaveBeenCalledTimes(1);
    // NSFW posts are still cached, so turning the setting on later works offline.
    expect(JSON.parse(s.storage.data.get(CATALOG_KEY)!).tracks).toHaveLength(2);
  });
});

describe('mostSaved', () => {
  const now = Date.UTC(2026, 9, 8);
  const tracks = [
    t('old-top', '2026-08-01T00:00:00.000Z', { saves: 9 }),
    t('recent-5', D(5), { saves: 5, replies: 0 }),
    t('recent-5r', D(4), { saves: 5, replies: 3 }),
    t('recent-5n', D(6), { saves: 5, replies: 0 }),
    t('none', D(7), { saves: 0 }),
    t('missing', D(7)),
    t('jazz', D(3), { saves: 7, genre: 'jazz' }),
  ];

  it('all time: by saves, then replies, then newest; skips unsaved', () => {
    expect(mostSaved(tracks, { range: 'all', now }).map((x) => x.id)).toEqual(['old-top', 'jazz', 'recent-5r', 'recent-5n', 'recent-5']);
  });

  it('this month: only the last 30 days', () => {
    expect(mostSaved(tracks, { range: 'month', now }).map((x) => x.id)).toEqual(['jazz', 'recent-5r', 'recent-5n', 'recent-5']);
  });

  it('filters by genre', () => {
    expect(mostSaved(tracks, { range: 'all', genre: 'jazz', now }).map((x) => x.id)).toEqual(['jazz']);
  });
});

describe('genreCounts', () => {
  it('counts genres, most used first, skipping blanks', () => {
    const g = genreCounts([t('1', D(1), { genre: 'pop' }), t('2', D(1), { genre: 'rock' }), t('3', D(1), { genre: 'pop' }), t('4', D(1), { genre: '' })]);
    expect(g).toEqual([
      { name: 'pop', count: 2 },
      { name: 'rock', count: 1 },
    ]);
  });
});

describe('catalog per sign-in state', () => {
  function signedSetup(initialSignedIn: boolean, stored: Record<string, string> = {}) {
    let signedIn = initialSignedIn;
    let clock = Date.UTC(2026, 9, 8);
    const data = new Map(Object.entries(stored));
    const storage = {
      data,
      get: vi.fn(async (k: string) => data.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => void data.set(k, v)),
      remove: vi.fn(async (k: string) => void data.delete(k)),
    };
    let release: (() => void) | null = null;
    let hold = false;
    const source = {
      catalog: vi.fn(async (since?: Date) => {
        const mode = signedIn;
        if (hold) await new Promise<void>((r) => (release = r));
        return mode ? [t('pub', D(1)), t('mem', D(2), { membersOnly: true })].filter((x) => !since || new Date(x.createdAt) > since) : [t('pub', D(1))];
      }),
    };
    const cat = createCatalog({ source, storage, showNsfw: () => false, now: () => clock, storageKey: () => catalogKey(signedIn) });
    return {
      cat,
      storage,
      source,
      setSignedIn: (v: boolean) => (signedIn = v),
      hold: () => (hold = true),
      release: () => {
        hold = false;
        release?.();
      },
      tick: (ms: number) => (clock += ms),
    };
  }

  it('keys the saved catalog by sign-in state', async () => {
    expect(catalogKey(false)).toBe(CATALOG_KEY);
    expect(catalogKey(true)).toBe(CATALOG_MEMBERS_KEY);
    const s = signedSetup(true);
    await s.cat.refresh();
    expect(s.storage.data.has(CATALOG_MEMBERS_KEY)).toBe(true);
    expect(s.storage.data.has(CATALOG_KEY)).toBe(false);
    expect(s.cat.all.value.map((x) => x.id)).toEqual(['mem', 'pub']);
  });

  it('restores only the catalog of the current state', async () => {
    const saved = (ids: string[]) => JSON.stringify({ v: 1, fullAt: Date.UTC(2026, 9, 8), checkedAt: Date.UTC(2026, 9, 8), tracks: ids.map((id) => t(id, D(1))) });
    const s = signedSetup(false, { [CATALOG_KEY]: saved(['public-one']), [CATALOG_MEMBERS_KEY]: saved(['members-one']) });
    await s.cat.refresh();
    expect(s.cat.all.value.map((x) => x.id)).toEqual(['public-one']);
    expect(s.source.catalog).not.toHaveBeenCalled();
  });

  it('reset (sign in or out) clears memory and both saved catalogs, then does a full refresh', async () => {
    const s = signedSetup(false);
    await s.cat.refresh();
    expect(s.cat.all.value.map((x) => x.id)).toEqual(['pub']);
    s.setSignedIn(true);
    await s.cat.reset();
    expect(s.storage.remove).toHaveBeenCalledWith(CATALOG_KEY);
    expect(s.storage.remove).toHaveBeenCalledWith(CATALOG_MEMBERS_KEY);
    expect(s.source.catalog).toHaveBeenCalledTimes(2);
    expect(s.source.catalog.mock.calls[1][0]).toBeUndefined(); // full, not incremental
    expect(s.cat.all.value.map((x) => x.id)).toEqual(['mem', 'pub']);
    expect(s.storage.data.has(CATALOG_KEY)).toBe(false);
    expect(JSON.parse(s.storage.data.get(CATALOG_MEMBERS_KEY)!).tracks).toHaveLength(2);
    // Signing out drops the members-only posts from the phone.
    s.setSignedIn(false);
    await s.cat.reset();
    expect(s.storage.data.has(CATALOG_MEMBERS_KEY)).toBe(false);
    expect(s.cat.all.value.map((x) => x.id)).toEqual(['pub']);
  });

  it('a fetch still running when the state changes is thrown away', async () => {
    const s = signedSetup(true);
    s.hold();
    const old = s.cat.refresh(); // members fetch, held
    await Promise.resolve();
    s.setSignedIn(false);
    const reset = s.cat.reset();
    await Promise.resolve();
    s.release();
    await Promise.all([old, reset]);
    expect(s.cat.all.value.map((x) => x.id)).toEqual(['pub']);
    expect(s.storage.data.has(CATALOG_MEMBERS_KEY)).toBe(false);
  });
});

describe('saving', () => {
  it('writes the tracks only when they changed; the times go to the meta key', async () => {
    const s = setup();
    await s.cat.refresh();
    const trackWrites = () => s.storage.set.mock.calls.filter((c) => c[0] === CATALOG_KEY).length;
    expect(trackWrites()).toBe(1);
    expect(JSON.parse(s.storage.data.get(CATALOG_KEY)!)).toEqual({ v: 1, tracks: expect.any(Array) });
    expect(JSON.parse(s.storage.data.get(CATALOG_KEY + '.meta')!)).toEqual({ fullAt: expect.any(Number), checkedAt: expect.any(Number) });
    s.tick(INCREMENTAL_AFTER_MS + 1);
    await s.cat.refresh(); // nothing new
    expect(trackWrites()).toBe(1);
    s.setServer([t('a', D(1)), t('b', D(2)), t('c', D(3)), t('d', D(4))]);
    s.tick(INCREMENTAL_AFTER_MS + 1);
    await s.cat.refresh();
    expect(trackWrites()).toBe(2);
  });

  it('a run saves under the key it started with', async () => {
    let signedIn = false;
    const data = new Map<string, string>();
    const storage = { get: async (k: string) => data.get(k) ?? null, set: vi.fn(async (k: string, v: string) => void data.set(k, v)) };
    let release!: () => void;
    const source = { catalog: vi.fn(() => new Promise<Track[]>((r) => (release = () => r([t('a', D(1))])))) };
    const cat = createCatalog({ source, storage, showNsfw: () => false, storageKey: () => catalogKey(signedIn) });
    const run = cat.refresh();
    await new Promise((r) => setTimeout(r, 0));
    signedIn = true; // the key would now be the members one
    release();
    await run;
    expect(data.has(CATALOG_KEY)).toBe(true);
    expect(data.has(CATALOG_MEMBERS_KEY)).toBe(false);
  });
});
