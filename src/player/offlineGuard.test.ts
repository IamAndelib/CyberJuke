import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';
import { offlineGuard, playsOffline } from './offlineGuard';
import { EMPTY_STATE, type Player, type PlayerState } from './types';

/** A player whose every command is a mock, and a guard that is online until told otherwise. */
function setup(state: Partial<PlayerState> = {}, saved: string[] = [], liked: string[] = []) {
  const cmd = () => vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
  const inner = {
    kind: 'web',
    state: signal<PlayerState>({ ...EMPTY_STATE, ...state }),
    onQueueLow: () => () => {},
    netStatus: () => Promise.resolve(null),
    playList: cmd(),
    play: cmd(),
    pause: cmd(),
    toggle: cmd(),
    next: cmd(),
    prev: cmd(),
    seek: cmd(),
    skipTo: cmd(),
    setShuffle: cmd(),
    setRepeat: cmd(),
    move: cmd(),
    remove: cmd(),
    removeIds: cmd(),
    addToQueue: cmd(),
    restore: cmd(),
    addAutoplay: cmd(),
    setAutoplay: cmd(),
    setQuality: cmd(),
    setCrossfade: cmd(),
    setGapless: cmd(),
    setNetworkPrefs: cmd(),
    retryNow: cmd(),
  } satisfies Player;
  let up = true;
  const refused = vi.fn();
  const p = offlineGuard(inner, { online: () => up, saved: () => new Set(saved), liked: (t) => liked.includes(t.id), refuse: refused });
  return { inner, p, refused, offline: () => (up = false) };
}

const t = (id: string): Track => ({ id, ytId: `${id}`.padEnd(11, '0') }) as Track;
const track = t('a');
const LIKED = { label: 'Liked', mode: 'list' as const };
const RECENT = { label: 'Recently played', mode: 'list' as const };
const HOME = { label: 'Home · Latest', mode: 'radio' as const };

