import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void store.set(key, value),
  },
}));

const lib = await import('./library');
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => store.clear());

describe('theme migration', () => {
  it('migrates a saved GRiD theme to Brutalist and saves it', async () => {
    store.set('settings', JSON.stringify({ theme: 'grid', showNsfw: true, quality: 'low' }));
    await lib.loadLibrary();
    expect(lib.settings.value).toEqual({ theme: 'brutalist', showNsfw: true, quality: 'low' });
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
