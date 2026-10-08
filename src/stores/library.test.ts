import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void store.set(key, value),
    remove: async ({ key }: { key: string }) => void store.delete(key),
  },
}));

// The browser fallback for files: localStorage, here a Map.
const files = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => files.get(k) ?? null,
  setItem: (k: string, v: string) => void files.set(k, v),
  removeItem: (k: string) => void files.delete(k),
};
const HISTORY_FILE = 'cyberjuke.file:data/cyberjuke/history.json';

const lib = await import('./library');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store.clear();
  files.clear();
});

describe('theme migration', () => {
  it('migrates a saved GRiD theme to Brutalist and saves it', async () => {
    store.set('settings', JSON.stringify({ theme: 'grid', showNsfw: true, quality: 'low' }));
    await lib.loadLibrary();
    expect(lib.settings.value).toEqual({ theme: 'brutalist', showNsfw: true, quality: 'low', checkEvery: 15, preferIpv4: false, autoplay: true });
    await flush();
    expect(JSON.parse(store.get('settings')!).theme).toBe('brutalist');
  });

  it('keeps valid themes and resets unknown ones', async () => {
    store.set('settings', JSON.stringify({ theme: 'vt320' }));
    await lib.loadLibrary();
    expect(lib.settings.value.theme).toBe('vt320');
    store.set('settings', JSON.stringify({ theme: 'nope' }));
    await lib.loadLibrary();
    expect(lib.settings.value.theme).toBe('dark');
  });

  it('lists Brutalist and not GRiD', () => {
    expect(lib.THEMES).toContain('brutalist');
    expect(lib.THEMES as readonly string[]).not.toContain('grid');
    expect(lib.THEME_LABELS.brutalist).toBe('Brutalist');
  });
});

describe('favorite genres', () => {
  it('toggles, keeps insertion order and persists under favGenres', async () => {
    await lib.loadLibrary();
    expect(lib.favoriteGenres.value).toEqual([]);
    expect(lib.toggleFavoriteGenre('jazz')).toBe(true);
    expect(lib.toggleFavoriteGenre('city pop')).toBe(true);
    expect(lib.toggleFavoriteGenre('ambient')).toBe(true);
    expect(lib.favoriteGenres.value).toEqual(['jazz', 'city pop', 'ambient']);
    expect(lib.isFavoriteGenre('city pop')).toBe(true);
    expect(lib.toggleFavoriteGenre('city pop')).toBe(false);
    expect(lib.isFavoriteGenre('city pop')).toBe(false);
    expect(lib.favoriteGenres.value).toEqual(['jazz', 'ambient']);
    await flush();
    expect(JSON.parse(store.get('favGenres')!)).toEqual(['jazz', 'ambient']);
  });

  it('loads saved favorites, dropping junk and duplicates', async () => {
    store.set('favGenres', JSON.stringify(['rock', 3, '', 'rock', 'folk', null]));
    await lib.loadLibrary();
    expect(lib.favoriteGenres.value).toEqual(['rock', 'folk']);
    store.set('favGenres', '{"not":"an array"}');
    await lib.loadLibrary();
    expect(lib.favoriteGenres.value).toEqual([]);
  });
});

describe('favorite artists', () => {
  it('toggles by normalized name, keeps insertion order and persists under favArtists', async () => {
    await lib.loadLibrary();
    expect(lib.favoriteArtists.value).toEqual([]);
    expect(lib.toggleFavoriteArtist('Björk')).toBe(true);
    expect(lib.toggleFavoriteArtist('The Jesus and Mary Chain')).toBe(true);
    expect(lib.isFavoriteArtist('bjork')).toBe(true);
    expect(lib.favoriteArtists.value).toEqual(['Björk', 'The Jesus and Mary Chain']);
    expect(lib.toggleFavoriteArtist('BJORK')).toBe(false);
    expect(lib.favoriteArtists.value).toEqual(['The Jesus and Mary Chain']);
    await flush();
    expect(JSON.parse(store.get('favArtists')!)).toEqual(['The Jesus and Mary Chain']);
  });

  it('loads saved favorites, dropping junk and duplicate spellings', async () => {
    store.set('favArtists', JSON.stringify(['Björk', 'bjork', 7, '', 'Aphex Twin']));
    await lib.loadLibrary();
    expect(lib.favoriteArtists.value).toEqual(['Björk', 'Aphex Twin']);
  });
});