describe('offlineGuard', () => {
  it('passes every command through while online', async () => {
    const { inner, p, refused } = setup();
    await p.playList([track], 0);
    await p.play();
    await p.toggle();
    await p.next();
    await p.prev();
    await p.skipTo(1, 'b');
    expect(inner.playList).toHaveBeenCalledWith([track], 0, undefined);
    expect(inner.skipTo).toHaveBeenCalledWith(1, 'b');
    for (const c of [inner.play, inner.toggle, inner.next, inner.prev]) expect(c).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it('offline with nothing saved, refuses whatever would start something new, once per tap, and the player never hears of it', async () => {
    const { inner, p, refused, offline } = setup({ queue: [track], current: track, upNext: [{ track, index: 1 }] });
    offline();
    await p.playList([track], 0);
    await p.next();
    await p.prev();
    await p.skipTo(1, 'b');
    for (const c of [inner.playList, inner.next, inner.prev, inner.skipTo]) expect(c).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledTimes(4);
    expect(refused.mock.calls.every(([why]) => why === 'offline')).toBe(true);
  });

  it('offline, a paused track with audio loaded ahead resumes, saved or not: native plays what it has', async () => {
    const { inner, p, refused, offline } = setup({ queue: [track], current: track, isPlaying: false, bufferedAheadMs: 20_000 });
    offline();
    await p.play();
    await p.toggle(); // paused: a resume
    expect(inner.play).toHaveBeenCalledTimes(1);
    expect(inner.toggle).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it('offline, a saved current track resumes with nothing loaded yet: it plays from the phone', async () => {
    const { inner, p, refused, offline } = setup({ queue: [track], current: track, isPlaying: false, bufferedAheadMs: 0 }, [track.ytId], [track.id]);
    offline();
    await p.play();
    await p.toggle();
    expect(inner.play).toHaveBeenCalledTimes(1);
    expect(inner.toggle).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it('offline, a saved Jukebox MP3 plays and an unsaved one is refused', async () => {
    const saved = { id: 'p1', ytId: '', mp3: 'https://latex.gg/share/IZq8cMcx.mp3' } as Track;
    const unsaved = { id: 'p2', ytId: '', mp3: 'https://latex.gg/share/FEHdI7AK.mp3' } as Track;
    const { inner, p, refused, offline } = setup({ queue: [saved], current: saved, isPlaying: false, bufferedAheadMs: 0 }, ['mp3:IZq8cMcx.mp3'], ['p1', 'p2']);
    offline();
    await p.play();
    expect(inner.play).toHaveBeenCalledTimes(1);
    await p.playList([unsaved, saved], 1);
    expect(inner.playList).toHaveBeenCalledWith([saved], 0, undefined);
    await p.playList([unsaved, saved], 0);
    expect(inner.playList).toHaveBeenCalledTimes(1);
    expect(refused.mock.calls).toEqual([['unsaved']]);
  });

  it('offline, a track the app reopened on, not saved and with nothing loaded, is refused like its row', async () => {
    // Liked but not saved yet: says so.
    const liked = setup({ queue: [track], current: track, isPlaying: false, bufferedAheadMs: 0 }, [], [track.id]);
    liked.offline();
    await liked.p.play();
    await liked.p.toggle();
    expect(liked.inner.play).not.toHaveBeenCalled();
    expect(liked.inner.toggle).not.toHaveBeenCalled();
    expect(liked.refused.mock.calls).toEqual([['unsaved'], ['unsaved']]);
    // Anything else needs a connection.
    const other = setup({ queue: [track], current: track, isPlaying: false });
    other.offline();
    await other.p.play();
    await other.p.toggle();
    expect(other.inner.play).not.toHaveBeenCalled();
    expect(other.inner.toggle).not.toHaveBeenCalled();
    expect(other.refused.mock.calls).toEqual([['offline'], ['offline']]);
    // Online it plays (and loads).
    const online = setup({ queue: [track], current: track, isPlaying: false });
    await online.p.play();
    expect(online.inner.play).toHaveBeenCalledTimes(1);
  });

  it('the current track plays offline when it is saved, has audio loaded ahead, or is playing', () => {
    const s = (p: Partial<PlayerState>) => ({ ...EMPTY_STATE, current: track, ...p });
    const saved = new Set([track.ytId]);
    expect(playsOffline(s({}), new Set())).toBe(false);
    expect(playsOffline(s({}), saved)).toBe(true);
    expect(playsOffline(s({ bufferedAheadMs: 1 }), new Set())).toBe(true);
    expect(playsOffline(s({ isPlaying: true }), new Set())).toBe(true);
    expect(playsOffline(s({ current: null }), saved)).toBe(false);
  });

  it('offline, the button pauses during the wait for the network: never refused', async () => {
    const { inner, p, refused, offline } = setup({ queue: [track], current: track, isPlaying: false, waitingForNetwork: true });
    offline();
    await p.toggle();
    expect(inner.toggle).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it('offline, pausing, seeking, queue edits and settings still work', async () => {
    const { inner, p, refused, offline } = setup({ queue: [track], index: 0, current: track, isPlaying: true });
    offline();
    await p.toggle(); // playing: a pause
    await p.pause();
    await p.seek(1000);
    await p.move(1, 2, 'b');
    await p.remove(1, 'b');
    await p.addToQueue([track]);
    await p.setShuffle(true);
    await p.setRepeat('all');
    await p.setQuality('low');
    await p.setCrossfade(6000);
    await p.setGapless(false);
    for (const c of [inner.toggle, inner.pause, inner.seek, inner.move, inner.remove, inner.addToQueue, inner.setShuffle, inner.setRepeat, inner.setQuality, inner.setCrossfade, inner.setGapless]) {
      expect(c).toHaveBeenCalledTimes(1);
    }
    expect(refused).not.toHaveBeenCalled();
    expect(p.state).toBe(inner.state);
  });

  it('offline, a list from anywhere plays only its saved songs, from the tapped one', async () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(t);
    for (const ctx of [LIKED, RECENT, HOME, undefined]) {
      const { inner, p, refused, offline } = setup({}, [a.ytId, c.ytId, d.ytId]);
      offline();
      await p.playList([a, b, c, d], 2, ctx);
      expect(inner.playList).toHaveBeenCalledWith([a, c, d], 1, ctx);
      expect(refused).not.toHaveBeenCalled();
    }
  });

  it('offline, an unsaved liked song says it isn’t saved yet; any other unsaved song needs a connection', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(t);
    const { inner, p, refused, offline } = setup({}, [a.ytId], [a.id, b.id]);
    offline();
    for (const ctx of [LIKED, RECENT, HOME]) {
      await p.playList([a, b, c], 1, ctx);
      expect(refused).toHaveBeenLastCalledWith('unsaved');
      await p.playList([a, b, c], 2, ctx);
      expect(refused).toHaveBeenLastCalledWith('offline');
    }
    await p.playList([a, b], 5);
    expect(refused).toHaveBeenLastCalledWith('offline');
    expect(inner.playList).not.toHaveBeenCalled();
  });

  it('offline with nothing loaded, Add to queue and Undo start a list: its saved songs only', async () => {
    const [a, b] = ['a', 'b'].map(t);
    const { inner, p, refused, offline } = setup({}, [b.ytId]);
    offline();
    await p.addToQueue([a]);
    await p.restore(a, 'queued', null);
    expect(refused).toHaveBeenCalledTimes(2);
    expect(refused).toHaveBeenLastCalledWith('offline');
    // Saved, it plays (the saved songs of what was added, from the first).
    await p.addToQueue([b, a]);
    expect(inner.playList).toHaveBeenCalledWith([b], 0, undefined);
    expect(inner.addToQueue).not.toHaveBeenCalled();
    expect(inner.restore).not.toHaveBeenCalled();
  });

  it('offline, Next, Previous and Up next go only onto a saved song', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(t);
    const state: Partial<PlayerState> = { queue: [a, b, c], index: 0, current: a, upNext: [{ track: b, index: 1 }, { track: c, index: 2 }] };
    const { inner, p, refused, offline } = setup(state, [a.ytId, c.ytId]);
    offline();
    await p.prev();
    await p.skipTo(2, c.id);
    expect(inner.prev).toHaveBeenCalledTimes(1);
    expect(inner.skipTo).toHaveBeenCalledWith(2, c.id);
    // b isn't saved: a tap on it is refused.
    await p.skipTo(1, b.id);
    expect(inner.skipTo).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('offline, Next goes on when a saved song is anywhere ahead: native skips the unsaved ones', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(t);
    const { inner, p, refused, offline } = setup({ queue: [a, b, c], index: 0, current: a, upNext: [{ track: b, index: 1 }, { track: c, index: 2 }] }, [c.ytId]);
    offline();
    await p.next();
    expect(inner.next).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it('offline with Repeat all, Next at the last song goes round to a saved one before it', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(t);
    const { inner, p, refused, offline } = setup({ queue: [a, b, c], index: 2, current: c, repeat: 'all', upNext: [] }, [a.ytId]);
    offline();
    await p.next();
    expect(inner.next).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it('offline with no saved song ahead, Next is refused: "unsaved" when the next one is liked', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(t);
    const state: Partial<PlayerState> = { queue: [a, b, c], index: 0, current: a, upNext: [{ track: b, index: 1 }, { track: c, index: 2 }] };
    const { inner, p, refused, offline } = setup(state, [a.ytId], [b.id]);
    offline();
    await p.next();
    expect(inner.next).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledWith('unsaved');
    const other = setup(state, [a.ytId]);
    other.offline();
    await other.p.next();
    expect(other.refused).toHaveBeenCalledWith('offline');
  });

  it('offline, Previous checks the song it lands on: the one before in the first 3 s, else this one again', async () => {
    const [a, b] = ['a', 'b'].map(t);
    const state: Partial<PlayerState> = { queue: [a, b], index: 1, current: b, previous: [{ track: a, index: 0 }], upNext: [] };
    const early = setup({ ...state, positionMs: 1000 }, [b.ytId]);
    early.offline();
    await early.p.prev();
    expect(early.inner.prev).not.toHaveBeenCalled();
    expect(early.refused).toHaveBeenCalledWith('offline');
    const late = setup({ ...state, positionMs: 5000 }, [b.ytId]);
    late.offline();
    await late.p.prev();
    expect(late.inner.prev).toHaveBeenCalledTimes(1);
    const back = setup({ ...state, positionMs: 1000 }, [a.ytId]);
    back.offline();
    await back.p.prev();
    expect(back.inner.prev).toHaveBeenCalledTimes(1);
  });

  it('offline, Previous checks the song before in the list even when it was never heard (a list started midway)', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(t);
    // Started on b: nothing heard before it, yet the player's Previous goes to a.
    const state: Partial<PlayerState> = { queue: [a, b, c], index: 1, current: b, previous: [], upNext: [{ track: c, index: 2 }], positionMs: 500 };
    const midway = setup(state, [b.ytId]);
    midway.offline();
    await midway.p.prev();
    expect(midway.inner.prev).not.toHaveBeenCalled();
    expect(midway.refused).toHaveBeenCalledWith('offline');
    // Repeat all at the first song: Previous goes round to the last one.
    const first = { ...state, index: 0, current: a, upNext: [{ track: b, index: 1 }, { track: c, index: 2 }], repeat: 'all' as const };
    const round = setup(first, [a.ytId]);
    round.offline();
    await round.p.prev();
    expect(round.inner.prev).not.toHaveBeenCalled();
    const roundSaved = setup(first, [a.ytId, c.ytId]);
    roundSaved.offline();
    await roundSaved.p.prev();
    expect(roundSaved.inner.prev).toHaveBeenCalledTimes(1);
    // Repeat off at the first song: Previous restarts it.
    const start = setup({ ...first, repeat: 'off' }, [a.ytId]);
    start.offline();
    await start.p.prev();
    expect(start.inner.prev).toHaveBeenCalledTimes(1);
  });
});
