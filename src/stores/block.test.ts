import { describe, expect, it } from 'vitest';
import { BROKEN_TEXT, MAX_TIMER_MS, blockedText, createBlockStore, minutesLeft, msToNextMinute, netStatusText } from './block';

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

  it('a timer that fires early (the clock went back, a very long block) waits again', () => {
    const { store, now, advance, timers } = setup();
    const until = now() + 2 * MAX_TIMER_MS;
    store.onBlocked({ until, reason: 'RATE_LIMIT' });
    expect(timers[0].at - now()).toBe(MAX_TIMER_MS);
    // Fires before `until`.
    timers.shift()!.fn();
    expect(store.blocked.value).not.toBeNull();
    expect(timers).toHaveLength(1);
    advance(until - now());
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

  it('the banner updates when the minute shown changes', () => {
    const until = 1_000_000 + 5 * 60_000 + 7_000;
    expect(msToNextMinute(until, 1_000_000)).toBe(7_000);
    expect(minutesLeft(until, 1_000_000 + 7_000 - 1)).toBe(6);
    expect(minutesLeft(until, 1_000_000 + 7_000)).toBe(5);
    expect(msToNextMinute(until, 1_000_000 + 7_000)).toBe(60_000);
    expect(msToNextMinute(until, until + 1)).toBe(60_000);
  });

  it('counts down in whole minutes, never below 1', () => {
    expect(minutesLeft(10 * 60_000, 0)).toBe(10);
    expect(minutesLeft(9 * 60_000 + 1, 0)).toBe(10);
    expect(minutesLeft(30_000, 0)).toBe(1);
    expect(minutesLeft(0, 5)).toBe(1);
    expect(blockedText(15 * 60_000, 0)).toBe(
      'YouTube is limiting requests from your network. Trying again in 15 min.',
    );
    expect(BROKEN_TEXT).toBe('YouTube changed something. Update CyberJuke when a new version is out.');
  });
});

describe('net status line', () => {
  const at = new Date(2026, 9, 9, 14, 2).getTime();
  const time = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  it('says how YouTube is reached and the last limit', () => {
    expect(netStatusText(null, at)).toBeNull();
    expect(netStatusText({ autoIpv4: false }, at)).toBe('Connection: not used yet · no limits so far');
    expect(netStatusText({ family: 'IPv6', autoIpv4: false }, at)).toBe('Connection: IPv6 · no limits so far');
    // Just switched: the last request was still IPv6, the next goes out on IPv4.
    expect(netStatusText({ family: 'IPv6', autoIpv4: true }, at)).toBe('Connection: IPv4 (switched by Auto) · no limits so far');
    expect(
      netStatusText({ family: 'IPv4', autoIpv4: true, lastLimit: { at, reason: 'BOT_CHECK', surface: 'playback' } }, at + 60_000),
    ).toBe(`Connection: IPv4 (switched by Auto) · last limit ${time}, bot check`);
    expect(netStatusText({ family: 'IPv4', autoIpv4: false, lastLimit: { at, reason: 'RATE_LIMIT', surface: 'music' } }, at)).toBe(
      `Connection: IPv4 · last limit ${time}, rate limit (music)`,
    );
  });

  it('dates a limit from another day', () => {
    const text = netStatusText({ family: 'IPv4', autoIpv4: false, lastLimit: { at, reason: 'WHATEVER', surface: 'playback' } }, at + 2 * 86_400_000)!;
    const day = new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    expect(text).toBe(`Connection: IPv4 · last limit ${day} ${time}, limit`);
  });
});
