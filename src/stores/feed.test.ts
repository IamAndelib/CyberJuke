import { describe, expect, it, vi } from 'vitest';
import { Feed, FeedCache, JUKEBOX_FEED_PREFIXES, authScope, fillFeed, isFilling, retryWatchedFeeds, type FeedPage } from './feed';

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

  it('a refresh that fails keeps the list as it was (no error at its end) and says it failed', async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce({ items: [1, 2], cursor: 2 })
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { offline: true }));
    const f = new Feed<number, number>(loader);
    f.start();
    await flush();
    const failed = await f.refresh();
    expect(failed).toMatchObject({ message: 'offline' });
    expect(f.snapshot).toMatchObject({ items: [1, 2], status: 'ready', error: null, hasMore: true });
    // A refresh that works says nothing.
    loader.mockResolvedValueOnce({ items: [3], cursor: null });
    expect(await f.refresh()).toBeNull();
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

describe('feed keys per sign-in state', () => {
  it('scopes Jukebox lists by sign-in state and drops them all on a change', () => {
    expect(authScope(true)).toBe('m');
    expect(authScope(false)).toBe('p');
    const cache = new FeedCache();
    const loader = pages();
    for (const k of ['home:p::false', 'home:m:rock:false', 'genre:p:rock:false', 'artistpage:queen', 'album:x']) cache.get(k, loader);
    cache.deletePrefix(...JUKEBOX_FEED_PREFIXES);
    expect(cache.entries().map(([k]) => k)).toEqual(['artistpage:queen', 'album:x']);
  });
});

describe('fillFeed (an artist\'s whole song list for Here search)', () => {
  /** Ten pages of 10 numbers; `failAt` cursors reject once. */
  function tens(failAt: number[] = []) {
    const failed = new Set<number>();
    return vi.fn(async (c: number | null): Promise<FeedPage<number, number>> => {
      const start = c ?? 0;
      if (failAt.includes(start) && !failed.has(start)) {
        failed.add(start);
        throw new Error('NETWORK: timeout');
      }
      return { items: Array.from({ length: 10 }, (_, i) => start + i), cursor: start + 10 < 100 ? start + 10 : null };
    });
  }
  const settle = async () => {
    for (let i = 0; i < 30; i++) await flush();
  };

  it('loads page after page up to the cap, then stops', async () => {
    const loader = tens();
    const feed = new Feed(loader);
    fillFeed(feed, 35);
    expect(isFilling(feed.snapshot, 35)).toBe(true);
    await settle();
    expect(feed.snapshot.items).toHaveLength(40);
    expect(loader).toHaveBeenCalledTimes(4);
    expect(isFilling(feed.snapshot, 35)).toBe(false);
    expect(feed.watched).toBe(false); // unsubscribed when done
  });

  it('loads a short list to the end', async () => {
    const feed = new Feed(tens());
    fillFeed(feed, 300);
    await settle();
    expect(feed.snapshot.items).toHaveLength(100);
    expect(feed.snapshot.hasMore).toBe(false);
    expect(isFilling(feed.snapshot, 300)).toBe(false);
  });

  it('is idempotent while running', async () => {
    const loader = tens();
    const feed = new Feed(loader);
    fillFeed(feed, 30);
    fillFeed(feed, 30);
    await settle();
    expect(loader).toHaveBeenCalledTimes(3);
    expect(feed.snapshot.items).toHaveLength(30);
  });

  it('stops at a failed page and retries it once on the next call', async () => {
    const loader = tens([20]);
    const feed = new Feed(loader);
    fillFeed(feed, 50);
    await settle();
    expect(feed.snapshot.items).toHaveLength(20);
    expect(feed.snapshot.error).not.toBeNull();
    expect(isFilling(feed.snapshot, 50)).toBe(false);
    fillFeed(feed, 50);
    await settle();
    expect(feed.snapshot.items).toHaveLength(50);
    expect(feed.snapshot.error).toBeNull();
  });

  it('continues a feed whose first page is already loaded', async () => {
    const loader = tens();
    const feed = new Feed(loader);
    feed.start();
    await settle();
    fillFeed(feed, 20);
    await settle();
    expect(feed.snapshot.items).toHaveLength(20);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('FeedCache eviction (W4)', () => {
  const page = (n: number) => () => Promise.resolve({ items: [n], cursor: null });

  it('never evicts a feed on screen, loading, or being filled', async () => {
    const cache = new FeedCache(2);
    const watched = cache.get('w', page(1));
    const un = watched.subscribe(() => {});
    let release!: () => void;
    const slow = cache.get('slow', () => new Promise<FeedPage<number, null>>((r) => (release = () => r({ items: [2], cursor: null }))));
    slow.start();
    cache.get('a', page(3));
    cache.get('b', page(4));
    expect(cache.has('w')).toBe(true);
    expect(cache.has('slow')).toBe(true);
    expect(cache.has('a')).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 0));
    cache.get('c', page(5));
    expect(cache.has('slow')).toBe(false);
    expect(cache.has('w')).toBe(true);
    un();
    cache.get('d', page(6));
    expect(cache.has('w')).toBe(false);
  });

  it('obtain creates without reordering or evicting; touch does both', () => {
    const cache = new FeedCache(1);
    cache.get('a', page(1));
    const b = cache.obtain('b', page(2));
    expect(cache.has('a')).toBe(true);
    expect(cache.obtain('b', page(3))).toBe(b);
    cache.touch('b');
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });
});

describe('retryWatchedFeeds (W6)', () => {
  it('retries failed feeds that are on screen, and only those', async () => {
    const cache = new FeedCache();
    let fail = true;
    const loader = vi.fn(() => (fail ? Promise.reject(Object.assign(new Error('offline'), { offline: true })) : Promise.resolve({ items: [1], cursor: null })));
    const shown = cache.get('shown', loader);
    const hidden = cache.get('hidden', loader);
    const un = shown.subscribe(() => {});
    shown.start();
    hidden.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(shown.snapshot.status).toBe('error');
    fail = false;
    retryWatchedFeeds([cache]);
    await new Promise((r) => setTimeout(r, 0));
    expect(shown.snapshot.status).toBe('ready');
    expect(hidden.snapshot.status).toBe('error');
    un();
  });
});
