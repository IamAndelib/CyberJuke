import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}) }));

const l = await import('./lyrics');
import type { Track } from './model';

const track = (id: string, title = 'Song', artist = 'Artist'): Track => ({
  id, ytId: 'abcdefghijk', title, artist, genre: '', by: '', postTitle: '', postUrl: '', createdAt: '', nsfw: false, artworkUrl: '',
});

describe('cleanTitle', () => {
  it.each([
    ['Bohemian Rhapsody (Official Video)', 'Queen', 'Bohemian Rhapsody'],
    ['Queen - Bohemian Rhapsody (Official Video Remastered)', 'Queen', 'Bohemian Rhapsody'],
    ['Pink + White (slow remix)', 'Frank Ocean', 'Pink + White'],
    ['Get Lucky [slowed + reverb]', 'Daft Punk', 'Get Lucky'],
    ['Get Lucky feat. Pharrell Williams', 'Daft Punk', 'Get Lucky'],
    ['Get Lucky (feat. Pharrell Williams) [Official Audio]', 'Daft Punk', 'Get Lucky'],
    ['Under Pressure - Remastered 2011', 'Queen, David Bowie', 'Under Pressure'],
    ['David Bowie - Under Pressure', 'Queen, David Bowie', 'Under Pressure'],
    ['Plastic Love | Official Music Video', 'Mariya Takeuchi', 'Plastic Love'],
    ['【MV】夜に駆ける', 'YOASOBI', '夜に駆ける'],
    ['Σ\'αγαπώ (Official Lyric Video)', 'Άννα Βίσση', 'Σ\'αγαπώ'],
    ['Despacito ft. Daddy Yankee', 'Luis Fonsi', 'Despacito'],
    ['Dance with Me', 'Artist', 'Dance with Me'],
    ['Song - Part 2', 'Artist', 'Song - Part 2'],
    ['"Quoted"  Title ', 'Artist', 'Quoted Title'],
    ['(Official Video)', 'Artist', '(Official Video)'],
  ])('%s → %s', (title, artist, want) => {
    expect(l.cleanTitle(title, artist)).toBe(want);
  });

  it('cleans the artist to the first credit without " - Topic"', () => {
    expect(l.cleanArtist('Queen - Topic')).toBe('Queen');
    expect(l.cleanArtist('Daft Punk feat. Pharrell Williams')).toBe('Daft Punk');
    expect(l.cleanArtist('Joey Valence & Brae')).toBe('Joey Valence & Brae');
  });
});

describe('parseLrc', () => {
  it('parses lines, sorted, with 2- or 3-digit fractions', () => {
    expect(l.parseLrc('[00:12.50]Second\n[00:01.00]First\n[01:02.123]Third')).toEqual([
      { t: 1000, text: 'First' },
      { t: 12500, text: 'Second' },
      { t: 62123, text: 'Third' },
    ]);
  });

  it('expands several timestamps on one line', () => {
    expect(l.parseLrc('[00:10.00][00:30.00][01:00]Chorus')).toEqual([
      { t: 10000, text: 'Chorus' },
      { t: 30000, text: 'Chorus' },
      { t: 60000, text: 'Chorus' },
    ]);
  });

  it('applies [offset:] (positive = sooner) and ignores metadata tags', () => {
    expect(l.parseLrc('[ar:Someone]\n[ti:Song]\n[offset:+500]\n[00:02.00]A\n[00:00.20]B')).toEqual([
      { t: 0, text: 'B' },
      { t: 1500, text: 'A' },
    ]);
    expect(l.parseLrc('[offset:-250]\n[00:01.00]A')).toEqual([{ t: 1250, text: 'A' }]);
  });

  it('keeps timed blank lines as breaks and drops untimed and empty lines', () => {
    expect(l.parseLrc('\n[00:01.00]A\n\nloose text\n[00:05.00]\n[00:07.00] B \r\n')).toEqual([
      { t: 1000, text: 'A' },
      { t: 5000, text: '' },
      { t: 7000, text: 'B' },
    ]);
  });

  it('keeps brackets inside the text', () => {
    expect(l.parseLrc('[00:01.00]Hey [yeah] [00:02.00]')).toEqual([{ t: 1000, text: 'Hey [yeah] [00:02.00]' }]);
  });

  it('handles non-Latin scripts', () => {
    expect(l.parseLrc('[00:01.00]夜に駆ける\n[00:02.00]حبيبي يا نور العين')).toEqual([
      { t: 1000, text: '夜に駆ける' },
      { t: 2000, text: 'حبيبي يا نور العين' },
    ]);
  });
});