describe('check interval setting', () => {
  it('defaults to 15 minutes, keeps valid choices and resets junk', async () => {
    await lib.loadLibrary();
    expect(lib.settings.value.checkEvery).toBe(15);
    lib.updateSettings({ checkEvery: 0 });
    await flush();
    await lib.loadLibrary();
    expect(lib.settings.value.checkEvery).toBe(0);
    store.set('settings', JSON.stringify({ checkEvery: 7 }));
    await lib.loadLibrary();
    expect(lib.settings.value.checkEvery).toBe(15);
    expect(lib.CHECK_EVERY_OPTIONS).toEqual([5, 15, 30, 60, 0]);
  });
});

describe('history in the library', () => {
  const tr = (id: string, extra: Record<string, unknown> = {}) => ({ ...extra, id, ytId: 'abcdefghij' + id.slice(-1), title: id, artist: 'A', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '', nsfw: false, artworkUrl: '' });

  it('migrates the old untimed list under "recent" into the history file, keeping order', async () => {
    store.set('recent', JSON.stringify([tr('a'), tr('b'), { junk: 1 }, tr('c')]));
    await lib.loadLibrary();
    expect(lib.recent.value.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(lib.history.value.every((e) => typeof e.playedAt === 'number')).toBe(true);
    await flush();
    const saved = JSON.parse(files.get(HISTORY_FILE)!);
    expect(saved.v).toBe(2);
    expect(saved.plays.map((p: { id: string }) => p.id)).toEqual(['a', 'b', 'c']);
    expect(store.has('recent')).toBe(false);
    expect(store.has('history')).toBe(false);
  });

  it('migrates timed history from Preferences once, then reads the file', async () => {
    const now = Date.now();
    store.set('history', JSON.stringify([{ track: tr('a'), playedAt: now }, { track: tr('b'), playedAt: now - 1000 }, { track: tr('a'), playedAt: now - 86_400_000 }]));
    await lib.loadLibrary();
    expect(lib.history.value.map((e) => e.track.id)).toEqual(['a', 'b', 'a']);
    await flush();
    expect(store.has('history')).toBe(false);
    const saved = JSON.parse(files.get(HISTORY_FILE)!);
    // Each track stored once.
    expect(Object.keys(saved.tracks).sort()).toEqual(['a', 'b']);
    expect(saved.plays).toHaveLength(3);
    // A second start reads the file; nothing is written when nothing changed.
    const before = files.get(HISTORY_FILE);
    files.set(HISTORY_FILE, before!);
    await lib.loadLibrary();
    expect(lib.history.value.map((e) => e.track.id)).toEqual(['a', 'b', 'a']);
  });

  it('drops members-only tracks from Liked and history', async () => {
    await lib.loadLibrary();
    lib.toggleLike(tr('a', { membersOnly: true }));
    lib.toggleLike(tr('b'));
    lib.addRecent(tr('c', { membersOnly: true }));
    lib.addRecent(tr('d'));
    lib.dropMembersOnly();
    expect(lib.liked.value.map((t) => t.id)).toEqual(['b']);
    expect(lib.recent.value.map((t) => t.id)).toEqual(['d']);
    await flush();
    expect(JSON.parse(store.get('liked')!).map((t: { id: string }) => t.id)).toEqual(['b']);
    expect(Object.keys(JSON.parse(files.get(HISTORY_FILE)!).tracks)).toEqual(['d']);
  });

  it('records plays once per day and clears', async () => {
    await lib.loadLibrary();
    const day = new Date(2026, 9, 8, 12).getTime();
    lib.addRecent(tr('a'), day);
    lib.addRecent(tr('b'), day + 1000);
    lib.addRecent(tr('a'), day + 2000);
    expect(lib.history.value.map((e) => e.track.id)).toEqual(['a', 'b']);
    lib.addRecent(tr('a'), day + 86_400_000);
    expect(lib.history.value.map((e) => e.track.id)).toEqual(['a', 'a', 'b']);
    expect(lib.recent.value.map((t) => t.id)).toEqual(['a', 'b']);
    expect(lib.knownTrack('b')?.id).toBe('b');
    lib.clearRecent();
    expect(lib.recent.value).toEqual([]);
  });
});
