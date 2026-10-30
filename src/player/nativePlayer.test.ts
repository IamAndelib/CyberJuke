import type { Signal } from '@preact/signals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';

vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));

/** The fake JukePlayer plugin: listeners in the order added, every command a mock. */
const fake = vi.hoisted(() => {
  const listeners = new Map<string, (e: unknown) => void>();
  const order: string[] = [];
  const ok = () => Promise.resolve();
  const cmd = () => vi.fn((_o?: any): Promise<void> => Promise.resolve());
  return {
    listeners,
    order,
    plugin: {
      addListener: (ev: string, cb: (e: unknown) => void) => {
        listeners.set(ev, cb);
        order.push(ev);
        return Promise.resolve({ remove: ok });
      },
      getState: vi.fn((): Promise<unknown> => new Promise(() => {})),
      setQueue: cmd(),
      skipToIndex: cmd(),
      removeItem: cmd(),
      moveItem: cmd(),
      restore: cmd(),
      removeIds: cmd(),
      queueNext: cmd(),
      addAutoplay: cmd(),
      play: cmd(),
      pause: cmd(),
      setShuffle: cmd(),
      setRepeat: cmd(),
    },
  };
});

vi.mock('./native', async (orig) => ({ ...(await orig<object>()), JukePlayer: fake.plugin }));
vi.mock('../stores/catalog', async () => {
  const { signal: sig } = await import('@preact/signals');
  return { catalog: { all: sig<Track[]>([]) } };
});

const { NativePlayer, bridgeWindow, toNative } = await import('./nativePlayer');
const { catalog } = await import('../stores/catalog');
const lib = await import('../stores/library');
const { BRIDGE_MAX_ITEMS, BRIDGE_MAX_STRING } = await import('./native');
const { toasts } = await import('../stores/toast');

const tr = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  ytId: (id + '___________').slice(0, 11),
  title: 'Title ' + id,
  artist: 'X',
  genre: '',
  by: '',
  postTitle: '',
  postUrl: '',
  createdAt: '',
  nsfw: false,
  artworkUrl: '',
  ...extra,
});

function state(p: Record<string, unknown> = {}) {
  return { isPlaying: true, index: 0, trackId: 'A', positionMs: 0, durationMs: 1000, shuffle: false, repeat: 'off', context: null, seedId: 'A', ...p };
}

const emit = (ev: string, e: unknown) => fake.listeners.get(ev)!(e);
const flush = () => new Promise((r) => setTimeout(r, 0));
const rows = (p: InstanceType<typeof NativePlayer>) => p.state.value.upNext.map((u) => [u.track.id, u.index]);

beforeEach(() => {
  fake.listeners.clear();
  fake.order.length = 0;
  vi.clearAllMocks();
  fake.plugin.getState.mockImplementation(() => new Promise(() => {}));
  lib.liked.value = [];
  lib.history.value = [];
  (catalog.all as Signal<Track[]>).value = [];
  toasts.value = [];
});

describe('NativePlayer: Up next rows (K1)', () => {
  it('maps rows by the list index native sends, so a queued copy of a played track is that copy', async () => {
    const p = new NativePlayer();
    emit('state', state({ index: 2, trackId: 'C', queueIds: ['A', 'B', 'C', 'A', 'D'], upNextIds: ['A', 'D'], upNextKinds: 'ql', upNextIndex: [3, 4] }));
    expect(rows(p)).toEqual([
      ['A', 3],
      ['D', 4],
    ]);
    await p.remove(3, 'A');
    expect(fake.plugin.removeItem).toHaveBeenCalledWith({ index: 3, expectId: 'A' });
  });

  it('the played tracks come by list index, oldest first; an older native sends none', () => {
    const p = new NativePlayer();
    emit('state', state({ index: 2, trackId: 'C', queueIds: ['A', 'B', 'C', 'D'], upNextIds: ['D'], upNextKinds: 'l', upNextIndex: [3], prevIndex: [1, 0] }));
    expect(p.state.peek().previous.map((u) => [u.track.id, u.index])).toEqual([
      ['B', 1],
      ['A', 0],
    ]);
    emit('state', state({ index: 2, trackId: 'C', queueIds: ['A', 'B', 'C', 'D'], upNextIds: ['D'], upNextKinds: 'l', upNextIndex: [3] }));
    expect(p.state.peek().previous).toEqual([]);
  });

  it('without indices (an older native), looks after the current track first, then from the top', () => {
    const p = new NativePlayer();
    emit('state', state({ index: 2, trackId: 'C', queueIds: ['A', 'B', 'C', 'A', 'D'], upNextIds: ['A', 'D'], upNextKinds: 'ql' }));
    expect(rows(p)).toEqual([
      ['A', 3],
      ['D', 4],
    ]);
    // Repeat all: the wrap-around rows are before the current one.
    emit('state', state({ index: 1, trackId: 'B', queueIds: ['A', 'B'], upNextIds: ['A'], upNextKinds: 'l', repeat: 'all' }));
    expect(rows(p)).toEqual([['A', 0]]);
  });
});

