import { describe, expect, it, vi } from 'vitest';
import type { JukeMusicPlugin, MusicItem, Release, ReleaseKind } from './ytmusic';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));

const m = await import('./ytmusic');
type Plugin = JukeMusicPlugin;

const song = (id: string, extra: Partial<MusicItem> = {}) => ({
  kind: 'song' as const,
  title: 'Song ' + id,
  subtitle: 'Artist',
  url: `https://music.youtube.com/watch?v=${id}`,
  ytId: id,
  ...extra,
});

describe('musicItemToTrack', () => {
  it('maps a song to a Global Track', () => {
    expect(m.musicItemToTrack(song('abcdefghijk', { durationSec: 200, thumbnailUrl: 'https://x/y.jpg' }))).toEqual({
      id: 'ytm:abcdefghijk',
      ytId: 'abcdefghijk',
      title: 'Song abcdefghijk',
      artist: 'Artist',
      genre: '',
      by: '',
      postTitle: '',
      postUrl: '',
      createdAt: '',
      nsfw: false,
      artworkUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
      source: 'ytmusic',
    });
  });

  it('cleans " - Topic", falls back for missing artist/title, and reads the id from the url', () => {
    const t = m.musicItemToTrack({ kind: 'song', title: ' ', subtitle: 'Band - Topic', url: 'https://music.youtube.com/watch?v=ABCDEFGHIJK' })!;
    expect(t.ytId).toBe('ABCDEFGHIJK');
    expect(t.title).toBe('Untitled');
    expect(t.artist).toBe('Band');
    expect(m.musicItemToTrack(song('abcdefghijk', { subtitle: '' }), 'Fallback')!.artist).toBe('Fallback');
  });

  it('skips non-songs and songs without an id, and de-duplicates', () => {
    expect(m.musicItemToTrack({ kind: 'album', title: 'A', subtitle: '', url: 'u' })).toBeNull();
    expect(m.musicItemToTrack({ kind: 'song', title: 'A', subtitle: '', url: 'https://x' })).toBeNull();
    expect(m.musicTracks([song('abcdefghijk'), song('abcdefghijk'), song('bcdefghijkl')]).map((t) => t.id)).toEqual([
      'ytm:abcdefghijk',
      'ytm:bcdefghijkl',
    ]);
  });
});

describe('errors', () => {
  it('keeps the plugin code, or reads it from the message prefix', () => {
    expect(m.toMusicError({ code: 'BOT_CHECK', message: 'BOT_CHECK: sign in' }).code).toBe('BOT_CHECK');
    expect(m.toMusicError(new Error('NETWORK: timeout')).code).toBe('NETWORK');
    expect(m.toMusicError({ code: 'WEIRD', message: 'x' }).code).toBe('UNAVAILABLE');
    expect(m.toMusicError('boom').code).toBe('UNAVAILABLE');
  });

  it('treats an expired paging token as the end of the list', () => {
    expect(m.isEndOfList({ code: 'UNAVAILABLE', message: 'UNAVAILABLE: unknown or expired paging token' })).toBe(true);
    expect(m.isEndOfList({ code: 'BOT_CHECK', message: 'BOT_CHECK: x' })).toBe(false);
    expect(m.isEndOfList({ code: 'UNAVAILABLE', message: 'UNAVAILABLE: extractor broke' })).toBe(false);
  });

  it('never names the provider in UI text', () => {
    for (const code of ['BOT_CHECK', 'NETWORK', 'UNAVAILABLE'] as const) expect(m.musicErrorText({ code })).not.toMatch(/youtube/i);
    expect(m.musicErrorText({ code: 'BOT_CHECK' })).toBe("Global search isn't available on this network right now, try again later");
  });
});

