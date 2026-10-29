import { describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/runquery-sample.json';
import {
  buildQuery,
  CACHE_MAX_PAGES,
  CACHE_TTL_MS,
  CATALOG_FIELDS,
  CATALOG_PAGE_SIZE,
  FirestoreError,
  FirestoreSource,
  MEMBERS_CATALOG_FIELDS,
  MEMBERS_FRESHNESS_FIELDS,
  nextCursor,
  PAGE_SIZE,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAY_MS,
  RUN_QUERY_URL,
  shuffled,
} from './firestore';
import { tracksFromRows, type FsRunQueryRow } from './model';
import { online } from '../core/network';

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

  it('adds the genre filter last, as the slug Cyberspace stores on the post', () => {
    const q = buildQuery({ genre: 'dark ambient' }).structuredQuery as any;
    expect(q.where.compositeFilter.filters).toEqual([
      ...BASE_FILTERS,
      { fieldFilter: { field: { fieldPath: 'audioAttachmentGenre' }, op: 'EQUAL', value: { stringValue: 'dark-ambient' } } },
    ]);
    expect(q.orderBy).toHaveLength(2);
  });

  it.each([
    ['pop', 'pop'],
    ['alternative rock', 'alternative-rock'],
    ['r&b-soul', 'rb-soul'],
    ['dance&edm', 'danceedm'],
    ['lo-fi', 'lo-fi'],
  ])('queries the genre %s as %s', (genre, slug) => {
    const q = buildQuery({ genre }).structuredQuery as any;
    expect(q.where.compositeFilter.filters.at(-1).fieldFilter.value).toEqual({ stringValue: slug });
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
    expect(nextCursor([{}])).toBeNull();
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
    // Only the fields a track is made of (the catalog's mask): about half the bytes.
    expect(JSON.parse(init.body as string)).toEqual(buildQuery({ select: CATALOG_FIELDS }));
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

  it(`keeps at most ${CACHE_MAX_PAGES} pages; the oldest go first`, async () => {
    const f = mockFetch(rows);
    const src = new FirestoreSource({ fetch: f as any });
    for (let i = 0; i <= CACHE_MAX_PAGES; i++) await src.byGenre(`g${i}`);
    expect(f).toHaveBeenCalledTimes(CACHE_MAX_PAGES + 1);
    await src.byGenre(`g${CACHE_MAX_PAGES}`);
    expect(f).toHaveBeenCalledTimes(CACHE_MAX_PAGES + 1);
    await src.byGenre('g0');
    expect(f).toHaveBeenCalledTimes(CACHE_MAX_PAGES + 2);
  });

  it('keys the cache by query (genre, cursor)', async () => {
    const f = mockFetch(rows);
    const src = new FirestoreSource({ fetch: f as any });
    await src.latest();
    await src.byGenre('folk');
    await src.byGenre('folk');
    await src.latest({ createdAt: 't', name: 'n' });
    expect(f).toHaveBeenCalledTimes(3);
    expect(JSON.parse(f.mock.calls[1][1].body as string)).toEqual(buildQuery({ genre: 'folk', select: CATALOG_FIELDS }));
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

describe('freshness check (newerThan)', () => {
  it('sends the createdAt-only, createdAt > since, limit 25 query and counts rows', async () => {
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify([
          { document: { name: 'a', fields: { createdAt: { timestampValue: '2026-10-08T12:00:00Z' } } } },
          { document: { name: 'b', fields: { createdAt: { timestampValue: '2026-10-08T13:00:00Z' } } } },
          {},
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const src = new FirestoreSource({ fetch: fetchFn, showNsfw: () => true });
    expect(await src.newerThan('2026-10-08T11:00:00Z')).toEqual({ count: 2, newest: '2026-10-08T13:00:00Z' });
    const q = bodies[0].structuredQuery;
    expect(q.select).toEqual({ fields: [{ fieldPath: 'createdAt' }] });
    expect(q.limit).toBe(25);
    expect(q.where.compositeFilter.filters.at(-1)).toEqual({
      fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN', value: { timestampValue: '2026-10-08T11:00:00Z' } },
    });
    // Never cached.
    await src.newerThan('2026-10-08T11:00:00Z');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('with NSFW hidden, asks for isNSFW too and doesn\'t count NSFW posts', async () => {
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify([
          { document: { name: 'a', fields: { createdAt: { timestampValue: '2026-10-08T12:00:00Z' } } } },
          { document: { name: 'b', fields: { createdAt: { timestampValue: '2026-10-08T13:00:00Z' }, isNSFW: { booleanValue: true } } } },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const src = new FirestoreSource({ fetch: fetchFn });
    expect(await src.newerThan('2026-10-08T11:00:00Z')).toEqual({ count: 1, newest: '2026-10-08T12:00:00Z' });
    expect(bodies[0].structuredQuery.select.fields.map((x: any) => x.fieldPath)).toEqual(['createdAt', 'isNSFW']);
    expect(await src.newerThan('2026-10-08T11:00:00Z', { includeNsfw: true })).toEqual({ count: 2, newest: '2026-10-08T13:00:00Z' });
    expect(bodies[1].structuredQuery.select.fields.map((x: any) => x.fieldPath)).toEqual(['createdAt']);
  });

  it('rejects a response that isn\'t a list of rows', async () => {
    const src = new FirestoreSource({ fetch: (async () => new Response('{"x":1}', { status: 200 })) as unknown as typeof fetch });
    await expect(src.latest()).rejects.toMatchObject({ name: 'FirestoreError' });
    const junk = new FirestoreSource({ fetch: (async () => new Response(JSON.stringify([1, { document: 'nope' }, { document: { name: 5 } }]), { status: 200 })) as unknown as typeof fetch });
    expect((await junk.latest()).tracks).toEqual([]);
  });

  it('reports the newest first Latest page and drops every cached page on invalidateAll', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;
    const seen: string[] = [];
    const src = new FirestoreSource({ fetch: fetchFn, onLatest: (n) => seen.push(n) });
    const p = await src.latest();
    expect(seen).toEqual([p.tracks[0].createdAt]);
    await src.byGenre('x');
    expect(seen).toHaveLength(1);
    await src.latest();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    src.invalidateAll();
    await src.latest();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

// ---- Signed in with Cyberspace: the members query ------------------------------------

const MEMBERS_FILTERS = [
  ['deleted', { booleanValue: false }],
  ['hasAudioAttachment', { booleanValue: true }],
].map(([fieldPath, value]) => ({ fieldFilter: { field: { fieldPath }, op: 'EQUAL', value } }));

/** A post doc built from the fixture's first post, with overrides. */
function post(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  const d = structuredClone(rows[0].document!);
  d.name = d.name.replace(/[^/]+$/, id);
  d.fields = { ...d.fields, createdAt: { timestampValue: createdAt }, isNSFW: { booleanValue: false }, ...(extra as object) };
  return { document: d };
}

function fakeAuth(tokens = ['tok-1', 'tok-2', 'tok-3']) {
  let i = 0;
  let signedIn = true;
  return {
    signedIn: () => signedIn,
    setSignedIn: (v: boolean) => (signedIn = v),
    token: vi.fn(async () => (signedIn ? tokens[i] : null)),
    refreshNow: vi.fn(async () => (signedIn ? tokens[++i] : null)),
  };
}

describe('buildQuery (members)', () => {
  it('is the site\'s logged-in query: deleted==false, hasAudioAttachment==true, newest first', () => {
    const q = buildQuery({ members: true }).structuredQuery as any;
    expect(q.where.compositeFilter.filters).toEqual(MEMBERS_FILTERS);
    const s = JSON.stringify(q);
    expect(s).not.toContain('isPublic');
    expect(s).not.toContain('isBanned');
    expect(s).not.toContain('isShadowBanned');
    expect(q.orderBy.map((o: any) => [o.field.fieldPath, o.direction])).toEqual([
      ['createdAt', 'DESCENDING'],
      ['__name__', 'DESCENDING'],
    ]);
  });

  it('keeps the field mask and createdAt > since variants', () => {
    const q = buildQuery({ members: true, select: MEMBERS_CATALOG_FIELDS, since: 't', limit: 300 }).structuredQuery as any;
    expect(q.where.compositeFilter.filters).toEqual([
      ...MEMBERS_FILTERS,
      { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN', value: { timestampValue: 't' } } },
    ]);
    expect(q.select.fields.map((f: any) => f.fieldPath)).toEqual(expect.arrayContaining(['isPublic', 'isBanned', 'isShadowBanned', 'attachments']));
  });

  it('has no genre variant (no guaranteed index)', () => {
    expect(() => buildQuery({ members: true, genre: 'x' })).toThrow();
  });
});

describe('FirestoreSource (members)', () => {
  it('sends the members query with the ID token; signed out it is the public query with no header', async () => {
    const f = mockFetch(rows);
    const auth = fakeAuth();
    const src = new FirestoreSource({ fetch: f as any, auth });
    await src.latest();
    expect(JSON.parse(f.mock.calls[0][1].body as string)).toEqual(buildQuery({ members: true, select: MEMBERS_CATALOG_FIELDS }));
    expect((f.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    auth.setSignedIn(false);
    src.invalidateAll();
    await src.latest();
    expect(JSON.parse(f.mock.calls[1][1].body as string)).toEqual(buildQuery({ select: CATALOG_FIELDS }));
    expect((f.mock.calls[1][1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('drops banned and shadow-banned posts on the phone and marks members-only posts', async () => {
    const f = mockFetch([
      post('pub', '2026-10-08T12:05:00Z', { isPublic: { booleanValue: true } }),
      post('mem', '2026-10-08T12:04:00Z', { isPublic: { booleanValue: false } }),
      post('ban', '2026-10-08T12:03:00Z', { isPublic: { booleanValue: true }, isBanned: { booleanValue: true } }),
      post('shadow', '2026-10-08T12:02:00Z', { isPublic: { booleanValue: false }, isShadowBanned: { booleanValue: true } }),
    ]);
    const src = new FirestoreSource({ fetch: f as any, auth: fakeAuth() });
    const page = await src.latest();
    expect(page.tracks.map((t) => [t.id, !!t.membersOnly])).toEqual([
      ['pub', false],
      ['mem', true],
    ]);
  });

  it('pages on past hidden posts: the cursor is the last row, banned or not', async () => {
    const docs = Array.from({ length: 24 }, (_, i) =>
      post(`d${i}`, new Date(Date.UTC(2026, 9, 8) - i * 1000).toISOString(), i === 23 ? { isBanned: { booleanValue: true } } : {}),
    );
    const src = new FirestoreSource({ fetch: mockFetch(docs) as any, auth: fakeAuth() });
    const page = await src.latest();
    expect(page.tracks).toHaveLength(23);
    expect(page.cursor?.name).toMatch(/d23$/);
  });

  it('on 401 refreshes the token and retries once', async () => {
    const auth = fakeAuth();
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const h = (init.headers as Record<string, string>).Authorization;
      return h === 'Bearer tok-1'
        ? new Response(JSON.stringify([{ error: { code: 401, status: 'UNAUTHENTICATED' } }]), { status: 401 })
        : new Response(JSON.stringify(rows), { status: 200 });
    });
    const src = new FirestoreSource({ fetch: f as any, auth });
    const page = await src.latest();
    expect(page.tracks.length).toBeGreaterThan(0);
    expect(auth.refreshNow).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect((f.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer tok-2');
  });

  it('a second 401 is an error (only one retry)', async () => {
    const auth = fakeAuth();
    const f = mockFetch([{ error: { code: 401, message: 'Request had invalid authentication credentials.' } }], 401);
    const src = new FirestoreSource({ fetch: f as any, auth });
    await expect(src.latest()).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(auth.refreshNow).toHaveBeenCalledTimes(1);
  });

  it('catalog() and newerThan() use the members masks; newerThan skips banned rows', async () => {
    const bodies: any[] = [];
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(
        JSON.stringify([
          { document: { name: 'a', fields: { createdAt: { timestampValue: '2026-10-08T12:00:00Z' } } } },
          { document: { name: 'b', fields: { createdAt: { timestampValue: '2026-10-08T13:00:00Z' }, isBanned: { booleanValue: true } } } },
        ]),
        { status: 200 },
      );
    });
    const src = new FirestoreSource({ fetch: f as any, auth: fakeAuth(), showNsfw: () => true });
    expect(await src.newerThan('2026-10-08T11:00:00Z')).toEqual({ count: 1, newest: '2026-10-08T12:00:00Z' });
    expect(bodies[0].structuredQuery.select.fields.map((x: any) => x.fieldPath)).toEqual([...MEMBERS_FRESHNESS_FIELDS]);
    expect(bodies[0].structuredQuery.where.compositeFilter.filters.slice(0, 2)).toEqual(MEMBERS_FILTERS);
    await src.catalog();
    expect(bodies[1]).toEqual(buildQuery({ members: true, select: MEMBERS_CATALOG_FIELDS, limit: CATALOG_PAGE_SIZE }));
  });

  it('byGenre() reads the catalog (exact genre) instead of querying', async () => {
    const f = mockFetch(rows);
    const src = new FirestoreSource({ fetch: f as any, auth: fakeAuth() });
    const all = (await new FirestoreSource({ fetch: mockFetch(rows) as any, showNsfw: () => true }).latest()).tracks;
    src.genreTracks = vi.fn(async (g: string) => all.filter((t) => t.genre === g));
    const g = all[0].genre;
    const page = await src.byGenre(g);
    expect(f).not.toHaveBeenCalled();
    expect(page.cursor).toBeNull();
    expect(page.tracks.length).toBeGreaterThan(0);
    expect(page.tracks.every((t) => t.genre === g && !t.nsfw)).toBe(true);
    expect((await src.byGenre(g, { createdAt: 't', name: 'n' })).tracks).toEqual([]);
  });
});

// ---- Latest and genre pages: the field mask ------------------------------------------

describe('field mask of Latest and genre pages', () => {
  /** A row with only the fields of `mask`, as Firestore answers a masked query. */
  const masked = (r: FsRunQueryRow, mask: readonly string[]): FsRunQueryRow =>
    r.document ? { ...r, document: { ...r.document, fields: Object.fromEntries(Object.entries(r.document.fields ?? {}).filter(([k]) => mask.includes(k))) } } : r;

  it('keeps every field a track is made of', () => {
    // The fixture's posts are whole documents, with fields the app never reads.
    expect(rows.some((r) => Object.keys(r.document?.fields ?? {}).some((k) => !(CATALOG_FIELDS as readonly string[]).includes(k)))).toBe(true);
    const full = tracksFromRows(rows);
    expect(full.some((t) => t.saves !== undefined)).toBe(true);
    expect(full.some((t) => t.nsfw)).toBe(true);
    expect(tracksFromRows(rows.map((r) => masked(r, CATALOG_FIELDS)))).toEqual(full);
  });

  it('signed in, keeps what marks members-only posts and hides banned ones', () => {
    const docs = [
      post('pub', '2026-10-08T12:05:00Z', { isPublic: { booleanValue: true } }),
      post('mem', '2026-10-08T12:04:00Z', { isPublic: { booleanValue: false } }),
      post('ban', '2026-10-08T12:03:00Z', { isBanned: { booleanValue: true } }),
      post('shadow', '2026-10-08T12:02:00Z', { isShadowBanned: { booleanValue: true } }),
      post('nsfw', '2026-10-08T12:01:00Z', { isNSFW: { booleanValue: true } }),
    ];
    const full = tracksFromRows(docs);
    expect(full.map((t) => [t.id, !!t.membersOnly, t.nsfw])).toEqual([
      ['pub', false, false],
      ['mem', true, false],
      ['nsfw', false, true],
    ]);
    expect(tracksFromRows(docs.map((r) => masked(r, MEMBERS_CATALOG_FIELDS)))).toEqual(full);
  });

  it('genre pages and later pages ask with the mask too', async () => {
    const f = mockFetch(rows);
    const src = new FirestoreSource({ fetch: f as any });
    await src.byGenre('folk', { createdAt: 't', name: 'n' });
    await src.latest({ createdAt: 't', name: 'n' });
    expect(f).toHaveBeenCalledTimes(2);
    for (const call of f.mock.calls) {
      expect(JSON.parse(call[1].body as string).structuredQuery.select).toEqual({ fields: CATALOG_FIELDS.map((fieldPath) => ({ fieldPath })) });
    }
  });
});

// ---- A request that never answers ----------------------------------------------------

describe('request timeout', () => {
  /** A fetch that never answers; it rejects (AbortError) once its signal aborts, like the real one. */
  const hanging = () =>
    vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))),
    );
  /** Whether `p` has settled, and its error, without waiting for it. */
  const watch = (p: Promise<unknown>) => {
    const w = { settled: false, error: undefined as unknown };
    p.catch((e) => (w.error = e)).finally(() => (w.settled = true));
    return w;
  };

  it(`fails after ${REQUEST_TIMEOUT_MS / 1000} s by default, as an error (not offline), and aborts the request`, async () => {
    vi.useFakeTimers();
    try {
      const f = hanging();
      const w = watch(new FirestoreSource({ fetch: f as any }).latest());
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
      expect(w.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.settled).toBe(true);
      expect(w.error).toBeInstanceOf(FirestoreError);
      expect(w.error).toMatchObject({ status: 0, offline: false });
      expect((f.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
      expect(f).toHaveBeenCalledTimes(1); // a hung request is not sent again
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a request whose fetch ignores the abort, and the next call asks again', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(() => new Promise<Response>(() => {}));
      const src = new FirestoreSource({ fetch: f as any, timeoutMs: 1000 });
      const w = watch(src.latest());
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.error).toMatchObject({ name: 'FirestoreError', offline: false });
      void src.latest().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(f).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('covers an answer whose body never arrives', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
      const w = watch(new FirestoreSource({ fetch: f as any, timeoutMs: 1000 }).latest());
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.error).toMatchObject({ name: 'FirestoreError', offline: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('covers waiting for the ID token (signed in)', async () => {
    vi.useFakeTimers();
    try {
      const auth = { signedIn: () => true, token: vi.fn(() => new Promise<string>(() => {})), refreshNow: vi.fn(async () => null) };
      const f = mockFetch(rows);
      const w = watch(new FirestoreSource({ fetch: f as any, auth, timeoutMs: 1000 }).latest());
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.error).toMatchObject({ name: 'FirestoreError', offline: false });
      expect(f).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answer in time leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      await new FirestoreSource({ fetch: mockFetch(rows) as any, timeoutMs: 1000 }).latest();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a lost connection still reads as offline', async () => {
    vi.useFakeTimers();
    try {
      const src = new FirestoreSource({ fetch: (async () => Promise.reject(new TypeError('Failed to fetch'))) as any });
      const w = watch(src.latest());
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(w.error).toMatchObject({ name: 'FirestoreError', offline: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('one retry when the request got no answer at all', () => {
  const failing = () => Promise.reject(new TypeError('Failed to fetch'));
  const answering = () => Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
  /** Whether `p` has settled, and its error, without waiting for it. */
  const watch = (p: Promise<unknown>) => {
    const w = { settled: false, error: undefined as unknown };
    p.catch((e) => (w.error = e)).finally(() => (w.settled = true));
    return w;
  };

  it(`sends the request once more ${RETRY_DELAY_MS / 1000} s after fetch threw (a handover's gap), and answers with its rows`, async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn().mockImplementationOnce(failing).mockImplementationOnce(answering);
      const src = new FirestoreSource({ fetch: f as any });
      const w = watch(src.latest());
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
      expect(f).toHaveBeenCalledTimes(1);
      expect(w.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(f).toHaveBeenCalledTimes(2);
      expect(w.settled).toBe(true);
      expect(w.error).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second failure surfaces as offline, with two requests and no third', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(failing);
      const w = watch(new FirestoreSource({ fetch: f as any }).latest());
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(w.error).toMatchObject({ name: 'FirestoreError', status: 0, offline: true });
      expect(f).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect(f).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offline, there is no retry: the answer is known and the error surfaces at once', async () => {
    vi.useFakeTimers();
    online.value = false;
    try {
      const f = vi.fn(failing);
      const w = watch(new FirestoreSource({ fetch: f as any }).latest());
      await vi.advanceTimersByTimeAsync(0);
      expect(w.error).toMatchObject({ name: 'FirestoreError', status: 0, offline: true });
      expect(f).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      online.value = true;
      vi.useRealTimers();
    }
  });

  it('an HTTP error is not retried', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(async () => new Response(JSON.stringify([{ error: { message: 'Missing or insufficient permissions.' } }]), { status: 403 }));
      const w = watch(new FirestoreSource({ fetch: f as any }).latest());
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(w.error).toMatchObject({ name: 'FirestoreError', status: 403 });
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the retry stays inside the same budget: a request that fails at once has waited for nothing when the time is up', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(failing);
      const w = watch(new FirestoreSource({ fetch: f as any, timeoutMs: RETRY_DELAY_MS / 2 }).latest());
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS / 2);
      expect(w.settled).toBe(true);
      expect(w.error).toMatchObject({ name: 'FirestoreError', status: 0 });
      expect(f).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
