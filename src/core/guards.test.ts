import { describe, expect, it } from 'vitest';
import { asTrack, audioIdOf, hasAudio, asTracks, isAudioId, isTrackFull, parseMusicItem, parseMusicPage, parseNativeState, parseRunQueryRows, parseLocalFolders, parseLocalSongs, parseTrackArtists } from './guards';

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
      prevIndex: [2],
      mineIndex: [0, 1],
      lapIndex: [0],
      heardIndex: [2],
      autoIndex: [0, 2],
      heardMine: [{ track: { id: 'q', ytId: 'abcdefghijk', title: 'Q', artist: 'X' }, after: 'b' }],
      listStart: 1,
      nextStart: 2,
      context: { label: 'Liked', mode: 'list' },
      seedId: 'b',
      currentAuto: true,
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
    // The played tracks' list indices: in range, never the current one; the last 50 at most.
    expect(parseNativeState({ index: 1, queueIds: ['A', 'B', 'C'], prevIndex: [0, 1, 7, -1, 'x', 2] })?.prevIndex).toEqual([0, 2]);
    // An older native sends none.
    expect(parseNativeState({ index: 0, queueIds: ['A', 'B'], upNextIds: ['B'] })?.upNextIndex).toEqual([-1]);
  });

  it('keeps the indices of the songs you queued and of the next lap only when in range; the lap never holds the current one', () => {
    const st = parseNativeState({ index: 1, queueIds: ['A', 'B', 'C'], mineIndex: [1, 2, 3, -1, 0.5, 'x'], lapIndex: [0, 1, 7, 'x', 2] });
    // The playing song keeps its mark.
    expect(st?.mineIndex).toEqual([1, 2]);
    expect(st?.lapIndex).toEqual([0, 2]);
    // Undo's flags (heard, autoplay), the same way.
    expect(parseNativeState({ index: 1, queueIds: ['A', 'B', 'C'], heardIndex: [2, 3, 'x'], autoIndex: [0, -1, 0.5] })).toMatchObject({ heardIndex: [2], autoIndex: [0] });
    // The lap's first 50.
    const queueIds = Array.from({ length: 60 }, (_, i) => `t${i}`);
    expect(parseNativeState({ index: 59, queueIds, lapIndex: queueIds.map((_, i) => i) })?.lapIndex).toEqual(queueIds.slice(0, 50).map((_, i) => i));
    // An older native sends neither.
    expect(parseNativeState({ index: 0, queueIds: ['A'] })).toMatchObject({ mineIndex: [], lapIndex: [], heardIndex: [], autoIndex: [] });
  });

  it('reads where the current list and the autoplay on the way start; an older native sends neither', () => {
    const q = ['A', 'B', 'C', 'D'];
    expect(parseNativeState({ index: 2, queueIds: q, listStart: 1, nextStart: 3 })).toMatchObject({ listStart: 1, nextStart: 3 });
    expect(parseNativeState({ index: 2, queueIds: q })).toMatchObject({ listStart: 0, nextStart: -1 });
    for (const junk of [-1, 4, 1.5, '1', null]) expect(parseNativeState({ index: 2, queueIds: q, listStart: junk, nextStart: junk })).toMatchObject({ listStart: 0, nextStart: -1 });
  });

  it("reads Save's memory: each record with a track and the id before it (or null), the last 200; an older native sends none", () => {
    const track = { id: 'Q', ytId: 'abcdefghijk', title: 'Q', artist: 'X' };
    const heardMine = [{ track, after: 'A' }, { track, after: 7 }, { after: 'A' }, 'x', null];
    expect(parseNativeState({ index: 0, queueIds: ['A'], heardMine })?.heardMine).toEqual([{ track, after: 'A' }, { track, after: null }]);
    const many = Array.from({ length: 205 }, (_, i) => ({ track: { ...track, id: `q${i}` }, after: null }));
    expect(parseNativeState({ index: 0, queueIds: ['A'], heardMine: many })?.heardMine?.map((h) => h.track.id)).toEqual(many.slice(5).map((h) => h.track.id));
    expect(parseNativeState({ index: 0, queueIds: ['A'] })?.heardMine).toEqual([]);
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
      prevIndex: [],
      mineIndex: [],
      lapIndex: [],
      heardIndex: [],
      autoIndex: [],
      heardMine: [],
      listStart: 0,
      nextStart: -1,
      context: null,
      seedId: null,
      currentAuto: false,
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

describe('parseTrackArtists', () => {
  const GW = { name: 'Grover Washington, Jr.', channelId: 'UCsN1HTruhFfXcSMGMsBmX_w' };

  it('keeps each artist with a name and a UC… channel, at most 10', () => {
    expect(parseMusicItem({ kind: 'song', title: 'S', subtitle: 'Grover Washington, Jr.', url: 'u', artists: [GW] })!.artists).toEqual([GW]);
    expect(parseTrackArtists([GW, { name: '', channelId: GW.channelId }, { name: 'X', channelId: 'PL123' }, { name: 7, channelId: GW.channelId }, 'x', null])).toEqual([GW]);
    expect(parseTrackArtists([{ name: ' Padded ', channelId: GW.channelId }])).toEqual([{ name: 'Padded', channelId: GW.channelId }]);
    expect(parseTrackArtists(Array.from({ length: 15 }, () => GW))).toHaveLength(10);
    expect(parseTrackArtists('nope')).toEqual([]);
    expect(parseMusicItem({ kind: 'song', title: 'S', subtitle: 'A', url: 'u', artists: [{ name: 'A' }] })).not.toHaveProperty('artists');
  });

  it('keeps a stored Global track\'s artists', () => {
    expect(asTrack({ ...track, artists: [GW, { name: 'bad' }] })!.artists).toEqual([GW]);
    expect(asTrack(track)).not.toHaveProperty('artists');
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

  it('names the audio of a track as the native listening cache does: the video id, or mp3: and the file name of its MP3', () => {
    expect(audioIdOf(track)).toBe(track.ytId);
    expect(audioIdOf({ ytId: '', mp3: 'https://latex.gg/share/IZq8cMcx.mp3' })).toBe('mp3:IZq8cMcx.mp3');
    // A placeholder, or a link that isn't a Jukebox MP3: nothing to cache.
    expect(audioIdOf({ ytId: '' })).toBe('');
    expect(audioIdOf({ ytId: '', mp3: 'https://evil.example/share/x.mp3' })).toBe('');
    expect(audioIdOf(null)).toBe('');
    for (const ok of ['abcdefghijk', 'mp3:IZq8cMcx.mp3', 'mp3:a-b_C.MP3']) expect(isAudioId(ok), ok).toBe(true);
    for (const bad of ['', 'mp3:', 'mp3:x.ogg', 'mp3:../x.mp3', 'mp3:a/b.mp3', 'MP3:IZq8cMcx.mp3', 'IZq8cMcx.mp3', 'https://latex.gg/share/IZq8cMcx.mp3', 'short', 42, null]) {
      expect(isAudioId(bad), String(bad)).toBe(false);
    }
  });

  it('keeps a Signal Radio track a Signal Radio track (Liked and history survive a restart)', () => {
    const sig = { ...track, id: 'sig:cipher:abcdefghijk', ytId: 'abcdefghijk', genre: 'CIPHER', by: '', postTitle: '', postUrl: '', source: 'signal' };
    expect(isTrackFull(sig)).toBe(true);
    expect(asTrack(JSON.parse(JSON.stringify(sig)))).toEqual(sig);
  });

  it('asTrack keeps the album of a Global album track, and drops anything else there', () => {
    expect(asTrack({ ...track, album: 'Blue Lines' })?.album).toBe('Blue Lines');
    expect(asTrack({ ...track, album: '' })).not.toHaveProperty('album');
    expect(asTrack({ ...track, album: 7 })).not.toHaveProperty('album');
    expect(asTrack(track)).not.toHaveProperty('album');
  });
});

describe('local music answers', () => {
  it('keeps folders with an id, defaulting a missing name, count or state', () => {
    expect(
      parseLocalFolders({
        folders: [
          { id: 'content://t/a', name: 'Music', songs: 312, state: 'ok' },
          { id: 'content://t/b', state: 'gone' },
          { id: 'content://t/c', name: 'X', songs: -3, state: 'weird' },
          { name: 'no id' },
          null,
        ],
      }),
    ).toEqual([
      { id: 'content://t/a', name: 'Music', songs: 312, state: 'ok' },
      { id: 'content://t/b', name: 'Folder', songs: 0, state: 'gone' },
      { id: 'content://t/c', name: 'X', songs: 0, state: 'ok' },
    ]);
    expect(parseLocalFolders(null)).toEqual([]);
  });

  it('keeps songs with a loc: id and a folder, filling missing tags', () => {
    expect(
      parseLocalSongs({
        tracks: [
          { id: 'loc:0123456789abcdef', title: 'Night Shift', artist: 'The Low Hum', album: 'Basement Weather', albumArtist: 'Various', track: 4, disc: 2, year: 1990, durationMs: 201000, modified: 1700000000000, folder: 'f', cover: true },
          { id: 'loc:fedcba9876543210', title: ' ', folder: 'f', track: -1, disc: 2.5, year: '1990', modified: -1 },
          { id: 'loc:XYZ', title: 'bad id', folder: 'f' },
          { id: 'loc:0000000000000000', title: 'no folder' },
        ],
      }),
    ).toEqual([
      { id: 'loc:0123456789abcdef', title: 'Night Shift', artist: 'The Low Hum', album: 'Basement Weather', albumArtist: 'Various', track: 4, disc: 2, year: 1990, durationMs: 201000, modified: 1700000000000, folder: 'f', cover: true },
      { id: 'loc:fedcba9876543210', title: 'Untitled', artist: 'Unknown artist', album: '', albumArtist: '', track: 0, disc: 0, year: 0, durationMs: 0, modified: 0, folder: 'f', cover: false },
    ]);
  });
});

describe('local songs as stored tracks', () => {
  const local = { id: 'loc:0123456789abcdef', ytId: '', title: 'Night Shift', artist: 'The Low Hum', genre: '', by: '', postTitle: '', postUrl: '', createdAt: '', nsfw: false, artworkUrl: '', source: 'local' as const };

  it('tidies the text of a stored track and a local song as it is read', () => {
    expect(asTrack({ ...local, title: 'Night' + ' '.repeat(50_000) + 'Shift' })!.title).toBe('Night Shift');
    const [song] = parseLocalSongs({ tracks: [{ id: local.id, title: 'T', artist: 'The\nLow  Hum', album: 'y'.repeat(5000), folder: 'f' }] });
    expect(song).toMatchObject({ artist: 'The Low Hum' });
    expect(song!.album.length).toBeLessThanOrEqual(300);
  });

  it('a liked local song survives a reload, as a full track and repaired', () => {
    expect(isTrackFull(local)).toBe(true);
    expect(asTrack(local)).toMatchObject({ id: 'loc:0123456789abcdef', ytId: '', source: 'local' });
    expect(hasAudio(local)).toBe(true);
  });

  it('a loc: id without the local origin, or a malformed one, has nothing to play', () => {
    expect(asTrack({ ...local, source: undefined })).toBeNull();
    expect(asTrack({ ...local, id: 'loc:XYZ' })).toBeNull();
    expect(isTrackFull({ ...local, id: 'loc:123' })).toBe(false);
    expect(audioIdOf(local)).toBe('');
  });
});