describe('client', () => {
  function setup() {
    let now = 0;
    const plugin: Plugin = {
      search: vi.fn(async ({ query }) => ({ items: [song('abcdefghijk', { title: query })], next: 'tok1' })),
      more: vi.fn(async () => ({ items: [song('bcdefghijkl')] })),
      playlist: vi.fn(async () => ({ title: 'Album', subtitle: '', items: [] })),
      artist: vi.fn(async () => ({ items: [] })),
      lyrics: vi.fn(async () => ({ found: false })),
      artistPage: vi.fn(async () => ({ name: 'A', topSongs: [], releases: [] })),
      artistReleases: vi.fn(async () => ({ releases: [] })),
    };
    const c = m.createMusicClient({ plugin: () => plugin, now: () => now });
    return { c, plugin, tick: (ms: number) => (now += ms) };
  }

  it('caches results for 10 minutes', async () => {
    const { c, plugin, tick } = setup();
    await c.search('daft punk', 'songs');
    await c.search(' Daft Punk ', 'songs');
    expect(plugin.search).toHaveBeenCalledTimes(1);
    expect(c.peekSearch('daft punk', 'songs')?.next).toBe('tok1');
    await c.search('daft punk', 'albums');
    expect(plugin.search).toHaveBeenCalledTimes(2);
    tick(m.MUSIC_CACHE_TTL_MS - 1);
    await c.search('daft punk', 'songs');
    expect(plugin.search).toHaveBeenCalledTimes(2);
    tick(1);
    expect(c.peekSearch('daft punk', 'songs')).toBeUndefined();
    await c.search('daft punk', 'songs');
    expect(plugin.search).toHaveBeenCalledTimes(3);
  });

  it('de-duplicates in-flight calls and caches more/playlist', async () => {
    const { c, plugin } = setup();
    await Promise.all([c.more('t'), c.more('t')]);
    await c.more('t');
    expect(plugin.more).toHaveBeenCalledTimes(1);
    await c.playlist('u');
    await c.playlist('u');
    expect(plugin.playlist).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures and normalizes their codes', async () => {
    const plugin: Plugin = {
      search: vi.fn().mockRejectedValueOnce({ code: 'BOT_CHECK', message: 'BOT_CHECK: confirm' }).mockResolvedValue({ items: [] }),
      more: vi.fn(),
      playlist: vi.fn(),
      artist: vi.fn(),
      lyrics: vi.fn(),
      artistPage: vi.fn(),
      artistReleases: vi.fn(),
    };
    const c = m.createMusicClient({ plugin: () => plugin });
    await expect(c.search('x', 'songs')).rejects.toMatchObject({ code: 'BOT_CHECK' });
    await expect(c.search('x', 'songs')).resolves.toEqual({ items: [] });
  });

  it('rejects with UNAVAILABLE when there is no plugin (browser without a stub)', async () => {
    const c = m.createMusicClient({ plugin: () => null });
    await expect(c.search('x', 'songs')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(m.music.search('x', 'songs')).rejects.toBeInstanceOf(m.MusicError);
  });
});

describe('exact artist identity', () => {
  const QUEEN = 'UCiMhD4jzUqG-IgPzUmmytRQ';
  const IVY = 'UCivyqueen000000000000a';
  const BUTTERFLY = 'UCqueenbutterfly000000b';
  const artist = (title: string, channelId?: string, url = '') => ({ kind: 'artist' as const, title, subtitle: '', url, ...(channelId && { channelId }) });

  it('reads channel ids from items and URLs', () => {
    expect(m.channelIdFromUrl('https://music.youtube.com/channel/' + QUEEN)).toBe(QUEEN);
    expect(m.channelIdFromUrl('https://music.youtube.com/browse/MPREb_x')).toBeUndefined();
    expect(m.itemChannelId(song('abcdefghijk', { artistUrl: 'https://www.youtube.com/channel/' + QUEEN }))).toBe(QUEEN);
    expect(m.itemChannelId(artist('Queen', undefined, 'https://music.youtube.com/channel/' + QUEEN))).toBe(QUEEN);
    expect(m.itemChannelId(song('abcdefghijk', { channelId: IVY, artistUrl: 'https://x/channel/' + QUEEN }))).toBe(IVY);
  });

  it('resolves only an exact name: Ivy Queen and Queen Butterfly are not Queen', () => {
    const cands = [artist('Ivy Queen', IVY), artist('Queen Butterfly', BUTTERFLY), artist('Queen', QUEEN), artist('QUEEN', 'UCsecond000000000000000')];
    expect(m.resolveArtistChannel(cands, 'Queen')).toBe(QUEEN);
    expect(m.resolveArtistChannel(cands, 'queen')).toBe(QUEEN);
    expect(m.resolveArtistChannel([artist('Ivy Queen', IVY), artist('Queen Butterfly', BUTTERFLY)], 'Queen')).toBeNull();
    expect(m.resolveArtistChannel([artist('Queen')], 'Queen')).toBeNull(); // no channel, no identity
    expect(m.resolveArtistChannel([{ ...song('abcdefghijk', { channelId: QUEEN }), title: 'Queen' }], 'Queen')).toBeNull();
    expect(m.resolveArtistChannel([artist('Björk', 'UCbjork00000000000000000')], 'bjork')).toBe('UCbjork00000000000000000');
  });

  it('filters by channel, with an exact-credit fallback when an item has no channel', () => {
    expect(m.isByArtist(song('a', { subtitle: 'Queen', channelId: QUEEN }), QUEEN, 'Queen')).toBe(true);
    expect(m.isByArtist(song('a', { subtitle: 'Ivy Queen', channelId: IVY }), QUEEN, 'Queen')).toBe(false);
    // A channel mismatch wins over a matching credit (first credited artist is someone else).
    expect(m.isByArtist(song('a', { subtitle: 'X, Queen', channelId: IVY }), QUEEN, 'Queen')).toBe(false);
    // Fallback: whole split credits only.
    expect(m.isByArtist(song('a', { subtitle: 'Queen' }), QUEEN, 'Queen')).toBe(true);
    expect(m.isByArtist(song('a', { subtitle: 'Queen & David Bowie' }), QUEEN, 'Queen')).toBe(false);
    expect(m.isByArtist(song('a', { subtitle: 'David Bowie, Queen' }), QUEEN, 'Queen')).toBe(true);
    expect(m.isByArtist(song('a', { subtitle: 'Ivy Queen' }), QUEEN, 'Queen')).toBe(false);
    expect(m.isByArtist(song('a', { subtitle: 'Queen Butterfly - Topic' }), QUEEN, 'Queen')).toBe(false);
    expect(m.isByArtist(song('a', { subtitle: 'Queen - Topic' }), QUEEN, 'Queen')).toBe(true);
  });

  it('caches artist lookups by normalized name', async () => {
    const plugin = { search: vi.fn(), more: vi.fn(), playlist: vi.fn(), artist: vi.fn(async () => ({ items: [artist('Queen', QUEEN, 'https://music.youtube.com/channel/' + QUEEN), { kind: 'artist', title: 'no url' }] })), lyrics: vi.fn() };
    const c = m.createMusicClient({ plugin: () => plugin as unknown as Plugin });
    expect(await c.artist('Queen')).toHaveLength(1); // the item without a URL is dropped at the bridge
    await c.artist(' queen ');
    expect(plugin.artist).toHaveBeenCalledTimes(1);
  });
});

describe('results are checked at the bridge', () => {
  it('drops junk items, releases and fields from the plugin', async () => {
    const plugin = {
      search: vi.fn(async () => ({ items: [song('abcdefghijk'), null, { kind: 'song' }], next: 7 })),
      artistPage: vi.fn(async () => ({ name: 'A', topSongs: 'nope', releases: [{ kind: 'weird', title: 'T', url: 'u', thumbnailUrl: 'http://x' }, { title: 'no url' }], more: { albums: 3 } })),
      artistReleases: vi.fn(async () => null),
    };
    const c = m.createMusicClient({ plugin: () => plugin as unknown as Plugin });
    const page = await c.search('q', 'songs');
    expect(page.items).toHaveLength(1);
    expect(page.next).toBeUndefined();
    const ap = await c.artistPage('UC1');
    expect(ap.topSongs).toEqual([]);
    expect(ap.releases).toEqual([{ kind: 'album', title: 'T', url: 'u' }]);
    expect(ap.more).toEqual({});
    expect(await c.artistReleases('t')).toEqual([]);
  });
});

describe('discography shelves', () => {
  const r = (kind: ReleaseKind, title: string, url = title): Release => ({ kind, title, url });

  it('classifies albums, EPs, singles and live albums, with tricky titles', () => {
    const cases: [ReleaseKind, string, ReleaseKind][] = [
      ['album', 'A Night at the Opera', 'album'],
      ['album', 'Live Killers', 'live'],
      ['album', 'Live at Wembley ’86', 'live'],
      ['album', 'MTV Unplugged in New York', 'live'],
      ['album', 'Queen Rock Montreal (Live)', 'live'],
      ['album', 'In Concert 1972', 'live'],
      ['album', 'Recorded Live From the Roxy', 'live'],
      ['album', 'LIVE', 'live'],
      // Not live: "live" inside a word.
      ['album', 'Alive', 'album'],
      ['album', 'Deliverance', 'album'],
      ['album', 'Olive Grove', 'album'],
      ['album', 'Livestock', 'album'],
      ['album', 'Oliver’s Army', 'album'],
      // Native kinds are kept; a live EP is a live album, a live single stays a single.
      ['ep', 'Five Live Yardbirds EP', 'live'],
      ['ep', 'Under Pressure EP', 'ep'],
      ['single', 'Bohemian Rhapsody (Live Aid)', 'single'],
      ['single', 'Live Forever', 'single'],
      ['live', 'Wembley Stadium', 'live'],
      // Unknown kinds land on Albums.
      ['mixtape' as never, 'Tape One', 'album'],
    ];
    for (const [kind, title, want] of cases) expect([title, m.releaseShelf(r(kind, title))]).toEqual([title, want]);
  });

  it('groups releases by shelf in order, each once by URL', () => {
    const g = m.groupReleases([
      r('album', 'A', 'u1'),
      r('single', 'S', 'u2'),
      r('album', 'Live at X', 'u3'),
      r('ep', 'E', 'u4'),
      r('album', 'A again', 'u1'),
      r('album', 'B', 'u5'),
      { kind: 'album', title: 'no url', url: '' },
    ]);
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((x) => x.title)]))).toEqual({
      album: ['A', 'B'],
      live: ['Live at X'],
      ep: ['E'],
      single: ['S'],
    });
    expect(m.SHELF_ORDER).toEqual(['album', 'live', 'ep', 'single']);
    expect(Object.values(m.SHELF_LABEL)).toEqual(['Albums', 'Live albums', 'EPs', 'Singles']);
  });

  it('"See all" tokens: Albums and Live albums share albums, EPs and Singles share singles', () => {
    const more = { albums: 'A', singles: 'S' };
    expect(m.shelfToken('album', more)).toBe('A');
    expect(m.shelfToken('live', more)).toBe('A');
    expect(m.shelfToken('ep', more)).toBe('S');
    expect(m.shelfToken('single', more)).toBe('S');
    expect(m.shelfToken('album', undefined)).toBeUndefined();
  });

  it('caches artistPage and artistReleases; fresh skips the cache', async () => {
    const plugin = {
      artistPage: vi.fn(async () => ({ name: '', topSongs: undefined as never, releases: undefined as never })),
      artistReleases: vi.fn(async () => ({ releases: [r('album', 'A')] })),
    } as unknown as Plugin;
    const c = m.createMusicClient({ plugin: () => plugin });
    const p = await c.artistPage('UC1');
    expect(p.topSongs).toEqual([]);
    expect(p.releases).toEqual([]);
    await c.artistPage('UC1');
    expect(plugin.artistPage).toHaveBeenCalledTimes(1);
    await c.artistPage('UC1', true);
    expect(plugin.artistPage).toHaveBeenCalledTimes(2);
    expect(await c.artistReleases('tok')).toHaveLength(1);
    await c.artistReleases('tok');
    expect(plugin.artistReleases).toHaveBeenCalledTimes(1);
  });
});
