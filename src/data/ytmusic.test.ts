import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));

const m = await import('./ytmusic');
type Plugin = import('./ytmusic').JukeMusicPlugin;

const song = (id: string, extra: Partial<import('./ytmusic').MusicItem> = {}) => ({
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
    const plugin = { search: vi.fn(), more: vi.fn(), playlist: vi.fn(), artist: vi.fn(async () => ({ items: [artist('Queen', QUEEN)] })), lyrics: vi.fn() };
    const c = m.createMusicClient({ plugin: () => plugin as unknown as Plugin });
    expect(await c.artist('Queen')).toHaveLength(1);
    await c.artist(' queen ');
    expect(plugin.artist).toHaveBeenCalledTimes(1);
  });
});