describe('NativePlayer: after the WebView is recreated (K4)', () => {
  it('listens for tracks before state', () => {
    new NativePlayer();
    expect(fake.order.indexOf('tracks')).toBeLessThan(fake.order.indexOf('state'));
  });

  it('names tracks from the catalog, and again once Liked or the catalog loads', () => {
    const p = new NativePlayer();
    const st = (pos: number, more: Record<string, unknown> = {}) => state({ positionMs: pos, queueIds: ['A', 'B', 'C'], upNextIds: ['B', 'C'], upNextKinds: 'll', upNextIndex: [1, 2], ...more });
    emit('state', st(0));
    expect(p.state.value.current?.title).toBe('Unknown track');
    lib.liked.value = [tr('A')];
    expect(p.state.value.current?.title).toBe('Title A');
    expect(p.state.value.current?.ytId).toBe(tr('A').ytId);
    (catalog.all as Signal<Track[]>).value = [tr('B'), tr('C')];
    expect(p.state.value.upNext.map((u) => u.track.title)).toEqual(['Title B', 'Title C']);
    // Later ticks keep them.
    emit('state', st(1000, { queueIds: undefined, queueIdsUnchanged: true }));
    expect(p.state.value.upNext[1].track.title).toBe('Title C');
  });

  it('names Signal Radio tracks from the bundled stations, seed included', async () => {
    const { STATIONS, stationTracks } = await import('./radio');
    const [a, b] = stationTracks(STATIONS[0]);
    const p = new NativePlayer();
    emit('state', state({ trackId: a.id, seedId: a.id, queueIds: [a.id, b.id, 'sig:nowhere:abcdefghijk'], upNextIds: [b.id, 'sig:nowhere:abcdefghijk'], upNextKinds: 'la', upNextIndex: [1, 2] }));
    expect(p.state.value.current).toBe(a);
    expect(p.state.value.current?.source).toBe('signal');
    expect(p.state.value.seed).toBe(a);
    expect(p.state.value.upNext.map((u) => u.track.title)).toEqual([b.title, 'Unknown track']);
  });
});

