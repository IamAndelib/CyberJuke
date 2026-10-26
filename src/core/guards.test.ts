import { describe, expect, it } from 'vitest';
import { asTrack, hasAudio, asTracks, isTrackFull, parseMusicItem, parseMusicPage, parseNativeState, parseRunQueryRows } from './guards';

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
    const st = {
      isPlaying: true,
      isBuffering: false,
      index: 1,
      trackId: 'b',
      positionMs: 1200,
      durationMs: 9000,
      shuffle: false,
      repeat: 'all',
      queueIds: ['a', 'b', 'c'],
      upNextIds: ['a', 'c'],
      upNextKinds: 'qa',
      upNextIndex: [0, 2],
      context: { label: 'Liked', mode: 'list' },
      seedId: 'b',
      waitingForNetwork: true,
      bufferedAheadMs: 4000,
    };
    expect(parseNativeState(st)).toEqual(st);
  });

  it('has no audio loaded ahead unless native says how much (older natives send nothing)', () => {
    expect(parseNativeState({ index: -1 })?.bufferedAheadMs).toBe(0);
    for (const junk of [-1, NaN, Infinity, '5000', null]) expect(parseNativeState({ index: -1, bufferedAheadMs: junk })?.bufferedAheadMs).toBe(0);
    expect(parseNativeState({ index: -1, bufferedAheadMs: 5000 })?.bufferedAheadMs).toBe(5000);
  });

  it('is not waiting for the network unless native says so (older natives send nothing)', () => {
    expect(parseNativeState({ index: -1 })?.waitingForNetwork).toBe(false);
    expect(parseNativeState({ index: -1, waitingForNetwork: 'yes' })?.waitingForNetwork).toBe(false);
    expect(parseNativeState({ index: -1, waitingForNetwork: true })?.waitingForNetwork).toBe(true);
  });

  it('pads the up-next kinds to the ids and repairs the context', () => {
    const st = parseNativeState({ index: 0, queueIds: ['a', 'b', 'c'], upNextIds: ['b', 'c'], upNextKinds: 'z', context: { label: 3, mode: 'x' }, seedId: '' });
    expect(st?.upNextKinds).toBe('ll');
    expect(st?.context).toEqual({ label: '', mode: 'list' });
    expect(st?.seedId).toBeNull();
  });

  it('keeps each up-next index only when it is in range and holds that id', () => {
    const st = parseNativeState({ index: 2, queueIds: ['A', 'B', 'C', 'A', 'D'], upNextIds: ['A', 'D', 'B'], upNextIndex: [3, 9, 0.5] });
    expect(st?.upNextIndex).toEqual([3, -1, -1]);
    expect(parseNativeState({ index: 0, queueIds: ['A', 'B'], upNextIds: ['B'], upNextIndex: [0] })?.upNextIndex).toEqual([-1]);
    // An older native sends none.
    expect(parseNativeState({ index: 0, queueIds: ['A', 'B'], upNextIds: ['B'] })?.upNextIndex).toEqual([-1]);
  });

  it('keeps the previous list when the event says it is unchanged', () => {
    const st = parseNativeState({ isPlaying: false, index: 0, trackId: 'a', queueIdsUnchanged: true, upNextIds: ['b'] }, ['a', 'b']);
    expect(st?.queueIds).toEqual(['a', 'b']);
    expect(st?.index).toBe(0);
  });

  it('repairs junk instead of throwing', () => {
    const st = parseNativeState({ isPlaying: 'yes', index: 7, positionMs: -5, durationMs: NaN, repeat: 'sometimes', queueIds: ['a', 3, null], upNextIds: 'x' });
    expect(st).toEqual({
      isPlaying: false,
      isBuffering: false,
      index: -1,
      trackId: null,
      positionMs: 0,
      durationMs: 0,
      shuffle: false,
      repeat: 'off',
      queueIds: ['a'],
      upNextIds: [],
      upNextKinds: '',
      upNextIndex: [],
      context: null,
      seedId: null,
      waitingForNetwork: false,
      bufferedAheadMs: 0,
    });
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
    expect(rows).toEqual([{ document: { name: 'n', fields: { a: { stringValue: 'x' } } } }, {}, {}]);
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

  it('keeps a Jukebox MP3 (no video id, a latex.gg link), and nothing else in its place', () => {
    const mp3 = { ...track, ytId: '', mp3: 'https://latex.gg/share/IZq8cMcx.mp3' };
    expect(isTrackFull(mp3)).toBe(true);
    expect(asTrack(mp3)).toEqual(mp3);
    expect(hasAudio(mp3)).toBe(true);
    for (const bad of ['https://evil.com/share/x.mp3', 'http://latex.gg/share/x.mp3', 'https://latex.gg/share/x.wav', 42]) {
      expect(isTrackFull({ ...mp3, mp3: bad }), String(bad)).toBe(false);
      expect(asTrack({ ...mp3, mp3: bad }), String(bad)).toBeNull();
    }
    expect(isTrackFull({ ...mp3, ytId: 'bad' })).toBe(false);
    // Never both: a video id wins.
    expect(isTrackFull({ ...mp3, ytId: 'abcdefghijk' })).toBe(false);
    expect(asTrack({ ...mp3, ytId: 'abcdefghijk' })).not.toHaveProperty('mp3');
    expect(asTrack({ ...mp3, ytId: '<script>' })).toEqual(mp3);
    expect(hasAudio({ ytId: '' })).toBe(false);
    expect(hasAudio(null)).toBe(false);
    expect(hasAudio(track)).toBe(true);
  });

  it('asTrack keeps the album of a Global album track, and drops anything else there', () => {
    expect(asTrack({ ...track, album: 'Blue Lines' })?.album).toBe('Blue Lines');
    expect(asTrack({ ...track, album: '' })).not.toHaveProperty('album');
    expect(asTrack({ ...track, album: 7 })).not.toHaveProperty('album');
    expect(asTrack(track)).not.toHaveProperty('album');
  });
});
