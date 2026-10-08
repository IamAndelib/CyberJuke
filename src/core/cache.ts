/**
 * The app's one in-memory cache: entries expire after a TTL, the oldest go first past a
 * size limit, and concurrent loads of one key share one request.
 *
 * "Oldest" means least recently written: set() and touch() make an entry the newest,
 * a plain get() doesn't reorder. So a cache that only ever sets drops entries in the
 * order they were stored, and one that touches on every use is an LRU.
 */

export interface CacheOptions<V> {
  /** How long an entry stays fresh, in ms, or per value (Infinity: forever). Default: forever. */
  ttlMs?: number | ((value: V) => number);
  /** Most entries kept; past it the least recently written go first. Default: no limit. */
  max?: number;
  /** A stale entry that get() finds is deleted then. Default: kept until overwritten. */
  dropStale?: boolean;
  now?: () => number;
}

export interface LoadOptions<V> {
  /** Called right after a loaded value is stored (not for hits or shared loads). */
  stored?: (value: V) => void;
  /** Maps a failed load's error (the shared promise rejects with what this returns). */
  mapError?: (e: unknown) => unknown;
}

/** Promises in progress by key: a second caller gets the first one's promise. */
export class InFlight<K, T> {
  private readonly pending = new Map<K, Promise<T>>();

  get(key: K): Promise<T> | undefined {
    return this.pending.get(key);
  }

  /** Share `req` under `key` until it settles; returns the shared promise. */
  track(key: K, req: Promise<T>): Promise<T> {
    const shared = req.finally(() => this.pending.delete(key));
    this.pending.set(key, shared);
    return shared;
  }
}

export class Cache<K, V> {
  private readonly map = new Map<K, { at: number; value: V }>();
  private readonly inflight = new InFlight<K, V>();
  private readonly now: () => number;

  constructor(private readonly opts: CacheOptions<V> = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.map.size;
  }

  /** The value if it is still fresh. */
  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.fresh(e)) return e.value;
    if (this.opts.dropStale) this.map.delete(key);
    return undefined;
  }

  /** get(), and on a hit make the entry the newest. */
  touch(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (!this.fresh(e)) {
      if (this.opts.dropStale) this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    this.evict();
    return e.value;
  }

  /** Store a value as the newest entry, written `at` (default now). */
  set(key: K, value: V, at: number = this.now()): void {
    this.map.delete(key);
    this.map.set(key, { at, value });
    this.evict();
  }

  /** Put back a saved entry as it was (loading a persisted cache: no reordering, no eviction). */
  restore(key: K, value: V, at: number): void {
    this.map.set(key, { at, value });
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Drop the entries written more than `ageMs` ago. */
  dropOlderThan(ageMs: number): void {
    const cutoff = this.now() - ageMs;
    for (const [k, e] of this.map) if (e.at < cutoff) this.map.delete(k);
  }

  /** Every entry's key and value, oldest first (fresh or not). */
  pairs(): [K, V][] {
    return [...this.map].map(([k, e]) => [k, e.value]);
  }

  /**
   * A fresh value, else the load already in progress for `key`, else `start()`'s
   * result, stored when it resolves. A failed load stores nothing; a `start` that
   * throws synchronously rejects without becoming a shared load.
   */
  load(key: K, start: () => Promise<V>, o: LoadOptions<V> = {}): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    let req: Promise<V>;
    try {
      req = start();
    } catch (e) {
      return Promise.reject(e);
    }
    let stored = req.then((value) => {
      this.set(key, value);
      o.stored?.(value);
      return value;
    });
    const mapError = o.mapError;
    if (mapError) {
      stored = stored.catch((e) => {
        throw mapError(e);
      });
    }
    return this.inflight.track(key, stored);
  }

  private fresh(e: { at: number; value: V }): boolean {
    const ttl = typeof this.opts.ttlMs === 'function' ? this.opts.ttlMs(e.value) : (this.opts.ttlMs ?? Infinity);
    return ttl === Infinity || this.now() - e.at < ttl;
  }

  private evict(): void {
    const max = this.opts.max ?? Infinity;
    while (this.map.size > max) this.map.delete(this.map.keys().next().value!);
  }
}
