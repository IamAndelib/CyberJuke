import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';
import { LIKED_LABEL } from '../stores/savedOffline';
import { offlineGuard } from './offlineGuard';
import { EMPTY_STATE, type Player, type PlayerState } from './types';

/** A player whose every command is a mock, and a guard that is online until told otherwise. */
function setup(state: Partial<PlayerState> = {}, saved: string[] = []) {
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
    setNetworkPrefs: cmd(),
    retryNow: cmd(),
  } satisfies Player;
  let up = true;
  const refused = vi.fn();
  const p = offlineGuard(inner, { online: () => up, saved: () => new Set(saved), refuse: refused });
  return { inner, p, refused, offline: () => (up = false) };
}

const t = (id: string): Track => ({ id, ytId: `${id}`.padEnd(11, '0') }) as Track;
const track = t('a');
const LIKED = { label: LIKED_LABEL, mode: 'list' as const };
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

  it('offline with nothing saved, refuses whatever would start playback, once per tap, and the player never hears of it', async () => {
    const { inner, p, refused, offline } = setup();
    offline();
    await p.playList([track], 0);
    await p.play();
    await p.toggle(); // paused: a resume
    await p.next();
    await p.prev();
    await p.skipTo(1, 'b');
    for (const c of [inner.playList, inner.play, inner.toggle, inner.next, inner.prev, inner.skipTo]) expect(c).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledTimes(6);
    expect(refused.mock.calls.every(([why]) => why === 'offline')).toBe(true);
  });

  it('offline, pausing, seeking, queue edits and settings still work', async () => {
    const { inner, p, refused, offline } = setup({ isPlaying: true });
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
    for (const c of [inner.toggle, inner.pause, inner.seek, inner.move, inner.remove, inner.addToQueue, inner.setShuffle, inner.setRepeat, inner.setQuality]) {
      expect(c).toHaveBeenCalledTimes(1);
    }
    expect(refused).not.toHaveBeenCalled();
    expect(p.state).toBe(inner.state);
  });

  it('offline, a list from Liked plays only its saved songs, from the tapped one', async () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(t);
    const { inner, p, refused, offline } = setup({}, [a.ytId, c.ytId, d.ytId]);
    offline();
    await p.playList([a, b, c, d], 2, LIKED);
    expect(inner.playList).toHaveBeenCalledWith([a, c, d], 1, LIKED);
    expect(refused).not.toHaveBeenCalled();
  });

  it('offline, an unsaved liked song says it isn’t saved; the same list elsewhere is refused', async () => {
    const [a, b] = ['a', 'b'].map(t);
    const { inner, p, refused, offline } = setup({}, [a.ytId]);
    offline();
    await p.playList([a, b], 1, LIKED);
    expect(refused).toHaveBeenLastCalledWith('unsaved');
    // Saved, but started from somewhere other than Liked (Recently played, Home): refused.
    await p.playList([a, b], 0, HOME);
    expect(refused).toHaveBeenLastCalledWith('offline');
    await p.playList([a, b], 0);
    expect(refused).toHaveBeenLastCalledWith('offline');
    expect(inner.playList).not.toHaveBeenCalled();
  });

  it('offline, Play, Next, Previous and Up next go only onto a saved song', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(t);
    const state: Partial<PlayerState> = { queue: [a, b, c], index: 0, current: a, upNext: [{ track: b, index: 1 }, { track: c, index: 2 }] };
    const { inner, p, refused, offline } = setup(state, [a.ytId, c.ytId]);
    offline();
    await p.play();
    await p.toggle();
    await p.prev();
    await p.skipTo(2, c.id);
    expect(inner.play).toHaveBeenCalledTimes(1);
    expect(inner.toggle).toHaveBeenCalledTimes(1);
    expect(inner.prev).toHaveBeenCalledTimes(1);
    expect(inner.skipTo).toHaveBeenCalledWith(2, c.id);
    // The next one (b) isn't saved, nor is b in Up next.
    await p.next();
    await p.skipTo(1, b.id);
    expect(inner.next).not.toHaveBeenCalled();
    expect(inner.skipTo).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledTimes(2);
  });
});