describe('activeLine', () => {
  const lines = [{ t: 1000, text: 'a' }, { t: 2000, text: 'b' }, { t: 3000, text: 'c' }];
  it('finds the line being sung', () => {
    expect(l.activeLine(lines, 0)).toBe(-1);
    expect(l.activeLine(lines, 1000)).toBe(0);
    expect(l.activeLine(lines, 2999)).toBe(1);
    expect(l.activeLine(lines, 99999)).toBe(2);
    expect(l.activeLine([], 5)).toBe(-1);
  });
});

describe('normalizeLyrics', () => {
  it('keeps synced, plain, instrumental and the source', () => {
    expect(l.normalizeLyrics({ found: true, source: 'LRCLIB', synced: [{ t: 2000, text: ' b ' }, { t: 1000, text: 'a' }], plain: 'a\nb' })).toEqual({
      found: true,
      source: 'LRCLIB',
      synced: [{ t: 1000, text: 'a' }, { t: 2000, text: 'b' }],
      plain: 'a\nb',
    });
    expect(l.normalizeLyrics({ found: true, instrumental: true })).toEqual({ found: true, instrumental: true });
  });

  it('parses LRC that arrives as plain text, and treats empty results as not found', () => {
    expect(l.normalizeLyrics({ found: true, plain: '[00:01.00]A' }).synced).toEqual([{ t: 1000, text: 'A' }]);
    expect(l.normalizeLyrics({ found: true, plain: '  ' })).toEqual({ found: false });
    expect(l.normalizeLyrics({ found: false, plain: 'x' })).toEqual({ found: false });
    expect(l.normalizeLyrics(null)).toEqual({ found: false });
  });
});

describe('lyrics client cache', () => {
  function setup(max = 300) {
    let now = 0;
    const store = new Map<string, string>();
    const plugin = { lyrics: vi.fn(async ({ title }: { title: string }) => (title === 'Nope' ? { found: false } : { found: true, source: 'LRCLIB', plain: 'la la' })) };
    const c = l.createLyricsClient({
      plugin: () => plugin,
      storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      now: () => now,
      max,
    });
    return { c, plugin, store, tick: (ms: number) => (now += ms) };
  }

  it('signing out drops the lyrics of members-only tracks only', async () => {
    const { c, plugin, store } = setup();
    await c.get({ ...track('m'), membersOnly: true });
    await c.get(track('p'));
    expect(c.peek('m')).toBeDefined();
    await c.dropMembersOnly();
    expect(c.peek('m')).toBeUndefined();
    expect(c.peek('p')).toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(store.get(l.LYRICS_CACHE_KEY)!).map((e: [string]) => e[0])).toEqual(['p']);
    await c.get({ ...track('m'), membersOnly: true });
    expect(plugin.lyrics).toHaveBeenCalledTimes(3);
  });

  it('a members-only lookup that answers after signing out is not kept', async () => {
    const { c, plugin, store } = setup();
    let answer: () => void = () => {};
    plugin.lyrics.mockImplementationOnce(() => new Promise((r) => (answer = () => r({ found: true, source: 'LRCLIB', plain: 'secret' }))));
    const got = c.get({ ...track('m'), membersOnly: true });
    await vi.waitFor(() => expect(plugin.lyrics).toHaveBeenCalled());
    await c.dropMembersOnly();
    answer();
    expect((await got).status).toBe('ok');
    expect(c.peek('m')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get(l.LYRICS_CACHE_KEY) ?? '').not.toContain('secret');
  });

  it('looks up with cleaned metadata and caches found results', async () => {
    const { c, plugin } = setup();
    const r = await c.get(track('1', 'Song (Official Video)', 'Artist - Topic'), 201_400);
    expect(r).toEqual({ status: 'ok', lyrics: { found: true, source: 'LRCLIB', plain: 'la la' } });
    expect(plugin.lyrics).toHaveBeenCalledWith({ ytId: 'abcdefghijk', title: 'Song', artist: 'Artist', durationSec: 201 });
    await c.get(track('1'));
    expect(plugin.lyrics).toHaveBeenCalledTimes(1);
    expect(c.peek('1')?.found).toBe(true);
  });

  it('caches "not found" for 7 days', async () => {
    const { c, plugin, tick } = setup();
    await c.get(track('2', 'Nope'));
    tick(l.NOT_FOUND_TTL_MS - 1);
    expect((await c.get(track('2', 'Nope'))).status).toBe('ok');
    expect(plugin.lyrics).toHaveBeenCalledTimes(1);
    tick(1);
    await c.get(track('2', 'Nope'));
    expect(plugin.lyrics).toHaveBeenCalledTimes(2);
  });

  it('is an LRU: the least recently used entry goes first', async () => {
    const { c, plugin } = setup(2);
    await c.get(track('a'));
    await c.get(track('b'));
    await c.get(track('a')); // a is now most recent
    await c.get(track('c')); // evicts b
    expect(c.peek('a')).toBeDefined();
    expect(c.peek('b')).toBeUndefined();
    expect(plugin.lyrics).toHaveBeenCalledTimes(3);
  });

  it('writes the cache file once for lookups close together (the track and the next)', async () => {
    vi.useFakeTimers();
    try {
      const store = new Map<string, string>();
      const set = vi.fn(async (k: string, v: string) => void store.set(k, v));
      const c = l.createLyricsClient({ plugin: () => ({ lyrics: async () => ({ found: true, plain: 'x' }) }), storage: { get: async () => null, set } });
      await c.get(track('a'));
      await c.get(track('b'));
      expect(set).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(l.LYRICS_PERSIST_MS);
      expect(set).toHaveBeenCalledTimes(1);
      expect(JSON.parse(store.get(l.LYRICS_CACHE_KEY)!).map((e: [string]) => e[0])).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists and restores the cache', async () => {
    const { c, store } = setup();
    await c.get(track('a'));
    await new Promise((r) => setTimeout(r, l.LYRICS_PERSIST_MS + 50));
    const c2 = l.createLyricsClient({
      plugin: () => ({ lyrics: vi.fn() }),
      storage: { get: async (k) => store.get(k) ?? null, set: async () => {} },
    });
    expect((await c2.get(track('a'))).status).toBe('ok');
  });

  it('never caches failures and reports offline', async () => {
    const plugin = { lyrics: vi.fn().mockRejectedValueOnce({ code: 'NETWORK', message: 'NETWORK: down' }).mockResolvedValue({ found: true, plain: 'x' }) };
    const c = l.createLyricsClient({ plugin: () => plugin, storage: { get: async () => null, set: async () => {} } });
    expect(await c.get(track('a'))).toEqual({ status: 'error', offline: true });
    expect((await c.get(track('a'))).status).toBe('ok');
    const none = l.createLyricsClient({ plugin: () => null, storage: { get: async () => null, set: async () => {} } });
    expect(await none.get(track('a'))).toEqual({ status: 'error', offline: false });
  });
});

