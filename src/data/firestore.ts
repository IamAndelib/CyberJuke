/**
 * TrackSource backed by the public Firestore REST API the Cyberspace web app uses.
 *
 * Courtesy rules (this is someone else's database):
 *  - only query shapes that have composite indexes (latest, latest-by-genre, and the
 *    catalog: latest with a field mask, optionally `createdAt > since`);
 *  - results cached in memory for ~5 minutes; in-flight requests are de-duplicated;
 *  - no polling of the feed itself: the only periodic request is the freshness check
 *    (`newerThan`: a createdAt-only field mask, at most FRESHNESS_LIMIT rows), run in
 *    the foreground at the user's chosen interval.
 *
 * Signed in with Cyberspace (optional, see ./auth), requests carry the ID token and use
 * the site's own members query instead: `deleted==false, hasAudioAttachment==true`,
 * no `isPublic`, ban flags filtered on the phone, members-only posts marked. Genre
 * pages then filter the catalog (`genreTracks`), since only the members query shapes
 * the site itself sends are sure to have an index. Signed out, nothing changes.
 */
import { bool, isHiddenDoc, tracksFromRows, type FsRunQueryRow, type Track, ts } from './model';
import { parseRunQueryRows } from '../core/guards';
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

/** Most rows the freshness check asks for ("25+ new tracks"). */
export const FRESHNESS_LIMIT = 25;
/** Field mask for the freshness check: only the timestamp. */
export const FRESHNESS_FIELDS = ['createdAt'] as const;
/** Extra fields members requests ask for: the ban flags (filtered here) and isPublic. */
export const MEMBERS_EXTRA_FIELDS = ['isPublic', 'isBanned', 'isShadowBanned'] as const;
export const MEMBERS_CATALOG_FIELDS = [...CATALOG_FIELDS, ...MEMBERS_EXTRA_FIELDS] as const;
export const MEMBERS_FRESHNESS_FIELDS = ['createdAt', 'isBanned', 'isShadowBanned'] as const;