describe('NativePlayer: a session native restored after a restart', () => {
  it('names a track nothing else knows from what native describes, members-only kept; the catalog still wins', () => {
    const p = new NativePlayer();
    emit('tracks', {
      tracks: [
        { id: 'M', ytId: tr('M').ytId, title: 'Members', artist: 'Y', artworkUrl: '', by: 'poster', postUrl: 'https://cyberspace.online/post/1', membersOnly: true },
        { id: 'B', ytId: tr('B').ytId, title: 'Old title', artist: 'Y', artworkUrl: '' },
      ],
    });
    // Every track known (only from native): the catalog loading still names them in full.
    emit('state', state({ trackId: 'M', queueIds: ['M', 'B'], upNextIds: ['B'], upNextKinds: 'l', upNextIndex: [1] }));
    const m = p.state.value.current!;
    expect([m.title, m.by, m.membersOnly]).toEqual(['Members', 'poster', true]);
    expect(p.state.value.upNext[0].track.title).toBe('Old title');
    (catalog.all as Signal<Track[]>).value = [tr('B')];
    expect(p.state.value.upNext[0].track.title).toBe('Title B');
  });

  it("keeps a restored track's album (a string only), so the same-album rule survives a restart", () => {
    const p = new NativePlayer();
    emit('tracks', {
      tracks: [
        { id: 'M', ytId: tr('M').ytId, title: 'One', artist: 'Y', artworkUrl: '', album: 'Blue Lines' },
        { id: 'B', ytId: tr('B').ytId, title: 'Two', artist: 'Y', artworkUrl: '', album: 7 },
        { id: 'C', ytId: tr('C').ytId, title: 'Three', artist: 'Y', artworkUrl: '' },
      ],
    });
    emit('state', state({ trackId: 'M', queueIds: ['M', 'B', 'C'], upNextIds: ['B', 'C'], upNextKinds: 'll', upNextIndex: [1, 2] }));
    expect(p.state.value.current?.album).toBe('Blue Lines');
    expect(p.state.value.upNext.map((u) => 'album' in u.track)).toEqual([false, false]);
  });

  const MP3 = 'https://latex.gg/share/IZq8cMcx.mp3';
  const COVER = 'https://bunker.cyberspace.online/uploads/jukebox/u/1.jpg';

  it('sends a Jukebox MP3 to native with its link (no video id), and plays a list that has one', async () => {
    const m = tr('M', { ytId: '', mp3: MP3, artworkUrl: COVER });
    expect(toNative(m)).toMatchObject({ id: 'M', ytId: '', mp3: MP3, artworkUrl: COVER });
    expect('mp3' in toNative(tr('A'))).toBe(false);
    const p = new NativePlayer();
    await p.playList([tr('A'), m], 1, { label: 'Liked', mode: 'list' });
    const call = fake.plugin.setQueue.mock.calls[0][0];
    expect(call.tracks.map((t: { id: string; mp3?: string }) => [t.id, t.mp3])).toEqual([
      ['A', undefined],
      ['M', MP3],
    ]);
    expect(call.startIndex).toBe(1);
  });

  it('names a restored MP3 from what native describes, with its cover; a bad link or cover is dropped', () => {
    const p = new NativePlayer();
    emit('tracks', {
      tracks: [
        { id: 'M', ytId: '', mp3: MP3, title: 'Träume', artist: 'Mephisztoe', artworkUrl: COVER },
        { id: 'N', ytId: '', mp3: MP3, title: 'Cover gone', artist: 'Y', artworkUrl: 'https://evil.example/x.jpg' },
        { id: 'X', ytId: '', mp3: 'https://evil.example/x.mp3', title: 'Bad', artist: 'Y', artworkUrl: '' },
      ],
    });
    emit('state', state({ trackId: 'M', queueIds: ['M', 'N', 'X'], upNextIds: ['N', 'X'], upNextKinds: 'll', upNextIndex: [1, 2] }));
    expect(p.state.value.current).toMatchObject({ id: 'M', ytId: '', mp3: MP3, title: 'Träume', artworkUrl: COVER });
    const [n, x] = p.state.value.upNext.map((u) => u.track);
    expect([n.mp3, n.artworkUrl]).toEqual([MP3, '']);
    expect([x.title, x.mp3]).toEqual(['Unknown track', undefined]);
  });

  it('sends members-only to native, so a restored session still knows it', () => {
    expect(toNative(tr('M', { membersOnly: true })).membersOnly).toBe(true);
    expect('membersOnly' in toNative(tr('A'))).toBe(false);
  });

  it("sends an album track's album to native (clipped like the other text), none otherwise", () => {
    expect(toNative(tr('M', { album: 'Blue Lines' })).album).toBe('Blue Lines');
    expect(toNative(tr('M', { album: 'x'.repeat(BRIDGE_MAX_STRING + 1) })).album).toHaveLength(BRIDGE_MAX_STRING);
    expect('album' in toNative(tr('A'))).toBe(false);
  });
});

