/**
 * Paged lists that survive remounts. A Feed holds one list's pages (items, cursor,
 * status) outside any component, and `feedFor` keeps one Feed per key in a
 * module-level cache, so leaving a screen and coming back gets everything already
 * loaded instantly, with no refetch. Pure TS, no Preact: hooks subscribe to it.
 */

export type FeedStatus = 'loading' | 'ready' | 'error';

export interface FeedError {
  message: string;
  offline: boolean;
  code?: string;
}

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
  error: FeedError | null;
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

export function toFeedError(e: unknown): FeedError {
  const x = e as { offline?: boolean; code?: unknown } | null;
  return {
    message: e instanceof Error ? e.message : String(e),
    offline: !!x?.offline || (typeof navigator !== 'undefined' && navigator.onLine === false),
    ...(typeof x?.code === 'string' && { code: x.code }),
  };
}

export class Feed<T, C, M = undefined> {
  private items: T[] = [];
  private cursor: C | null = null;
  private meta: M | undefined;
  private status: FeedStatus = 'loading';
  private error: FeedError | null = null;
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

  /** Reload the first page, keeping what's shown until it arrives. */
  refresh(): Promise<void> {
    this.started = true;
    return this.loadFirst(true);
  }

  retry(): void {
    this.started = true;
    void this.loadFirst(false);
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
        else this.error = toFeedError(e);
      })
      .finally(() => {
        if (g !== this.gen) return;
        this.busy = false;
        this.loadingMore = false;
        this.emit();
      });
  }

  private async loadFirst(soft: boolean): Promise<void> {
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
      if (g !== this.gen) return;
      this.opts.onPage?.(p.items);
      this.items = this.dedupe(p.items);
      this.cursor = p.cursor;
      this.meta = p.meta;
      this.status = 'ready';
    } catch (e) {
      if (g !== this.gen) return;
      this.error = toFeedError(e);
      // A failed refresh keeps showing what we had.
      if (this.status !== 'ready') this.status = 'error';
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

/** Most feeds kept; the least recently used ones beyond this are dropped. */
export const FEED_CACHE_MAX = 40;

export class FeedCache {
  private map = new Map<string, Feed<unknown, unknown, unknown>>();
  constructor(readonly max = FEED_CACHE_MAX) {}

  get<T, C, M = undefined>(key: string, loader: FeedLoader<T, C, M>, opts?: FeedOptions<T>): Feed<T, C, M> {
    let f = this.map.get(key) as Feed<T, C, M> | undefined;
    if (f) {
      this.map.delete(key);
      f.loader = loader; // latest closure (same key = same request)
    } else {
      f = new Feed<T, C, M>(loader, opts);
    }
    this.map.set(key, f as Feed<unknown, unknown, unknown>);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return f;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/** The app-wide cache. */
export const feeds = new FeedCache();
