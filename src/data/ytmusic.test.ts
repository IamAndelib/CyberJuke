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
