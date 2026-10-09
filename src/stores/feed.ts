/**
 * Paged lists that survive remounts. A Feed holds one list's pages (items, cursor,
 * status) outside any component, and `feedFor` keeps one Feed per key in a
 * module-level cache, so leaving a screen and coming back gets everything already
 * loaded instantly, with no refetch. Pure TS, no Preact: hooks subscribe to it.
 */
import { toLoadError, type LoadError } from '../core/errors';
import { online } from '../core/network';

export type FeedStatus = 'loading' | 'ready' | 'error';

export interface FeedPage<T, C, M = undefined> {
  items: T[];
  cursor: C | null;
  /** Extra data from the first page (e.g. an album's title and cover). */
  meta?: M;
}

export type FeedLoader<T, C, M = undefined> = (cursor: C | null) => Promise<FeedPage<T, C, M>>;

export interface FeedSnapshot<T, M = undefined> {
  items: T[];
  status: FeedStatus;
  error: LoadError | null;
  hasMore: boolean;
  loadingMore: boolean;
  meta?: M;
}

export interface FeedOptions<T> {
  /** Called with every page that arrives (e.g. to learn genres). */
  onPage?: (items: T[]) => void;
  /** Identity for de-duplication across pages. */
  id?: (item: T) => string;
  /** Turn a loadMore rejection into "no more pages" instead of an error. */
  isEnd?: (e: unknown) => boolean;
}

export class Feed<T, C, M = undefined> {
  private items: T[] = [];
  private cursor: C | null = null;
  private meta: M | undefined;
  private status: FeedStatus = 'loading';
  private error: LoadError | null = null;
  private loadingMore = false;
  private started = false;
  private gen = 0;
  private busy = false;
  private listeners = new Set<() => void>();
  private snap: FeedSnapshot<T, M> | null = null;

  constructor(
    public loader: FeedLoader<T, C, M>,
    private readonly opts: FeedOptions<T> = {},
  ) {}

  get snapshot(): FeedSnapshot<T, M> {
    return (this.snap ??= {
      items: this.items,
      status: this.status,
      error: this.error,
      hasMore: this.cursor != null,
      loadingMore: this.loadingMore,
      meta: this.meta,
    });
  }

  /** A page request is out. */
  get busyLoading(): boolean {
    return this.busy;
  }

  /** Whether a mounted component is subscribed (the list is on screen). */
  get watched(): boolean {
    return this.listeners.size > 0;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Load the first page unless it's loaded (or loading) already; retries after an error. */
  start(): void {
    if (this.started && this.status !== 'error') return;
    this.started = true;
    void this.loadFirst(false);
  }

  /**
   * Reload the first page, keeping what's shown until it arrives. Resolves to the error if it
   * failed while something was shown (which stays, as it was), else null.
   */
  refresh(): Promise<LoadError | null> {
    this.started = true;
    return this.loadFirst(true);
  }

  retry(): void {
    this.started = true;
    void this.loadFirst(false);
  }

  /** Back online: reload a first page that failed, or retry a page that failed to load more. */
  retryFailed(): void {
    const s = this.snapshot;
    if (s.status === 'error') this.retry();
    else if (s.status === 'ready' && s.error && s.hasMore && !s.loadingMore) this.loadMore();
  }

  loadMore(): void {
    if (this.busy || this.cursor == null || this.status !== 'ready') return;
    const g = this.gen;
    this.busy = true;
    this.loadingMore = true;
    this.emit();
    this.loader(this.cursor)
      .then((p) => {
        if (g !== this.gen) return;
        this.opts.onPage?.(p.items);
        this.items = this.dedupe([...this.items, ...p.items]);
        this.cursor = p.cursor;
        this.error = null;
      })
      .catch((e) => {
        if (g !== this.gen) return;
        if (this.opts.isEnd?.(e)) this.cursor = null;
        else this.error = toLoadError(e, !online.peek());
      })
      .finally(() => {
        if (g !== this.gen) return;
        this.busy = false;
        this.loadingMore = false;
        this.emit();
      });
  }

  private async loadFirst(soft: boolean): Promise<LoadError | null> {
    const g = ++this.gen;
    this.busy = true;
    this.loadingMore = false;
    if (!soft || this.status === 'error') {
      this.status = 'loading';
      this.items = [];
      this.cursor = null;
    }
    this.error = null;
    this.emit();
    try {
      const p = await this.loader(null);
      if (g !== this.gen) return null;
      this.opts.onPage?.(p.items);
      this.items = this.dedupe(p.items);
      this.cursor = p.cursor;
      this.meta = p.meta;
      this.status = 'ready';
      return null;
    } catch (e) {
      if (g !== this.gen) return null;
      const err = toLoadError(e, !online.peek());
      // A failed refresh keeps showing what we had, as it was (its list end too): the caller
      // says it failed.
      if (this.status === 'ready') return err;
      this.error = err;
      this.status = 'error';
      return null;
    } finally {
      if (g === this.gen) {
        this.busy = false;
        this.emit();
      }
    }
  }

  private dedupe(items: T[]): T[] {
    const id = this.opts.id;
    if (!id) return items;
    const seen = new Set<string>();
    return items.filter((t) => {
      const k = id(t);
      return seen.has(k) ? false : (seen.add(k), true);
    });
  }

  private emit(): void {
    this.snap = null;
    for (const fn of [...this.listeners]) fn();
  }
}

// ---- Loading a whole list in the background ------------------------------------------

/** Feeds being filled by `fillFeed`. */
const filling = new WeakSet<Feed<unknown, unknown, unknown>>();

/** Whether `fillFeed` is loading this feed's pages right now. */
function isBeingFilled(feed: Feed<unknown, unknown, unknown>): boolean {
  return filling.has(feed);
}

/**
 * Whether a feed being filled up to `max` items still has pages to come: loading,
 * or loaded with more pages, no error and fewer than `max` items.
 */
export function isFilling(snap: FeedSnapshot<unknown, unknown>, max: number): boolean {
  if (snap.status === 'loading' || snap.loadingMore) return true;
  return snap.status === 'ready' && snap.hasMore && !snap.error && snap.items.length < max;
}

/**
 * Load a feed's pages one after another until the list is complete or has `max`
 * items (e.g. an artist's whole song list for search). Safe to call again: a fill
 * already running continues, and a stopped one resumes, retrying a failed page once.
 * Stops at the first error after that.
 */
export function fillFeed<T, C, M>(feed: Feed<T, C, M>, max: number): void {
  const f = feed as Feed<unknown, unknown, unknown>;
  if (filling.has(f)) return;
  filling.add(f);
  let retry = true;
  const step = () => {
    const s = feed.snapshot;
    if (s.status === 'loading' || s.loadingMore) return;
    if (s.status === 'ready' && s.hasMore && s.items.length < max) {
      if (!s.error || retry) {
        retry = false;
        feed.loadMore();
        return;
      }
    }
    // Complete, at the cap, or failed: stop (status 'error' is retried by the next call).
    un();
    filling.delete(f);
  };
  const un = feed.subscribe(step);
  feed.start();
  step();
}

/** Most feeds kept; the least recently used ones beyond this are dropped. */
const FEED_CACHE_MAX = 40;

/**
 * Feeds by key, least recently used first. A feed on screen (watched), loading a
 * page, or being filled is never evicted, so the cache can briefly hold more than `max`.
 */
export class FeedCache {
  private map = new Map<string, Feed<unknown, unknown, unknown>>();
  constructor(readonly max = FEED_CACHE_MAX) {}

