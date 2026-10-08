import { describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/runquery-sample.json';
import {
  buildQuery,
  CACHE_TTL_MS,
  CATALOG_FIELDS,
  CATALOG_PAGE_SIZE,
  FirestoreError,
  FirestoreSource,
  nextCursor,
  PAGE_SIZE,
  RUN_QUERY_URL,
  shuffled,
} from './firestore';
import type { FsRunQueryRow } from './model';

const rows = fixture as unknown as FsRunQueryRow[];

const BASE_FILTERS = [
  ['isPublic', { booleanValue: true }],
  ['deleted', { booleanValue: false }],
  ['isBanned', { booleanValue: false }],
  ['isShadowBanned', { booleanValue: false }],
  ['hasAudioAttachment', { booleanValue: true }],
].map(([fieldPath, value]) => ({ fieldFilter: { field: { fieldPath }, op: 'EQUAL', value } }));

describe('buildQuery', () => {
  it('builds the latest query', () => {
    expect(buildQuery({})).toEqual({
      structuredQuery: {
        from: [{ collectionId: 'posts' }],
        where: { compositeFilter: { op: 'AND', filters: BASE_FILTERS } },
        orderBy: [
          { field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' },
          { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
        ],
        limit: 24,
      },
    });
  });

  it('adds the genre filter last', () => {
    const q = buildQuery({ genre: 'dark ambient' }).structuredQuery as any;
    expect(q.where.compositeFilter.filters).toEqual([
      ...BASE_FILTERS,
      { fieldFilter: { field: { fieldPath: 'audioAttachmentGenre' }, op: 'EQUAL', value: { stringValue: 'dark ambient' } } },
    ]);
    expect(q.orderBy).toHaveLength(2);
  });

  it('never orders or filters on randomKey', () => {
    const s = JSON.stringify([buildQuery({}), buildQuery({ genre: 'x', cursor: { createdAt: 't', name: 'n' } })]);
    expect(s).not.toContain('randomKey');
  });

  it('adds a startAfter cursor of [createdAt, __name__]', () => {
    const q = buildQuery({
      cursor: { createdAt: '2026-10-01T00:00:00Z', name: 'projects/p/databases/(default)/documents/posts/abc' },
    }).structuredQuery as any;
    expect(q.startAt).toEqual({
      values: [
        { timestampValue: '2026-10-01T00:00:00Z' },
        { referenceValue: 'projects/p/databases/(default)/documents/posts/abc' },
      ],
      before: false,
    });
  });
});

describe('buildQuery (catalog)', () => {
  it('adds the field mask and keeps the same filters and order', () => {
    const q = buildQuery({ select: CATALOG_FIELDS, limit: CATALOG_PAGE_SIZE }).structuredQuery as any;
    expect(q.select.fields.map((f: any) => f.fieldPath)).toEqual([...CATALOG_FIELDS]);
    expect(q.select.fields.map((f: any) => f.fieldPath)).toEqual(expect.arrayContaining(['bookmarksCount', 'repliesCount', 'attachments']));
    expect(q.where.compositeFilter.filters).toEqual(BASE_FILTERS);
    expect(q.orderBy).toEqual((buildQuery({}).structuredQuery as any).orderBy);
    expect(q.limit).toBe(300);
  });

  it('adds createdAt > since as the last filter', () => {
    const q = buildQuery({ select: CATALOG_FIELDS, since: '2026-10-01T00:00:00.000Z' }).structuredQuery as any;
    expect(q.where.compositeFilter.filters).toEqual([
      ...BASE_FILTERS,
      { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN', value: { timestampValue: '2026-10-01T00:00:00.000Z' } } },
    ]);
  });

  it('only ever orders by createdAt DESC, __name__ DESC', () => {
    for (const opts of [{}, { genre: 'x' }, { select: CATALOG_FIELDS, since: 't' }]) {
      const q = buildQuery(opts).structuredQuery as any;
      expect(q.orderBy.map((o: any) => [o.field.fieldPath, o.direction])).toEqual([
        ['createdAt', 'DESCENDING'],
        ['__name__', 'DESCENDING'],
      ]);
    }
  });
});

describe('nextCursor', () => {
  it('returns the last document as cursor when the page is full', () => {
    expect(nextCursor(rows, 12)).toEqual({
      createdAt: '2026-06-24T04:24:32.275Z',
      name: 'projects/cyberspace-cyberspace/databases/(default)/documents/posts/sPVimvDsFyet6YkEQnyn',
    });
  });

  it('returns null on a short page (end of results)', () => {
    expect(nextCursor(rows, PAGE_SIZE)).toBeNull();
    expect(nextCursor([{ readTime: 'x' }])).toBeNull();
  });
});

function mockFetch(responses: unknown[] | ((body: any) => unknown), status = 200) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const payload = typeof responses === 'function' ? responses(body) : responses;
    return new Response(JSON.stringify(payload), { status });
  });
}

describe('FirestoreSource', () => {
  it('POSTs the query to runQuery and hides NSFW by default', async () => {
    const f = mockFetch(rows);
    const src = new FirestoreSource({ fetch: f as any });
    const page = await src.latest();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(RUN_QUERY_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(buildQuery({}));
    expect(page.tracks).toHaveLength(11);
    expect(page.tracks.some((t) => t.nsfw)).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it('shows NSFW when the setting allows', async () => {
    let show = false;
    const src = new FirestoreSource({ fetch: mockFetch(rows) as any, showNsfw: () => show });
    expect((await src.latest()).tracks).toHaveLength(11);
    show = true;
    expect((await src.latest()).tracks).toHaveLength(12);
  });

  it('caches for the TTL and dedupes in-flight requests', async () => {
    let now = 1_000_000;
    const f = mockFetch(rows);
    const src = new FirestoreSource({ fetch: f as any, now: () => now });
    await Promise.all([src.latest(), src.latest(), src.latest()]);
    expect(f).toHaveBeenCalledTimes(1);
    now += CACHE_TTL_MS - 1;
    await src.latest();
    expect(f).toHaveBeenCalledTimes(1);
    now += 2;
    await src.latest();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('keys the cache by query (genre, cursor)', async () => {
    const f = mockFetch(rows);
    const src = new FirestoreSource({ fetch: f as any });
    await src.latest();
    await src.byGenre('folk');
    await src.byGenre('folk');
    await src.latest({ createdAt: 't', name: 'n' });
    expect(f).toHaveBeenCalledTimes(3);
    expect(JSON.parse(f.mock.calls[1][1].body as string)).toEqual(buildQuery({ genre: 'folk' }));
  });

  it('invalidate() only drops entries older than the minimum refresh age', async () => {
    let now = 0;
    const f = mockFetch(rows);
    const src = new FirestoreSource({ fetch: f as any, now: () => now });
    await src.latest();
    src.invalidate();
    await src.latest();
    expect(f).toHaveBeenCalledTimes(1);
    now += 60_000;
    src.invalidate();
    await src.latest();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('raises FirestoreError on API errors and does not cache them', async () => {
    const f = mockFetch([{ error: { code: 400, message: 'FAILED_PRECONDITION: index', status: 'FAILED_PRECONDITION' } }], 400);
    const src = new FirestoreSource({ fetch: f as any });
    await expect(src.latest()).rejects.toThrow(/FAILED_PRECONDITION/);
    await expect(src.latest()).rejects.toBeInstanceOf(FirestoreError);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('flags network failures as offline', async () => {
    const src = new FirestoreSource({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as any,
    });
    await expect(src.latest()).rejects.toMatchObject({ offline: true });
  });

  it('shuffle() pages through latest results (cached) and returns n unique tracks', async () => {
    // Serve 4 full pages of 24 docs built from the fixture with unique names/timestamps.
    const docs = Array.from({ length: 120 }, (_, i) => {
      const d = structuredClone(rows[i % 11 === 10 ? 0 : i % 11].document!);
      d.name = d.name.replace(/[^/]+$/, `doc${i}`);
      d.fields!.createdAt = { timestampValue: new Date(2026, 9, 5, 0, 0, 0, -i * 1000).toISOString() };
      return { document: d };
    });
    const f = mockFetch((body) => {
      const after = body.structuredQuery.startAt?.values[1].referenceValue as string | undefined;
      const start = after ? docs.findIndex((d) => d.document.name === after) + 1 : 0;
      return docs.slice(start, start + 24);
    });
    const src = new FirestoreSource({ fetch: f as any });
    const picks = await src.shuffle(30);
    expect(picks).toHaveLength(30);
    expect(new Set(picks.map((t) => t.id)).size).toBe(30);
    expect(f).toHaveBeenCalledTimes(4);
    for (const call of f.mock.calls) expect(JSON.stringify(JSON.parse(call[1].body as string))).not.toContain('randomKey');
    await src.shuffle(10);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('catalog() pages by cursor with the field mask and includes NSFW', async () => {
    const docs = Array.from({ length: 650 }, (_, i) => {
      const d = structuredClone(rows[i % 12].document!);
      d.name = d.name.replace(/[^/]+$/, `doc${i}`);
      d.fields!.createdAt = { timestampValue: new Date(Date.UTC(2026, 9, 5) - i * 60_000).toISOString() };
      return { document: d };
    });
    const f = mockFetch((body) => {
      const after = body.structuredQuery.startAt?.values[1].referenceValue as string | undefined;
      const start = after ? docs.findIndex((d) => d.document.name === after) + 1 : 0;
      return docs.slice(start, start + body.structuredQuery.limit);
    });
    const src = new FirestoreSource({ fetch: f as any });
    const all = await src.catalog();
    expect(f).toHaveBeenCalledTimes(3);
    expect(all.length).toBeGreaterThan(600);
    expect(all.some((t) => t.nsfw)).toBe(true);
    const first = JSON.parse(f.mock.calls[0][1].body as string);
    expect(first).toEqual(buildQuery({ select: CATALOG_FIELDS, limit: CATALOG_PAGE_SIZE }));
    expect(JSON.parse(f.mock.calls[1][1].body as string).structuredQuery.startAt.values[1].referenceValue).toMatch(/doc299$/);
  });

  it('catalog(since) sends the createdAt filter', async () => {
    const f = mockFetch(rows);
    const src = new FirestoreSource({ fetch: f as any });
    await src.catalog(new Date('2026-10-01T00:00:00Z'));
    const q = JSON.parse(f.mock.calls[0][1].body as string).structuredQuery;
    expect(q.where.compositeFilter.filters.at(-1)).toEqual({
      fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN', value: { timestampValue: '2026-10-01T00:00:00.000Z' } },
    });
  });

  it('shuffled() is a permutation', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const s = shuffled(a);
    expect(s.slice().sort()).toEqual(a);
    expect(a).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
