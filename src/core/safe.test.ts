import { signal } from '@preact/signals';
import { describe, expect, it, vi } from 'vitest';
import { safe } from './safe';
import { COMMAND_ERRORS, safePlayer } from '../player/safePlayer';
import { EMPTY_STATE, type Player } from '../player/types';

describe('safe()', () => {
  it('returns the result, or undefined and a message on failure', async () => {
    const notify = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await safe('x', async () => 5, notify, 'nope')).toBe(5);
    expect(await safe('x', () => Promise.reject(new Error('boom')), notify, 'nope')).toBeUndefined();
    expect(await safe('x', () => {
      throw new Error('sync');
    }, notify, 'again')).toBeUndefined();
    expect(notify.mock.calls).toEqual([['nope'], ['again']]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(await safe('x', () => Promise.reject(1), () => {
      throw new Error('bad notifier');
    }, 'm')).toBeUndefined();
    warn.mockRestore();
  });
});

describe('safePlayer', () => {
  function fake(): Player {
    const fail = () => Promise.reject(new Error('native gone'));
    return {
      kind: 'native',
      state: signal({ ...EMPTY_STATE }),
      playList: vi.fn(fail),
      play: vi.fn(async () => {}),
      pause: vi.fn(fail),
      toggle: vi.fn(fail),
      next: vi.fn(fail),
      prev: vi.fn(fail),
      seek: vi.fn(fail),
      skipTo: vi.fn(fail),
      setShuffle: vi.fn(fail),
      setRepeat: vi.fn(fail),
      move: vi.fn(fail),
      remove: vi.fn(fail),
      removeIds: vi.fn(fail),
      addToQueue: vi.fn(fail),
      restore: vi.fn(fail),
      addAutoplay: vi.fn(fail),
      setAutoplay: vi.fn(fail),
      onQueueLow: () => () => {},
      setQuality: vi.fn(fail),
      setNetworkPrefs: vi.fn(fail),
      retryNow: vi.fn(fail),
      netStatus: vi.fn(fail),
    };
  }

  it('wraps every command: arguments pass through, failures become a toast, never a rejection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = fake();
    const toasts: string[] = [];
    const p = safePlayer(raw, (t) => toasts.push(t));
    expect(p.state).toBe(raw.state);
    await expect(p.play()).resolves.toBeUndefined();
    await expect(p.skipTo(3)).resolves.toBeUndefined();
    expect(raw.skipTo).toHaveBeenCalledWith(3);
    await p.move(1, 2, 'x');
    expect(raw.move).toHaveBeenCalledWith(1, 2, 'x');
    // Background clean-up (signing out) fails quietly.
    await p.removeIds(['m']);
    expect(toasts).toEqual([COMMAND_ERRORS.skipTo, COMMAND_ERRORS.move]);
    const commands = Object.keys(COMMAND_ERRORS) as (keyof typeof COMMAND_ERRORS)[];
    for (const c of commands) expect(typeof p[c]).toBe('function');
  });

  it('a failed status query is just no status: no toast', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const toasts: string[] = [];
    const p = safePlayer(fake(), (t) => toasts.push(t));
    await expect(p.netStatus()).resolves.toBeNull();
    expect(toasts).toEqual([]);
  });
});
