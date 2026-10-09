import { describe, expect, it, vi } from 'vitest';
import { Cache, InFlight } from './cache';

describe('Cache', () => {
  it('serves an entry until its TTL, then nothing (kept unless dropStale)', () => {
    let now = 0;
    const c = new Cache<string, number>({ ttlMs: 100, now: () => now });
    c.set('a', 1);
    now = 99;
    expect(c.get('a')).toBe(1);
    now = 100;
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(1);
    const d = new Cache<string, number>({ ttlMs: 100, now: () => now, dropStale: true });
    d.set('a', 1, 0);
    expect(d.get('a')).toBeUndefined();
    expect(d.size).toBe(0);
  });

  it('takes a TTL per value; Infinity never expires', () => {
    let now = 0;
    const c = new Cache<string, { found: boolean }>({ ttlMs: (v) => (v.found ? Infinity : 10), now: () => now });
    c.set('yes', { found: true });
    c.set('no', { found: false });
    now = 1e12;
    expect(c.get('yes')).toEqual({ found: true });
    expect(c.get('no')).toBeUndefined();
  });

  it('drops the least recently written past max; get does not reorder, touch and set do', () => {
    const c = new Cache<string, number>({ max: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.pairs()).toEqual([['b', 2], ['c', 3]]);
    c.touch('b');
    c.set('d', 4);
    expect(c.pairs()).toEqual([['b', 2], ['d', 4]]);
    c.set('b', 5);
    expect(c.pairs()).toEqual([['d', 4], ['b', 5]]);
  });

  it('restores saved entries as they were, without evicting', () => {
    const c = new Cache<string, number>({ max: 1, ttlMs: 10, now: () => 5 });
    c.restore('a', 1, 0);
    c.restore('b', 2, 0);
    expect(c.pairs()).toEqual([['a', 1], ['b', 2]]);
    expect(c.get('a')).toBe(1);
    c.touch('a');
    expect(c.pairs()).toEqual([['a', 1]]);
  });

  it('dropOlderThan keeps recent entries only', () => {
    let now = 0;
    const c = new Cache<string, number>({ now: () => now });
    c.set('old', 1);
    now = 50;
    c.set('new', 2);
    now = 70;
    c.dropOlderThan(30);
    expect(c.pairs()).toEqual([['new', 2]]);
  });

  it('load shares a load in progress, stores what resolves, and not what fails', async () => {
    const c = new Cache<string, number>();
    const stored = vi.fn();
    let resolve!: (v: number) => void;
    const start = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const p1 = c.load('k', start, { stored });
    const p2 = c.load('k', start, { stored });
    expect(p2).toBe(p1);
    resolve(7);
    expect(await p1).toBe(7);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stored).toHaveBeenCalledWith(7);
    expect(await c.load('k', start)).toBe(7);
    expect(start).toHaveBeenCalledTimes(1);

    await expect(c.load('bad', () => Promise.reject(new Error('x')), { mapError: (e) => new Error('mapped ' + (e as Error).message) })).rejects.toThrow('mapped x');
    expect(c.get('bad')).toBeUndefined();
  });

  it('a start that throws synchronously rejects and is not shared', async () => {
    const c = new Cache<string, number>();
    const p = c.load('k', () => {
      throw new Error('none');
    });
    await expect(p).rejects.toThrow('none');
    expect(await c.load('k', async () => 1)).toBe(1);
  });
});

describe('Cache: loads still going when an entry is dropped', () => {
  it('a load started before clear() resolves but stores nothing, and a new load does not join it', async () => {
    const c = new Cache<string, string>();
    let finish: (v: string) => void = () => {};
    const stored = vi.fn();
    const old = c.load('k', () => new Promise<string>((r) => (finish = r)), { stored });
    c.clear();
    const fresh = c.load('k', async () => 'new');
    finish('old');
    expect(await old).toBe('old');
    expect(await fresh).toBe('new');
    expect(stored).not.toHaveBeenCalled();
    expect(c.get('k')).toBe('new');
  });

  it('delete() of one key drops its load the same way', async () => {
    const c = new Cache<string, string>();
    let finish: (v: string) => void = () => {};
    const old = c.load('k', () => new Promise<string>((r) => (finish = r)));
    const other = c.load('o', async () => 'o');
    c.delete('k');
    const start = vi.fn(async () => 'fresh');
    const fresh = c.load('k', start);
    expect(start).toHaveBeenCalled();
    finish('stale');
    await Promise.all([old, fresh, other]);
    expect(c.get('k')).toBe('fresh');
    expect(c.get('o')).toBe('o');
  });
});

describe('InFlight', () => {
  it('shares a promise until it settles', async () => {
    const f = new InFlight<string, number>();
    const p = f.track('a', Promise.resolve(1));
    expect(f.get('a')).toBe(p);
    await p;
    expect(f.get('a')).toBeUndefined();
  });
});