describe('NativePlayer: play/pause', () => {
  it('a quick second tap undoes the first, before native has answered', async () => {
    const p = new NativePlayer();
    emit('state', state({ isPlaying: true, queueIds: ['A'], upNextIds: [], upNextKinds: '' }));
    await p.toggle();
    expect(p.state.value.isPlaying).toBe(false);
    await p.toggle();
    expect(fake.plugin.pause).toHaveBeenCalledTimes(1);
    expect(fake.plugin.play).toHaveBeenCalledTimes(1);
    expect(p.state.value.isPlaying).toBe(true);
  });

  it('shows the wait for the network while native says so, until the user takes over', async () => {
    const p = new NativePlayer();
    emit('state', state({ isPlaying: false, queueIds: ['A'], upNextIds: [], upNextKinds: '', waitingForNetwork: true }));
    expect(p.state.value.waitingForNetwork).toBe(true);
    emit('state', state({ isPlaying: false, queueIds: ['A'], upNextIds: [], upNextKinds: '' }));
    expect(p.state.value.waitingForNetwork).toBe(false);
    emit('state', state({ isPlaying: false, queueIds: ['A'], upNextIds: [], upNextKinds: '', waitingForNetwork: true }));
    await p.toggle();
    expect(p.state.value.waitingForNetwork).toBe(false);
  });

  it('during the wait for the network, the button pauses: the resume is called off, nothing starts', async () => {
    const p = new NativePlayer();
    emit('state', state({ isPlaying: false, queueIds: ['A'], upNextIds: [], upNextKinds: '', waitingForNetwork: true }));
    await p.toggle();
    expect(fake.plugin.pause).toHaveBeenCalledTimes(1);
    expect(fake.plugin.play).not.toHaveBeenCalled();
    expect(p.state.value).toMatchObject({ isPlaying: false, waitingForNetwork: false });
  });

  it('keeps how much audio native has loaded ahead (none from an older native, none for a list just started)', async () => {
    const p = new NativePlayer();
    emit('state', state({ isPlaying: false, queueIds: ['A'], upNextIds: [], upNextKinds: '', bufferedAheadMs: 30_000 }));
    expect(p.state.value.bufferedAheadMs).toBe(30_000);
    emit('state', state({ isPlaying: false, queueIds: ['A'], upNextIds: [], upNextKinds: '' }));
    expect(p.state.value.bufferedAheadMs).toBe(0);
    emit('state', state({ isPlaying: false, queueIds: ['A'], upNextIds: [], upNextKinds: '', bufferedAheadMs: 30_000 }));
    await p.playList([tr('B')], 0);
    expect(p.state.value.bufferedAheadMs).toBe(0);
  });
});

describe('NativePlayer: shuffle and repeat', () => {
  it('show at once, and a state event sent before native took them does not undo them', async () => {
    const p = new NativePlayer();
    emit('state', state({ queueIds: ['A'], upNextIds: [], upNextKinds: '' }));
    let answer: () => void = () => {};
    fake.plugin.setShuffle.mockImplementationOnce(() => new Promise<void>((r) => (answer = r)));
    const done = p.setShuffle(true);
    expect(p.state.value.shuffle).toBe(true);
    void p.setRepeat('all');
    expect(p.state.value.repeat).toBe('all');
    // A tick from before: shuffle off, repeat off.
    emit('state', state({ queueIds: ['A'], upNextIds: [], upNextKinds: '' }));
    expect(p.state.value.shuffle).toBe(true);
    expect(p.state.value.repeat).toBe('all');
    fake.plugin.getState.mockResolvedValueOnce(state({ queueIds: ['A'], upNextIds: [], upNextKinds: '', shuffle: true, repeat: 'all' }));
    answer();
    await done;
    await flush();
    expect(fake.plugin.getState).toHaveBeenCalled();
    expect(p.state.value.shuffle).toBe(true);
  });
});