describe('kept lyrics of saved liked songs', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  function setup(max = 300) {
    const store = new Map<string, string>();
    const keptStore = new Map<string, string>();
    let offline = false;
    const plugin = {
      lyrics: vi.fn(async ({ title, durationSec }: { title: string; durationSec?: number }) =>
        title === 'Nope' ? { found: false } : { found: true, source: 'LRCLIB', plain: durationSec ? `matched ${durationSec}` : 'any length' },
      ),
    };
    const c = l.createLyricsClient({
      plugin: () => plugin,
      storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      keptStorage: { get: async (k) => keptStore.get(k) ?? null, set: async (k, v) => void keptStore.set(k, v) },
      max,
      isOffline: () => offline,
      pause: async () => {},
    });
    // The kept file is written a moment after the last change.
    const keptIds = async () => {
      await vi.advanceTimersByTimeAsync(l.LYRICS_PERSIST_MS);
      return (JSON.parse(keptStore.get(l.LYRICS_CACHE_KEY) ?? '[]') as [string][]).map((e) => e[0]);
    };
    return { c, plugin, store, keptIds, goOffline: () => (offline = true) };
  }

  it('looks up the saved songs it has no lyrics for, once, and keeps them out of the LRU', async () => {
    const { c, plugin, keptIds } = setup(1);
    await c.keepSaved([track('a'), track('b')], new Set(['a', 'b', 'c']));
    // Looked up in the background (no length yet), one after the other.
    expect(plugin.lyrics).toHaveBeenCalledTimes(2);
    expect(plugin.lyrics.mock.calls[0][0]).not.toHaveProperty('durationSec');
    expect(await keptIds()).toEqual(['a', 'b']);
    // A one-entry LRU would have let 'a' go: kept, it stays, and nothing is asked again.
    await c.get(track('c'));
    expect(c.peek('a')?.found).toBe(true);
    await c.keepSaved([track('a'), track('b')], new Set(['a', 'b', 'c']));
    expect(plugin.lyrics).toHaveBeenCalledTimes(3);
  });

  it('keeps lyrics already looked up, and lets go of unliked songs but never on an empty Liked', async () => {
    const { c, plugin, keptIds } = setup();
    await c.get(track('a'), 200_000);
    await c.keepSaved([track('a')], new Set(['a']));
    expect(plugin.lyrics).toHaveBeenCalledTimes(1);
    expect(await keptIds()).toEqual(['a']);
    await c.keepSaved([], new Set());
    expect(await keptIds()).toEqual(['a']);
    await c.keepSaved([], new Set(['z']));
    expect(await keptIds()).toEqual([]);
  });

  it('offline it shows the kept lyrics; online, ones looked up without a length are matched again once', async () => {
    const { c, plugin } = setup();
    await c.keepSaved([track('a')], new Set(['a']));
    expect((await c.get(track('a'), 200_000)).status).toBe('ok');
    expect(c.peek('a')).toMatchObject({ plain: 'matched 200' });
    expect(plugin.lyrics).toHaveBeenCalledTimes(2);
    await c.get(track('a'), 200_000);
    expect(plugin.lyrics).toHaveBeenCalledTimes(2);
    const other = setup();
    await other.c.keepSaved([track('b')], new Set(['b']));
    other.goOffline();
    expect(await other.c.get(track('b'), 180_000)).toEqual({ status: 'ok', lyrics: { found: true, source: 'LRCLIB', plain: 'any length' } });
    expect(other.plugin.lyrics).toHaveBeenCalledTimes(1);
  });

  it('nothing is looked up offline, and signing out drops kept members-only lyrics', async () => {
    const offline = setup();
    offline.goOffline();
    await offline.c.keepSaved([track('a')], new Set(['a']));
    expect(offline.plugin.lyrics).not.toHaveBeenCalled();
    const { c, keptIds } = setup();
    await c.keepSaved([{ ...track('m'), membersOnly: true }, track('p')], new Set(['m', 'p']));
    expect(await keptIds()).toEqual(['m', 'p']);
    await c.dropMembersOnly();
    expect(await keptIds()).toEqual(['p']);
    expect(c.peek('m')).toBeUndefined();
  });

  it("a saved song's lookups stay out of the recent-lyrics cache, and \"not found\" isn't asked again", async () => {
    const { c, plugin, store } = setup(1);
    await c.get(track('recent'), 200_000);
    await c.keepSaved([track('a', 'Nope'), track('b')], new Set(['a', 'b', 'recent']));
    expect(plugin.lyrics).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(l.LYRICS_PERSIST_MS);
    // The one-entry cache still holds the lyrics opened last.
    expect(JSON.parse(store.get(l.LYRICS_CACHE_KEY)!).map((e: [string]) => e[0])).toEqual(['recent']);
    await c.keepSaved([track('a', 'Nope'), track('b')], new Set(['a', 'b', 'recent']));
    await c.get(track('a', 'Nope'));
    expect(plugin.lyrics).toHaveBeenCalledTimes(3);
  });

  it('a liked song no longer saved is matched with its length once, then never asked again', async () => {
    const { c, plugin } = setup();
    await c.keepSaved([track('a')], new Set(['a']));
    // Its audio left the phone; it's still liked, so its lyrics stay kept.
    await c.keepSaved([], new Set(['a']));
    await c.get(track('a'), 200_000);
    await c.get(track('a'), 200_000);
    expect(plugin.lyrics).toHaveBeenCalledTimes(2);
    expect(c.peek('a')).toMatchObject({ plain: 'matched 200' });
  });

  it('signing out mid-way: the members-only songs still to look up are not looked up', async () => {
    const { c, plugin, keptIds } = setup();
    let release: () => void = () => {};
    plugin.lyrics.mockImplementationOnce(() => new Promise((r) => (release = () => r({ found: true, source: 'LRCLIB', plain: 'p' }))));
    const running = c.keepSaved([track('p'), { ...track('m'), membersOnly: true }], new Set(['p', 'm']));
    await vi.waitFor(() => expect(plugin.lyrics).toHaveBeenCalledTimes(1));
    await c.dropMembersOnly();
    release();
    await running;
    expect(plugin.lyrics).toHaveBeenCalledTimes(1);
    expect(await keptIds()).toEqual(['p']);
  });
});
