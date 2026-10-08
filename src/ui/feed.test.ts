import { describe, expect, it, vi } from 'vitest';
import { Feed, FeedCache, type FeedPage } from './feed';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Pages of numbers: cursor n → [n, n+1, n+2], three pages in all. */
function pages() {
  return vi.fn(async (c: number | null): Promise<FeedPage<number, number>> => {
    const start = c ?? 0;
    return { items: [start, start + 1, start + 2], cursor: start + 3 < 9 ? start + 3 : null };
  });
}

describe('FeedCache (usePaged cache)', () => {
  it('gives a remount everything already loaded, without refetching', async () => {
    const cache = new FeedCache();
    const loader = pages();
    const a = cache.get('home', loader);
    a.start();
    await flush();
    a.loadMore();
    await flush();
    expect(a.snapshot.items).toEqual([0, 1, 2, 3, 4, 5]);
    expect(loader).toHaveBeenCalledTimes(2);

    // "Remount": same key, new loader closure.
    const loader2 = pages();
    const b = cache.get('home', loader2);
    expect(b).toBe(a);
    b.start();
    expect(b.snapshot).toMatchObject({ items: [0, 1, 2, 3, 4, 5], status: 'ready', hasMore: true });
    expect(loader2).not.toHaveBeenCalled();
    // Paging continues from the saved cursor with the latest loader.
    b.loadMore();
    await flush();
    expect(loader2).toHaveBeenCalledWith(6);
    expect(b.snapshot.items).toHaveLength(9);
    expect(b.snapshot.hasMore).toBe(false);
  });

  it('keeps separate keys apart and evicts the least recently used', () => {
    const cache = new FeedCache(2);
    const a = cache.get('a', pages());
    cache.get('b', pages());
    cache.get('a', pages()); // touch a
    cache.get('c', pages());
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.get('a', pages())).toBe(a);
  });

  it('refresh reloads the first page and keeps showing old items meanwhile', async () => {
    const cache = new FeedCache();
    let gen = 0;
    const f = cache.get('k', async () => ({ items: [++gen], cursor: null }));
    f.start();
    await flush();
    expect(f.snapshot.items).toEqual([1]);
    const p = f.refresh();
    expect(f.snapshot.items).toEqual([1]);
    expect(f.snapshot.status).toBe('ready');
    await p;
    expect(f.snapshot.items).toEqual([2]);
  });

  it('retries a failed first page on the next start, but not a loaded one', async () => {
    const loader = vi.fn().mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'BOT_CHECK' })).mockResolvedValue({ items: [1], cursor: null });
    const f = new Feed<number, number>(loader);
    f.start();
    await flush();
    expect(f.snapshot.status).toBe('error');
    expect(f.snapshot.error).toMatchObject({ message: 'nope', code: 'BOT_CHECK' });
    f.start();
    await flush();
    expect(f.snapshot.status).toBe('ready');
    f.start();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates by id, reports pages, and can treat a paging failure as the end', async () => {
    const onPage = vi.fn();
    const loader = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'a' }, { id: 'b' }], cursor: 'x' })
      .mockRejectedValueOnce(new Error('expired paging token'));
    const f = new Feed<{ id: string }, string>(loader, { id: (i) => i.id, onPage, isEnd: (e) => /expired/.test(String(e)) });
    f.start();
    await flush();
    expect(onPage).toHaveBeenCalledWith([{ id: 'a' }, { id: 'b' }]);
    f.loadMore();
    await flush();
    expect(f.snapshot).toMatchObject({ hasMore: false, error: null, status: 'ready' });
  });

  it('notifies subscribers and keeps a stable snapshot between changes', async () => {
    const f = new Feed<number, number>(pages());
    const fn = vi.fn();
    const un = f.subscribe(fn);
    const s0 = f.snapshot;
    expect(f.snapshot).toBe(s0);
    f.start();
    await flush();
    expect(fn).toHaveBeenCalled();
    expect(f.snapshot).not.toBe(s0);
    un();
    fn.mockClear();
    f.loadMore();
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });
});