describe('NativePlayer: edits (K2)', () => {
  const list = (p: InstanceType<typeof NativePlayer>) => {
    void p;
    emit('state', state({ queueIds: ['A', 'B', 'C', 'D'], upNextIds: ['B', 'C', 'D'], upNextKinds: 'lll', upNextIndex: [1, 2, 3] }));
  };

  it('a move shows at once, so a second quick tap uses the new indices', async () => {
    const p = new NativePlayer();
    list(p);
    const tap = () => {
      const k = p.state.value.upNext.findIndex((u) => u.track.id === 'D');
      const it = p.state.value.upNext[k];
      return p.move(it.index, p.state.value.upNext[k - 1].index, it.track.id);
    };
    await Promise.all([tap(), tap()]);
    expect(fake.plugin.moveItem.mock.calls).toEqual([[{ from: 3, to: 2, expectId: 'D' }], [{ from: 2, to: 1, expectId: 'D' }]]);
    expect(rows(p)).toEqual([
      ['D', 1],
      ['B', 2],
      ['C', 3],
    ]);
  });

  it('state events from before an edit is answered are held back, then the state is fetched', async () => {
    const p = new NativePlayer();
    list(p);
    let answer: () => void = () => {};
    fake.plugin.removeItem.mockImplementationOnce(() => new Promise<void>((r) => (answer = r)));
    const done = p.remove(1, 'B');
    expect(rows(p).map((r) => r[0])).toEqual(['C', 'D']);
    // Sent before native took the remove: ignored.
    list(p);
    expect(rows(p).map((r) => r[0])).toEqual(['C', 'D']);
    const fresh = state({ queueIds: ['A', 'C', 'D'], upNextIds: ['C', 'D'], upNextKinds: 'll', upNextIndex: [1, 2] });
    fake.plugin.getState.mockResolvedValueOnce(fresh);
    answer();
    await done;
    await flush();
    expect(fake.plugin.getState).toHaveBeenCalled();
    expect(rows(p)).toEqual([
      ['C', 1],
      ['D', 2],
    ]);
  });

  it('a stale index is no error: nothing to toast, the state is fetched again', async () => {
    const p = new NativePlayer();
    list(p);
    fake.plugin.skipToIndex.mockRejectedValueOnce(Object.assign(new Error('STALE_INDEX'), { code: 'STALE_INDEX' }));
    await expect(p.skipTo(2, 'C')).resolves.toBeUndefined();
    expect(fake.plugin.skipToIndex).toHaveBeenCalledWith({ index: 2, expectId: 'C' });
    expect(fake.plugin.getState).toHaveBeenCalled();
    fake.plugin.moveItem.mockRejectedValueOnce(new Error('service gone'));
    await expect(p.move(2, 1, 'C')).rejects.toThrow('service gone');
  });

  it('restore sends the track, its section and the track it goes before (K3)', async () => {
    const p = new NativePlayer();
    list(p);
    await p.restore(tr('Z'), 'list', 'C');
    expect(fake.plugin.restore).toHaveBeenCalledWith({ track: toNative(tr('Z')), kind: 'list', beforeId: 'C' });
  });

  it('removeIds sends at most BRIDGE_MAX_ITEMS ids a call (K5, K6)', async () => {
    const p = new NativePlayer();
    const ids = Array.from({ length: BRIDGE_MAX_ITEMS + 5 }, (_, i) => `m${i}`);
    await p.removeIds([...ids, 'm0']);
    expect(fake.plugin.removeIds.mock.calls.map(([o]) => o.ids.length)).toEqual([BRIDGE_MAX_ITEMS, 5]);
  });
});

