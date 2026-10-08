import { describe, expect, it } from 'vitest';
import { asTrack, asTracks, isTrackFull, parseMusicItem, parseMusicPage, parseNativeState, parseRunQueryRows } from './guards';

const track = {
  id: 'p1',
  ytId: 'abcdefghijk',
  title: 'T',
  artist: 'A',
  genre: 'g',
  by: 'u',
  postTitle: '',
  postUrl: 'https://beta.cyberspace.online/u/p',
  createdAt: '2026-01-01T00:00:00Z',
  nsfw: false,
  artworkUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
};

describe('parseNativeState', () => {
  it('passes a well-formed state through', () => {
    const st = { isPlaying: true, isBuffering: false, index: 1, trackId: 'b', positionMs: 1200, durationMs: 9000, shuffle: false, repeat: 'all', queueIds: ['a', 'b'], upNextIds: ['a'] };
    expect(parseNativeState(st)).toEqual(st);
  });

  it('keeps the previous list when the event says it is unchanged', () => {
    const st = parseNativeState({ isPlaying: false, index: 0, trackId: 'a', queueIdsUnchanged: true, upNextIds: ['b'] }, ['a', 'b']);
    expect(st?.queueIds).toEqual(['a', 'b']);
    expect(st?.index).toBe(0);
  });

  it('repairs junk instead of throwing', () => {
    const st = parseNativeState({ isPlaying: 'yes', index: 7, positionMs: -5, durationMs: NaN, repeat: 'sometimes', queueIds: ['a', 3, null], upNextIds: 'x' });
    expect(st).toEqual({ isPlaying: false, isBuffering: false, index: -1, trackId: null, positionMs: 0, durationMs: 0, shuffle: false, repeat: 'off', queueIds: ['a'], upNextIds: [] });
    expect(parseNativeState(null)).toBeNull();
    expect(parseNativeState([1])).toBeNull();
  });
});

describe('parseMusicPage', () => {
  it('drops unusable items and bad optional fields', () => {
    const page = parseMusicPage({
      items: [
        { kind: 'song', title: 'S', subtitle: 'A', url: 'https://music.youtube.com/watch?v=abcdefghijk', ytId: 'abcdefghijk', durationSec: 200, thumbnailUrl: 'https://lh3.googleusercontent.com/x' },
        { kind: 'video', title: 'V', url: 'u' },
        { kind: 'album', title: 5, url: 'https://music.youtube.com/browse/x', thumbnailUrl: 'javascript:alert(1)', ytId: 'short' },
        'junk',
      ],
      next: 'tok',
    });
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toEqual({ kind: 'album', title: '', subtitle: '', url: 'https://music.youtube.com/browse/x' });
    expect(page.next).toBe('tok');
    expect(parseMusicPage(undefined)).toEqual({ items: [] });
    expect(parseMusicItem({ kind: 'song', url: '' })).toBeNull();
  });
});

describe('parseRunQueryRows', () => {
  it('keeps rows, dropping documents without a name', () => {
    const rows = parseRunQueryRows([{ document: { name: 'n', fields: { a: { stringValue: 'x' } } }, readTime: 't' }, { document: { fields: {} } }, 4, { done: true }]);
    expect(rows).toEqual([{ document: { name: 'n', fields: { a: { stringValue: 'x' } } }, readTime: 't' }, {}, { done: true }]);
    expect(parseRunQueryRows({ error: 1 })).toBeNull();
  });
});

describe('stored tracks', () => {
  it('isTrackFull checks every field', () => {
    expect(isTrackFull(track)).toBe(true);
    expect(isTrackFull({ ...track, membersOnly: true, saves: 3, source: 'ytmusic' })).toBe(true);
    expect(isTrackFull({ ...track, ytId: 'bad' })).toBe(false);
    expect(isTrackFull({ ...track, nsfw: 'no' })).toBe(false);
    expect(isTrackFull({ ...track, source: 'other' })).toBe(false);
    const { artist: _a, ...noArtist } = track;
    expect(isTrackFull(noArtist)).toBe(false);
  });

  it('asTrack repairs what older versions saved, and drops what it cannot', () => {
    expect(asTrack({ id: 'x', ytId: 'abcdefghijk', title: 'T' })).toEqual({ id: 'x', ytId: 'abcdefghijk', title: 'T', artist: '', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '', nsfw: false, artworkUrl: '' });
    expect(isTrackFull(asTrack({ ...track, saves: 'x', membersOnly: 'yes' }))).toBe(true);
    expect(asTrack({ ...track, ytId: '<script>' })).toBeNull();
    expect(asTracks([track, null, { id: '' }, track])).toHaveLength(2);
    expect(asTracks('nope')).toEqual([]);
  });
});
