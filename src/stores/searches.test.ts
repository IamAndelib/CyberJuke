import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/preferences', () => ({ Preferences: {} }));

const { addRecentSearch, clearRecentSearches, loadRecentSearches, recentSearches, restoreRecentSearches, setSearchesStorage } = await import('./searches');

function memKV(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void data.set(k, v)),
    remove: vi.fn(async (k: string) => void data.delete(k)),
  };
}

describe('recent searches', () => {
  it('a search added before the stored list is read is merged with it, and the merge is saved', async () => {
    const kv = memKV({ recentSearches: JSON.stringify(['daft punk', 'boards of canada']) });
    setSearchesStorage(kv);
    addRecentSearch('aphex twin');
    await loadRecentSearches();
    await new Promise((r) => setTimeout(r, 0));
    expect(recentSearches.value).toEqual(['aphex twin', 'daft punk', 'boards of canada']);
    expect(JSON.parse(kv.data.get('recentSearches')!)).toEqual(['aphex twin', 'daft punk', 'boards of canada']);
  });

  it('nothing is written when the stored list is just read', async () => {
    const kv = memKV({ recentSearches: JSON.stringify(['a b']) });
    setSearchesStorage(kv);
    await loadRecentSearches();
    expect(kv.set).not.toHaveBeenCalled();
  });

  it('clear all empties and saves the list; restore brings it back after newer searches', async () => {
    const kv = memKV({ recentSearches: JSON.stringify(['b one', 'c two']) });
    setSearchesStorage(kv);
    await loadRecentSearches();
    const old = clearRecentSearches();
    expect(old).toEqual(['b one', 'c two']);
    expect(recentSearches.value).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(kv.data.get('recentSearches')!)).toEqual([]);
    addRecentSearch('a new');
    restoreRecentSearches(old);
    expect(recentSearches.value).toEqual(['a new', 'b one', 'c two']);
  });
});