describe('NativePlayer: starting a list', () => {
  it('starts at the tapped track, or the next one that plays, not the first', async () => {
    const p = new NativePlayer();
    const all = [tr('A'), tr('B'), tr('bad', { ytId: 'nope' }), tr('D'), tr('E')];
    await p.playList(all, 2, { label: 'Liked', mode: 'list' });
    const call = fake.plugin.setQueue.mock.calls[0][0];
    expect(call.tracks.map((t: { id: string }) => t.id)).toEqual(['A', 'B', 'D', 'E']);
    expect(call.startIndex).toBe(2);
    expect(p.state.value.current?.id).toBe('D');
    // Nothing playable from there on: nothing starts.
    await p.playList([tr('A'), tr('bad', { ytId: 'nope' })], 1, { label: 'Liked', mode: 'list' });
    expect(fake.plugin.setQueue).toHaveBeenCalledTimes(1);
    expect(toasts.value.map((t) => t.text)).toContain("Can't play this track");
  });

  it('when native skips the start track, its events are trusted again at once', async () => {
    const p = new NativePlayer();
    await p.playList([tr('A'), tr('B')], 0, { label: '', mode: 'list' });
    emit('state', state({ index: 1, trackId: 'B', queueIds: ['A', 'B'], upNextIds: [], upNextKinds: '' }));
    expect(p.state.value.current?.id).toBe('A'); // waiting for A
    emit('trackError', { trackId: 'A', message: 'gone', skipped: true });
    emit('state', state({ index: 1, trackId: 'B', queueIds: ['A', 'B'], upNextIds: [], upNextKinds: '', positionMs: 10 }));
    expect(p.state.value.current?.id).toBe('B');
  });

  it('says why a track stopped: a lost signal that picks up by itself, one that waits for Play, or the track itself', async () => {
    const p = new NativePlayer();
    await p.playList([tr('A'), tr('B')], 0, { label: '', mode: 'list' });
    const said = (e: Record<string, unknown>) => {
      emit('trackError', { trackId: 'A', message: 'IO_NETWORK_CONNECTION_FAILED', ...e });
      return toasts.value.at(-1)?.text;
    };
    expect(said({ skipped: false, kind: 'network', resumes: true })).toBe('Signal lost. "Title A" picks up when you\'re back.');
    expect(said({ skipped: false, kind: 'network', resumes: false })).toBe("Signal lost. Press play once you're back online.");
    expect(said({ skipped: false, kind: 'track', resumes: false })).toBe('Can\'t play "Title A"');
    expect(said({ skipped: true, kind: 'track', resumes: false })).toBe('Skipped "Title A": unavailable');
    // An older native without the fields: about the track, as before.
    expect(said({ skipped: false })).toBe('Can\'t play "Title A"');
    expect(said({ skipped: true })).toBe('Skipped "Title A": unavailable');
  });

  it(`sends at most ${BRIDGE_MAX_ITEMS} tracks, around the start one, and no string longer than native takes (K6)`, async () => {
    const p = new NativePlayer();
    const all = Array.from({ length: BRIDGE_MAX_ITEMS + 500 }, (_, i) => tr(`t${i}`));
    await p.playList(all, BRIDGE_MAX_ITEMS + 400, { label: '', mode: 'list' });
    const call = fake.plugin.setQueue.mock.calls[0][0];
    expect(call.tracks).toHaveLength(BRIDGE_MAX_ITEMS);
    expect(call.tracks[call.startIndex].id).toBe(`t${BRIDGE_MAX_ITEMS + 400}`);
    expect(bridgeWindow([1, 2, 3], 1)).toEqual({ items: [1, 2, 3], start: 1 });
    const long = toNative(tr('L', { title: 'x'.repeat(BRIDGE_MAX_STRING + 1), postUrl: 'https://' + 'y'.repeat(BRIDGE_MAX_STRING) }));
    expect(long.title).toHaveLength(BRIDGE_MAX_STRING);
    expect(long.postUrl).toBe('');
  });
});

describe('NativePlayer: running low', () => {
  it('a listener added after the signal (autoplay starts late on a reloaded page) still hears it', async () => {
    const p = new NativePlayer();
    emit('queueLow', { left: 2, seedId: 'A' });
    const heard: unknown[] = [];
    p.onQueueLow((e) => heard.push(e));
    await flush();
    expect(heard).toEqual([{ left: 2, seedId: 'A' }]);
  });
});

describe('NativePlayer: the current track from autoplay', () => {
  it('follows native, and is false from an older native that does not say', () => {
    const p = new NativePlayer();
    emit('state', state({ index: 1, trackId: 'B', queueIds: ['A', 'B'], upNextIds: [], upNextKinds: '', upNextIndex: [], currentAuto: true }));
    expect(p.state.value.currentAuto).toBe(true);
    emit('state', state({ index: 1, trackId: 'B', queueIds: ['A', 'B'], upNextIds: [], upNextKinds: '', upNextIndex: [] }));
    expect(p.state.value.currentAuto).toBe(false);
  });
});
