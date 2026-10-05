import { describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/runquery-sample.json';
import {
  buildQuery,
  CACHE_TTL_MS,
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

  it('shuffled() is a permutation', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const s = shuffled(a);
    expect(s.slice().sort()).toEqual(a);
    expect(a).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
