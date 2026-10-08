import { describe, expect, it } from 'vitest';
import { BROKEN_TEXT, blockedText, createBlockStore, minutesLeft } from './block';

function setup() {
  let clock = 1_000_000;
  const timers: { fn: () => void; at: number }[] = [];
  const store = createBlockStore({
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => timers.splice(timers.indexOf(t as never), 1),
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers.filter((x) => x.at <= clock)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { store, advance, now: () => clock, timers };
}

describe('block store', () => {
  it('shows a block until unblocked', () => {
    const { store, now } = setup();
    store.onBlocked({ until: now() + 5 * 60_000, reason: 'RATE_LIMIT' });
    expect(store.blocked.value).toEqual({ until: now() + 300_000, reason: 'RATE_LIMIT' });
    expect(store.banner.value).not.toBeNull();
    expect(store.degraded.value).toBe(true);
    store.onUnblocked();
    expect(store.blocked.value).toBeNull();
    expect(store.banner.value).toBeNull();
    expect(store.degraded.value).toBe(false);
  });

  it('clears by itself once `until` has passed (a missed unblocked event)', () => {
    const { store, now, advance } = setup();
    store.onBlocked({ until: now() + 60_000, reason: 'BOT_CHECK' });
    advance(59_000);
    expect(store.blocked.value).not.toBeNull();
    advance(1_000);
    expect(store.blocked.value).toBeNull();
  });

  it('ignores a block that is already over, and unknown reasons become BOT_CHECK', () => {
    const { store, now } = setup();
    store.onBlocked({ until: now() - 1, reason: 'BOT_CHECK' });
    expect(store.blocked.value).toBeNull();
    store.onBlocked({ until: now() + 1000, reason: 'WAT' as never });
    expect(store.blocked.value?.reason).toBe('BOT_CHECK');
    store.onBlocked(null);
    expect(store.blocked.value).toBeNull();
  });

  it('dismiss hides the banner until a new block (a later until)', () => {
    const { store, now } = setup();
    store.onBlocked({ until: now() + 120_000, reason: 'BOT_CHECK' });
    store.dismiss();
    expect(store.banner.value).toBeNull();
    expect(store.degraded.value).toBe(true);
    store.onBlocked({ until: now() + 120_000, reason: 'BOT_CHECK' });
    expect(store.banner.value).toBeNull();
    store.onBlocked({ until: now() + 900_000, reason: 'BOT_CHECK' });
    expect(store.banner.value?.until).toBe(now() + 900_000);
  });

  it('extractor broken: shown until dismissed, again on the next report', () => {
    const { store } = setup();
    expect(store.brokenBanner.value).toBe(false);
    store.onExtractorBroken({ message: 'ParsingException' });
    expect(store.broken.value).toBe('ParsingException');
    expect(store.brokenBanner.value).toBe(true);
    expect(store.degraded.value).toBe(true);
    store.dismissBroken();
    expect(store.brokenBanner.value).toBe(false);
    store.onExtractorBroken({});
    expect(store.broken.value).toBe('unknown');
    expect(store.brokenBanner.value).toBe(true);
  });

  it('counts down in whole minutes, never below 1', () => {
    expect(minutesLeft(10 * 60_000, 0)).toBe(10);
    expect(minutesLeft(9 * 60_000 + 1, 0)).toBe(10);
    expect(minutesLeft(30_000, 0)).toBe(1);
    expect(minutesLeft(0, 5)).toBe(1);
    expect(blockedText(15 * 60_000, 0)).toBe(
      'YouTube is limiting requests from your network. Try again in 15 min, or switch between Wi-Fi and mobile data.',
    );
    expect(BROKEN_TEXT).toBe('YouTube changed something. Update CyberJuke when a new version is out.');
  });
});
