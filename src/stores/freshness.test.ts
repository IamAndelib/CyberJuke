import { describe, expect, it, vi } from 'vitest';
import { RESUME_MIN_MS, createFreshness, type FreshnessDeps } from './freshness';

const MIN = 60_000;

/** Fake clock + timers so the schedule is observable. */
function harness(over: Partial<FreshnessDeps> & { every?: number | null } = {}) {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const state = { visible: true, every: over.every === undefined ? 15 : over.every, online: true };
  const newerThan = vi.fn(async (_since: string) => ({ count: 0, newest: null as string | null }));
  const onFound = vi.fn();
  const f = createFreshness({
    newerThan,
    fallbackBaseline: () => '2026-10-08T10:00:00Z',
    onFound,
    intervalMs: () => (state.every ? state.every * MIN : null),
    isVisible: () => state.visible,
    isOnline: () => state.online,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    ...over,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Advance the clock, firing due timers in order. */
  async function advance(ms: number) {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > end) break;
      timers.shift();
      t = due.at;
      due.fn();
      await flush();
      await flush();
    }
    t = end;
  }
  return { f, newerThan, onFound, state, timers, advance, flush };
}

describe('freshness timer per setting', () => {
  for (const every of [5, 15, 30, 60]) {
    it(`checks every ${every} min while in the foreground`, async () => {
      const h = harness({ every });
      h.f.start();
      expect(h.newerThan).not.toHaveBeenCalled(); // the feed was just loaded
      await h.advance(every * MIN - 1);
      expect(h.newerThan).toHaveBeenCalledTimes(0);
      await h.advance(1);
      expect(h.newerThan).toHaveBeenCalledTimes(1);
      await h.advance(every * MIN * 3);
      expect(h.newerThan).toHaveBeenCalledTimes(4);
    });
  }

  it('"Only when I refresh" never checks by itself, not even on resume', async () => {
    const h = harness({ every: null });
    h.f.start();
    await h.advance(24 * 60 * MIN);
    h.f.resume();
    await h.flush();
    expect(h.newerThan).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
  });

  it('stops in the background and checks on resume when due', async () => {
    const h = harness({ every: 15 });
    h.f.start();
    h.state.visible = false;
    h.f.pause();
    await h.advance(60 * MIN);
    expect(h.newerThan).not.toHaveBeenCalled();
    h.state.visible = true;
    h.f.resume();
    await h.flush();
    expect(h.newerThan).toHaveBeenCalledTimes(1);
    // A quick second resume doesn't check again.
    await h.advance(RESUME_MIN_MS - 1);
    h.f.resume();
    await h.flush();
    expect(h.newerThan).toHaveBeenCalledTimes(1);
  });

  it('follows a changed setting', async () => {
    const h = harness({ every: 60 });
    h.f.start();
    h.state.every = 5;
    h.f.reschedule();
    await h.advance(5 * MIN);
    expect(h.newerThan).toHaveBeenCalledTimes(1);
    h.state.every = null;
    h.f.reschedule();
    await h.advance(120 * MIN);
    expect(h.newerThan).toHaveBeenCalledTimes(1);
  });

  it('skips the request while offline', async () => {
    const h = harness();
    h.state.online = false;
    await h.f.check();
    expect(h.newerThan).not.toHaveBeenCalled();
  });
});

describe('freshness results', () => {
  it('asks for posts newer than the newest shown and shows the count', async () => {
    const h = harness();
    h.newerThan.mockResolvedValue({ count: 3, newest: '2026-10-08T12:00:00Z' });
    h.f.seen('2026-10-08T11:00:00Z');
    await h.f.check();
    expect(h.newerThan).toHaveBeenCalledWith('2026-10-08T11:00:00Z');
    expect(h.f.pending.value).toEqual({ count: 3, newest: '2026-10-08T12:00:00Z' });
    expect(h.onFound).toHaveBeenCalledTimes(1);
    // Same result again: no second catalog update.
    await h.f.check();
    expect(h.onFound).toHaveBeenCalledTimes(1);
  });

  it('uses the fallback baseline until the feed is seen', async () => {
    const h = harness();
    await h.f.check();
    expect(h.newerThan).toHaveBeenCalledWith('2026-10-08T10:00:00Z');
  });

  it('a newer Latest page (pull-to-refresh or the pill) clears the pill', async () => {
    const h = harness();
    h.newerThan.mockResolvedValue({ count: 25, newest: '2026-10-08T12:00:00Z' });
    await h.f.check();
    expect(h.f.pending.value?.count).toBe(25);
    h.f.seen('2026-10-08T11:59:00Z');
    expect(h.f.pending.value).not.toBeNull();
    h.f.seen('2026-10-08T12:00:00Z');
    expect(h.f.pending.value).toBeNull();
  });

  it('dismiss hides the pill; a failed check changes nothing', async () => {
    const h = harness();
    h.newerThan.mockResolvedValue({ count: 1, newest: '2026-10-08T12:00:00Z' });
    await h.f.check();
    h.f.dismiss();
    expect(h.f.pending.value).toBeNull();
    h.newerThan.mockRejectedValue(new Error('offline'));
    await h.f.check();
    expect(h.f.pending.value).toBeNull();
  });
});

describe('freshness reset (sign in or out)', () => {
  it('forgets the baseline and hides the pill', async () => {
    const h = harness();
    h.newerThan.mockResolvedValue({ count: 2, newest: '2026-10-08T12:00:00Z' });
    h.f.seen('2026-10-08T11:00:00Z');
    await h.f.check();
    expect(h.f.pending.value).not.toBeNull();
    h.f.reset();
    expect(h.f.pending.value).toBeNull();
    // Back on the fallback baseline until the next Latest page.
    h.newerThan.mockClear();
    await h.f.check();
    expect(h.newerThan).toHaveBeenCalledWith('2026-10-08T10:00:00Z');
  });

  it('a check still going at the reset (the other sign-in state) shows no pill', async () => {
    const h = harness();
    let answer: () => void = () => {};
    h.newerThan.mockImplementationOnce(() => new Promise((r) => (answer = () => r({ count: 3, newest: '2026-10-08T12:00:00Z' }))));
    const old = h.f.check();
    h.f.reset();
    // A check after the reset doesn't wait on the old one.
    h.newerThan.mockResolvedValueOnce({ count: 0, newest: null });
    await h.f.check();
    expect(h.newerThan).toHaveBeenCalledTimes(2);
    answer();
    await old;
    expect(h.f.pending.value).toBeNull();
    expect(h.onFound).not.toHaveBeenCalled();
  });
});
