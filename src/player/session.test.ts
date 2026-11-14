import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../data/model';
import { offlineGuard } from './offlineGuard';
import { sessionStarts } from './session';
import { EMPTY_STATE, type Player, type PlayerState } from './types';

const t = (id: string): Track => ({ id, ytId: id.padEnd(11, '0') }) as Track;
const HOME = { label: 'Home · Latest', mode: 'radio' as const };

/** A Preferences double. */
const memoryKv = () => {
  const m = new Map<string, string>();
  return { m, get: vi.fn(async (k: string) => m.get(k) ?? null), set: async (k: string, v: string) => void m.set(k, v), remove: async (k: string) => void m.delete(k) };
};

/** A player whose lists start (a new context, as both players give each list) unless told not to; every other command does nothing. */
function setup(store = memoryKv(), clock = { now: 1000 }) {
  const state = signal<PlayerState>({ ...EMPTY_STATE });
  let starts = true;
  const cmd = () => vi.fn((..._a: unknown[]): Promise<void> => Promise.resolve());
  const inner = {
    kind: 'web',
    state,
    onQueueLow: () => () => {},
    netStatus: () => Promise.resolve(null),
    playList: vi.fn(async (tracks: Track[], i: number, ctx = { label: 'Queue', mode: 'list' as const }) => {
      if (starts) state.value = { ...state.value, queue: tracks, index: i, current: tracks[i], context: { ...ctx } };
    }),
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
  const s = sessionStarts(inner, store, () => clock.now);
  return { s, inner, store, clock, refuse: () => (starts = false) };
}

describe('sessionStarts', () => {
  it('a list that starts starts the session, when it was asked for; kept in Preferences', async () => {
    const { s, store, clock } = setup();
    expect(await s.since()).toBeNull();
    await s.player.playList([t('a')], 0, HOME);
    expect(await s.since()).toBe(1000);
    clock.now = 5000;
    // The same list again from its row is a new start too.
    await s.player.playList([t('a')], 0, HOME);
    expect(await s.since()).toBe(5000);
    expect(store.m.get('vibe.since')).toBe('5000');
  });

  it('a list counts as soon as it shows, before the player has answered: a refill asked meanwhile skips only what it heard', async () => {
    const { s, inner, clock } = setup();
    await s.player.playList([t('a')], 0, HOME);
    clock.now = 5000;
    let answer = () => {};
    inner.playList.mockImplementationOnce(async (tracks, i, ctx) => {
      inner.state.value = { ...inner.state.value, queue: tracks, index: i, current: tracks[i], context: { ...ctx! } };
      await new Promise<void>((r) => (answer = r));
    });
    const started = s.player.playList([t('b')], 0, HOME);
    expect(await s.since()).toBe(5000);
    answer();
    await started;
  });

  it('nothing else starts one: a batch or the next station arriving, Repeat, Shuffle, a tap in Up next, Next', async () => {
    const { s, clock } = setup();
    await s.player.playList([t('a')], 0, HOME);
    clock.now = 9000;
    await s.player.addAutoplay([t('b')], 'a');
    await s.player.setRepeat('all');
    await s.player.setShuffle(true);
    await s.player.skipTo(0, 'a');
    await s.player.next();
    expect(await s.since()).toBe(1000);
  });

  it("a list that doesn't start (nothing in it plays, or the player failed) changes nothing", async () => {
    const { s, clock, refuse } = setup();
    await s.player.playList([t('a')], 0, HOME);
    refuse();
    clock.now = 9000;
    await s.player.playList([t('b')], 0, HOME);
    expect(await s.since()).toBe(1000);
  });

  it('a restart goes on with the stored session; a list started while it is read wins', async () => {
    const store = memoryKv();
    store.m.set('vibe.since', '4000');
    expect(await setup(store).s.since()).toBe(4000);
    let open = () => {};
    store.get.mockImplementationOnce(() => new Promise((r) => (open = () => r('4000'))));
    const { s } = setup(store, { now: 7000 });
    const read = s.since();
    await s.player.playList([t('a')], 0, HOME);
    open();
    expect(await read).toBe(7000);
    store.m.set('vibe.since', 'junk');
    expect(await setup(store).s.since()).toBeNull();
  });

  it('under the offline guard (as the app wires it): a tap refused offline changes nothing; Add to queue with nothing loaded starts one', async () => {
    const { s, clock } = setup();
    let up = false;
    const p = offlineGuard(s.player, { online: () => up, saved: () => new Set(), liked: () => false, refuse: () => {} });
    await p.playList([t('a')], 0, HOME);
    expect(await s.since()).toBeNull();
    up = true;
    clock.now = 3000;
    await p.addToQueue([t('b')]);
    expect(await s.since()).toBe(3000);
  });
});