  /** Get or create, mark as most recently used, and evict beyond `max`. */
  get<T, C, M = undefined>(key: string, loader: FeedLoader<T, C, M>, opts?: FeedOptions<T>): Feed<T, C, M> {
    const f = this.obtain(key, loader, opts);
    f.loader = loader; // latest closure (same key = same request)
    this.touch(key);
    return f;
  }

  /**
   * Get or create without reordering or evicting (safe to call while rendering).
   * Call `touch` from an effect once the feed is in use.
   */
  obtain<T, C, M = undefined>(key: string, loader: FeedLoader<T, C, M>, opts?: FeedOptions<T>): Feed<T, C, M> {
    let f = this.map.get(key) as Feed<T, C, M> | undefined;
    if (!f) {
      f = new Feed<T, C, M>(loader, opts);
      this.map.set(key, f as Feed<unknown, unknown, unknown>);
    }
    return f;
  }

  /** Mark a feed as just used and evict the least recently used idle ones beyond `max`. */
  touch(key: string): void {
    const f = this.map.get(key);
    if (!f) return;
    this.map.delete(key);
    this.map.set(key, f);
    if (this.map.size <= this.max) return;
    for (const [k, feed] of this.map) {
      if (this.map.size <= this.max) break;
      if (k === key || feed.watched || feed.busyLoading || isBeingFilled(feed)) continue;
      this.map.delete(k);
    }
  }

  /** Every feed in the cache (no LRU touch). */
  all(): Feed<unknown, unknown, unknown>[] {
    return [...this.map.values()];
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Keys and feeds whose key starts with `prefix` (no LRU touch). */
  entries(prefix = ''): [string, Feed<unknown, unknown, unknown>][] {
    return [...this.map].filter(([k]) => k.startsWith(prefix));
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  /** Drop every feed whose key starts with one of `prefixes`. */
  deletePrefix(...prefixes: string[]): void {
    for (const k of [...this.map.keys()]) if (prefixes.some((p) => k.startsWith(p))) this.map.delete(k);
  }
}

/**
 * Key part for lists of Jukebox posts, which differ by sign-in state: 'm' (members,
 * signed in with Cyberspace) or 'p' (public). Feeds of the other state are never shown.
 */
export function authScope(signedIn: boolean): 'm' | 'p' {
  return signedIn ? 'm' : 'p';
}

/** Prefixes of every feed of Jukebox posts (Home, genre pages). */
export const JUKEBOX_FEED_PREFIXES = ['home:', 'genre:'] as const;

/** The app-wide cache. */
export const feeds = new FeedCache();
/** Global search results, kept apart so typing many queries doesn't push out pages and albums. */
export const globalFeeds = new FeedCache(20);

/** Back online: every feed on screen whose load failed tries again. */
export function retryWatchedFeeds(caches: FeedCache[] = [feeds, globalFeeds]): void {
  for (const c of caches) for (const f of c.all()) if (f.watched) f.retryFailed();
}
