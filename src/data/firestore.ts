/**
 * TrackSource backed by the public Firestore REST API the Cyberspace web app uses.
 *
 * Courtesy rules (this is someone else's database):
 *  - only query shapes that have composite indexes (latest, latest-by-genre, and the
 *    catalog: latest with a field mask, optionally `createdAt > since`);
 *  - results cached in memory for ~5 minutes; in-flight requests are de-duplicated;
 *  - no polling: requests only happen in response to the user.
 */
import { tracksFromRows, type FsRunQueryRow, type Track, ts } from './model';
import type { Cursor, Page, TrackSource } from './source';

export const PROJECT = 'cyberspace-cyberspace';
export const API_KEY = 'AIzaSyA8yov3J3KN9VoW633F2hfDpWsExMJov2Y';
export const RUN_QUERY_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery?key=${API_KEY}`;
export const PAGE_SIZE = 24;
export const CACHE_TTL_MS = 5 * 60 * 1000;
/** A pull-to-refresh only drops cache entries older than this. */
export const MIN_REFRESH_AGE_MS = 20 * 1000;
/** How many latest pages shuffle() draws from. */
export const SHUFFLE_PAGES = 4;
/** Catalog page size: the whole Jukebox (~640 posts) takes two or three requests. */
export const CATALOG_PAGE_SIZE = 300;
/** Safety stop for catalog paging (300 * 40 = 12,000 posts). */
export const CATALOG_MAX_PAGES = 40;
/** Field mask for catalog requests: only what parseDoc and the counts need. */
export const CATALOG_FIELDS = [
  'attachments',
  'audioAttachmentGenre',
  'authorUsername',
  'slug',
  'title',
  'isNSFW',
  'createdAt',
  'topics',
  'bookmarksCount',
  'repliesCount',
] as const;

type Filter = {
  fieldFilter: { field: { fieldPath: string }; op: 'EQUAL' | 'GREATER_THAN'; value: Record<string, unknown> };
};

function eq(fieldPath: string, value: Record<string, unknown>): Filter {
  return { fieldFilter: { field: { fieldPath }, op: 'EQUAL', value } };
}

/** Build the runQuery body. Exported for tests: these are the ONLY query shapes we send. */
export function buildQuery(opts: {
  genre?: string | null;
  cursor?: Cursor | null;
  limit?: number;
  /** Field mask (catalog requests). */
  select?: readonly string[];
  /** Only posts created strictly after this ISO timestamp (incremental catalog). */
  since?: string | null;
}) {
  const filters: Filter[] = [
    eq('isPublic', { booleanValue: true }),
    eq('deleted', { booleanValue: false }),
    eq('isBanned', { booleanValue: false }),
    eq('isShadowBanned', { booleanValue: false }),
    eq('hasAudioAttachment', { booleanValue: true }),
  ];
  if (opts.genre != null) filters.push(eq('audioAttachmentGenre', { stringValue: opts.genre }));
  if (opts.since) {
    filters.push({ fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN', value: { timestampValue: opts.since } } });
  }
  const structuredQuery: Record<string, unknown> = {
    ...(opts.select && { select: { fields: opts.select.map((fieldPath) => ({ fieldPath })) } }),
    from: [{ collectionId: 'posts' }],
    where: { compositeFilter: { op: 'AND', filters } },
    orderBy: [
      { field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
    ],
    limit: opts.limit ?? PAGE_SIZE,
  };
  if (opts.cursor) {
    // before:false == startAfter the last document of the previous page.
    structuredQuery.startAt = {
      values: [{ timestampValue: opts.cursor.createdAt }, { referenceValue: opts.cursor.name }],
      before: false,
    };
  }
  return { structuredQuery };
}

/** Cursor for the page after `rows`, or null when this was the last page. */
export function nextCursor(rows: FsRunQueryRow[], limit = PAGE_SIZE): Cursor | null {
  const docs = rows.filter((r) => r.document).map((r) => r.document!);
  if (docs.length < limit) return null;
  const last = docs[docs.length - 1];
  const createdAt = ts(last.fields?.createdAt);
  if (!createdAt) return null;
  return { createdAt, name: last.name };
}

export class FirestoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly offline = false,
  ) {
    super(message);
    this.name = 'FirestoreError';
  }
}

interface RawPage {
  tracks: Track[];
  cursor: Cursor | null;
}

interface CacheEntry {
  at: number;
  page: RawPage;
}

export interface FirestoreSourceOptions {
  /** Whether NSFW tracks should be returned. Read on every call. Default: hide. */
  showNsfw?: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export class FirestoreSource implements TrackSource {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<RawPage>>();
  private readonly showNsfw: () => boolean;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(opts: FirestoreSourceOptions = {}) {
    this.showNsfw = opts.showNsfw ?? (() => false);
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = opts.now ?? (() => Date.now());
  }

  latest(cursor?: Cursor | null): Promise<Page> {
    return this.page(null, cursor ?? null);
  }

  byGenre(genre: string, cursor?: Cursor | null): Promise<Page> {
    return this.page(genre, cursor ?? null);
  }

  async shuffle(n: number): Promise<Track[]> {
    const pool: Track[] = [];
    const seen = new Set<string>();
    let cursor: Cursor | null = null;
    for (let i = 0; i < SHUFFLE_PAGES; i++) {
      const p: RawPage = await this.raw(null, cursor);
      for (const t of this.filter(p.tracks)) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          pool.push(t);
        }
      }
      cursor = p.cursor;
      if (!cursor) break;
    }
    return shuffled(pool).slice(0, Math.max(0, n));
  }

  /**
   * Every post (or every post newer than `since`), NSFW included: the caller filters,
   * so toggling the setting needs no refetch. Not cached here; the catalog store
   * persists the result and de-duplicates calls.
   */
  async catalog(since?: Date): Promise<Track[]> {
    const out: Track[] = [];
    let cursor: Cursor | null = null;
    for (let i = 0; i < CATALOG_MAX_PAGES; i++) {
      const body = JSON.stringify(
        buildQuery({ select: CATALOG_FIELDS, limit: CATALOG_PAGE_SIZE, cursor, since: since ? since.toISOString() : null }),
      );
      const p = await this.request(body, CATALOG_PAGE_SIZE);
      out.push(...p.tracks);
      cursor = p.cursor;
      if (!cursor) break;
    }
    return out;
  }

  invalidate(): void {
    const cutoff = this.now() - MIN_REFRESH_AGE_MS;
    for (const [k, e] of this.cache) if (e.at < cutoff) this.cache.delete(k);
  }

  private async page(genre: string | null, cursor: Cursor | null): Promise<Page> {
    const p = await this.raw(genre, cursor);
    return { tracks: this.filter(p.tracks), cursor: p.cursor };
  }

  private filter(tracks: Track[]): Track[] {
    return this.showNsfw() ? tracks.slice() : tracks.filter((t) => !t.nsfw);
  }

  private raw(genre: string | null, cursor: Cursor | null): Promise<RawPage> {
    const body = JSON.stringify(buildQuery({ genre, cursor }));
    const hit = this.cache.get(body);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.page);
    const pending = this.inflight.get(body);
    if (pending) return pending;
    const req = this.request(body)
      .then((page) => {
        this.cache.set(body, { at: this.now(), page });
        return page;
      })
      .finally(() => this.inflight.delete(body));
    this.inflight.set(body, req);
    return req;
  }

  private async request(body: string, limit = PAGE_SIZE): Promise<RawPage> {
    let res: Response;
    try {
      res = await this.fetchFn(RUN_QUERY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (e) {
      throw new FirestoreError('Network unavailable', 0, true);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new FirestoreError(`Bad response (${res.status})`, res.status);
    }
    if (!res.ok || !Array.isArray(json)) {
      const err = Array.isArray(json) ? json[0]?.error : (json as { error?: { message?: string } })?.error;
      throw new FirestoreError(err?.message || `Request failed (${res.status})`, res.status);
    }
    const rows = json as FsRunQueryRow[];
    return { tracks: tracksFromRows(rows), cursor: nextCursor(rows, limit) };
  }
}

export function shuffled<T>(arr: T[], rand: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