/** The freshness check's field mask: NSFW hidden adds isNSFW, so NSFW posts aren't counted. */
export function freshnessFields(members: boolean, includeNsfw: boolean): readonly string[] {
  const base: readonly string[] = members ? MEMBERS_FRESHNESS_FIELDS : FRESHNESS_FIELDS;
  return includeNsfw ? base : [...base, 'isNSFW'];
}

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
  /** Signed in: the site's members query (no isPublic or ban filters, no genre). */
  members?: boolean;
}) {
  const filters: Filter[] = opts.members
    ? [eq('deleted', { booleanValue: false }), eq('hasAudioAttachment', { booleanValue: true })]
    : [
        eq('isPublic', { booleanValue: true }),
        eq('deleted', { booleanValue: false }),
        eq('isBanned', { booleanValue: false }),
        eq('isShadowBanned', { booleanValue: false }),
        eq('hasAudioAttachment', { booleanValue: true }),
      ];
  if (opts.genre != null) {
    if (opts.members) throw new Error('members queries have no genre filter');
    filters.push(eq('audioAttachmentGenre', { stringValue: opts.genre }));
  }
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

/** What the source needs from the Cyberspace login (./auth). */
export interface SourceAuth {
  signedIn(): boolean;
  token(): Promise<string | null>;
  refreshNow(): Promise<string | null>;
}

export interface FirestoreSourceOptions {
  /** Whether NSFW tracks should be returned. Read on every call. Default: hide. */
  showNsfw?: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called with the newest createdAt of every first Latest page fetched from the network. */
  onLatest?: (newest: string) => void;
  /** The Cyberspace login; without one (or signed out) every request is the public one. */
  auth?: SourceAuth;
}

export class FirestoreSource implements TrackSource {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<RawPage>>();
  private readonly showNsfw: () => boolean;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly auth: SourceAuth | undefined;
  /** Observer for the newest post shown on the Latest feed (freshness baseline). */
  onLatest: ((newest: string) => void) | undefined;
  /**
   * Signed in: one genre's tracks, NSFW included (the catalog filtered for an exact
   * genre match). Wired by the app (store/account.ts); without it a genre is empty.
   */
  genreTracks: ((genre: string) => Promise<Track[]>) | undefined;

  constructor(opts: FirestoreSourceOptions = {}) {
    this.onLatest = opts.onLatest;
    this.auth = opts.auth;
    this.showNsfw = opts.showNsfw ?? (() => false);
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = opts.now ?? (() => Date.now());
  }

  latest(cursor?: Cursor | null): Promise<Page> {
    return this.page(null, cursor ?? null);
  }

  byGenre(genre: string, cursor?: Cursor | null): Promise<Page> {
    if (this.members()) {
      if (cursor) return Promise.resolve({ tracks: [], cursor: null });
      return (this.genreTracks?.(genre) ?? Promise.resolve([])).then((tracks) => ({ tracks: this.filter(tracks), cursor: null }));
    }
    return this.page(genre, cursor ?? null);
  }

  /** Whether requests use the members query (signed in). */
  members(): boolean {
    return !!this.auth?.signedIn();
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
    const members = this.members();
    for (let i = 0; i < CATALOG_MAX_PAGES; i++) {
      const body = JSON.stringify(
        buildQuery({
          select: members ? MEMBERS_CATALOG_FIELDS : CATALOG_FIELDS,
          limit: CATALOG_PAGE_SIZE,
          cursor,
          since: since ? since.toISOString() : null,
          members,
        }),
      );
      const p = await this.request(body, members, CATALOG_PAGE_SIZE);
      out.push(...p.tracks);
      cursor = p.cursor;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * The freshness check: how many posts are newer than `since` (an ISO timestamp), at
   * most FRESHNESS_LIMIT, and the newest one's timestamp. With `includeNsfw` false
   * (the setting hides them) NSFW posts don't count. Never cached.
   */
  async newerThan(since: string, opts: { includeNsfw?: boolean } = {}): Promise<{ count: number; newest: string | null }> {
    const members = this.members();
    const includeNsfw = opts.includeNsfw ?? this.showNsfw();
    const body = JSON.stringify(buildQuery({ select: freshnessFields(members, includeNsfw), limit: FRESHNESS_LIMIT, since, members }));
    const rows = await this.rows(body, members);
    let newest: string | null = null;
    let count = 0;
    for (const r of rows) {
      if (!r.document || isHiddenDoc(r.document)) continue;
      if (!includeNsfw && bool(r.document.fields?.isNSFW)) continue;
      count++;
      const t = ts(r.document.fields?.createdAt);
      if (t && (!newest || t > newest)) newest = t;
    }
    return { count, newest };
  }

  /** Drop every cached page (the new-tracks pill: the next Latest load is fresh). */
  invalidateAll(): void {
    this.cache.clear();
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
    const members = this.members();
    const body = JSON.stringify(buildQuery({ genre, cursor, members }));
    const hit = this.cache.get(body);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.page);
    const pending = this.inflight.get(body);
    if (pending) return pending;
    const req = this.request(body, members)
      .then((page) => {
        this.cache.set(body, { at: this.now(), page });
        if (genre == null && cursor == null && page.tracks[0]?.createdAt) this.onLatest?.(page.tracks[0].createdAt);
        return page;
      })
      .finally(() => this.inflight.delete(body));
    this.inflight.set(body, req);
    return req;
  }

  private async request(body: string, members: boolean, limit = PAGE_SIZE): Promise<RawPage> {
    const rows = await this.rows(body, members);
    // The cursor comes from every row, so hidden (banned) posts don't end paging early.
    return { tracks: tracksFromRows(rows), cursor: nextCursor(rows, limit) };
  }

  private async post(body: string, token: string | null): Promise<Response> {
    try {
      return await this.fetchFn(RUN_QUERY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body,
      });
    } catch {
      throw new FirestoreError('Network unavailable', 0, true);
    }
  }

  private async token(get: () => Promise<string | null>): Promise<string> {
    let t: string | null;
    try {
      t = await get();
    } catch (e) {
      throw new FirestoreError(e instanceof Error ? e.message : 'Network unavailable', 0, !!(e as { offline?: boolean })?.offline);
    }
    if (!t) throw new FirestoreError('Signed out of Cyberspace', 401);
    return t;
  }

  private async rows(body: string, members = false): Promise<FsRunQueryRow[]> {
    let res: Response;
    if (members && this.auth) {
      res = await this.post(body, await this.token(() => this.auth!.token()));
      // An ID token the server no longer accepts: refresh once and retry once.
      if (res.status === 401) res = await this.post(body, await this.token(() => this.auth!.refreshNow()));
    } else {
      res = await this.post(body, null);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new FirestoreError(`Bad response (${res.status})`, res.status);
    }
    const rows = res.ok ? parseRunQueryRows(json) : null;
    if (!rows) {
      const err = Array.isArray(json) ? json[0]?.error : (json as { error?: { message?: string } })?.error;
      throw new FirestoreError((typeof err?.message === 'string' && err.message) || `Request failed (${res.status})`, res.status);
    }
    return rows;
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
