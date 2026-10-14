import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';
import { offlineGuard } from './offlineGuard';
import { EMPTY_STATE, type Player, type PlayerState } from './types';

/** A player whose every command is a mock, and a guard that is online until told otherwise. */
function setup(state: Partial<PlayerState> = {}) {
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
  const p = offlineGuard(inner, () => {
    if (up) return true;
    refused();
    return false;
  });
  return { inner, p, refused, offline: () => (up = false) };
}

const track = { id: 'a', ytId: 'aaaaaaaaaaa' } as Track;

describe('offlineGuard', () => {
  it('passes every command through while online', async () => {
    const { inner, p, refused } = setup();
    await p.playList([track], 0);
    await p.play();
    await p.toggle();
    await p.next();
    await p.prev();
    await p.skipTo(1, 'b');
    expect(inner.playList).toHaveBeenCalledWith([track], 0);
    expect(inner.skipTo).toHaveBeenCalledWith(1, 'b');
    for (const c of [inner.play, inner.toggle, inner.next, inner.prev]) expect(c).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it('offline, refuses whatever would start playback, once per tap, and the player never hears of it', async () => {
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
});
